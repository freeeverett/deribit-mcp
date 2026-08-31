#!/usr/bin/env node
/**
 * Smoke test: launch dist/index.js over stdio with a real MCP client and run the
 * handshake, tools/list and a handful of read-only tool calls. It targets testnet
 * by default and needs no credentials.
 *
 *   node test/smoke.mjs
 *
 * A non-zero exit code means at least one assertion failed.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

let failures = 0;

function check(label, condition, detail = "") {
	const ok = Boolean(condition);
	if (!ok) failures += 1;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

async function connect(env) {
	const client = new Client({ name: "deribit-mcp-smoke", version: "0.0.0" });
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: ["dist/index.js"],
		env: { PATH: process.env.PATH, ...env },
		stderr: "pipe",
	});
	await client.connect(transport);
	return { client, transport };
}

function textOf(result) {
	return (result.content ?? []).map((part) => part.text ?? "").join("");
}

async function main() {
	console.log(`SDK LATEST_PROTOCOL_VERSION = ${LATEST_PROTOCOL_VERSION}`);

	// ---- 1. Default configuration: testnet, public tools only ----
	{
		const { client, transport } = await connect({});
		const negotiated = client.getServerVersion();
		check("serverInfo.name", negotiated?.name === "deribit-mcp", negotiated?.name);
		check(
			"serverInfo.version",
			/^2\.\d{8}\.\d+$/.test(negotiated?.version ?? ""),
			negotiated?.version,
		);

		const { tools } = await client.listTools();
		const names = tools.map((t) => t.name);
		check("public-only tool count == 18", tools.length === 18, String(tools.length));
		check("no private tools without creds", !names.includes("deribit_get_account_status"));
		check("no write tools without creds", !names.includes("deribit_place_order"));
		check(
			"every tool has an inputSchema object",
			tools.every((t) => t.inputSchema?.type === "object"),
		);
		check(
			"every tool declares annotations",
			tools.every((t) => typeof t.annotations?.readOnlyHint === "boolean"),
		);

		// ---- 2. Real public read-only calls (against testnet) ----
		const status = await client.callTool({ name: "deribit_get_status", arguments: {} });
		check("get_status not an error", status.isError !== true, textOf(status).slice(0, 160));
		const statusJson = JSON.parse(textOf(status));
		check("get_status returns serverTime", typeof statusJson.serverTime === "number");

		const info = await client.callTool({
			name: "deribit_get_instruments_info",
			arguments: {},
		});
		check("instruments_info not an error", info.isError !== true, textOf(info).slice(0, 160));
		const infoJson = JSON.parse(textOf(info));
		check(
			"instruments_info returns currencies",
			Array.isArray(infoJson.currencies) && infoJson.currencies.length > 0,
		);

		const quote = await client.callTool({
			name: "deribit_get_market_quote",
			arguments: { instrument_name: "BTC-PERPETUAL", depth: 5 },
		});
		check("market_quote not an error", quote.isError !== true, textOf(quote).slice(0, 160));
		const quoteJson = JSON.parse(textOf(quote));
		check("market_quote returns ticker", quoteJson.ticker !== null);
		check("market_quote returns orderBook", quoteJson.orderBook !== null);

		// ---- 2b. Exercise every major argument branch of the public tools against testnet ----
		// This covers the currency/instrument either-or, time window vs sequence
		// pagination, the by-id variants and the other routing branches, so a regression
		// in how a handler assembles its params shows up immediately.
		const now = Date.now();
		const dayAgo = now - 24 * 3600 * 1000;
		const monthAgo = now - 30 * 24 * 3600 * 1000;
		const instrumentId = JSON.parse(
			textOf(
				await client.callTool({
					name: "deribit_get_instruments_info",
					arguments: { instrument_name: "BTC-PERPETUAL" },
				}),
			),
		).instrument?.instrument_id;
		check("resolved a real instrument_id", typeof instrumentId === "number", String(instrumentId));

		const sweep = [
			["deribit_get_instruments_info", { currency: "btc", kind: "future" }],
			["deribit_get_expirations", { currency: "BTC", kind: "option" }],
			["deribit_get_expirations", { currency: "any", kind: "any" }],
			["deribit_get_option_chain", { currency: "btc", kind: "future" }],
			["deribit_get_option_chain", { instrument_name: "BTC-PERPETUAL" }],
			["deribit_get_market_quote", { instrument_id: instrumentId, depth: 5 }],
			["deribit_get_historical_candles", { instrument_name: "BTC-PERPETUAL", resolution: "60", start_timestamp: dayAgo, end_timestamp: now }],
			["deribit_get_historical_candles", { instrument_name: "BTC-PERPETUAL", resolution: "1D", start_timestamp: monthAgo, end_timestamp: now }],
			["deribit_get_mark_price_history", { instrument_name: "BTC-PERPETUAL", start_timestamp: dayAgo, end_timestamp: now }],
			["deribit_get_index_price", {}],
			["deribit_get_index_price", { index_name: "BTC_USD", range: "1d" }],
			["deribit_get_historical_volatility", { currency: "btc" }],
			["deribit_get_volatility_index", { currency: "BTC", start_timestamp: monthAgo, end_timestamp: now, resolution: "43200" }],
			["deribit_get_funding", { instrument_name: "BTC-PERPETUAL", start_timestamp: dayAgo, end_timestamp: now, length: "8h" }],
			["deribit_get_public_trades", { instrument_name: "BTC-PERPETUAL", count: 3 }],
			["deribit_get_public_trades", { currency: "BTC", kind: "future", start_timestamp: dayAgo, end_timestamp: now, count: 3 }],
			["deribit_get_public_trades", { instrument_name: "BTC-PERPETUAL", start_seq: 1, count: 2 }],
			["deribit_get_trade_volumes", { extended: true }],
			["deribit_get_apr_history", { currency: "usdc", limit: 5 }],
			["deribit_get_delivery_prices", { index_name: "BTC_USD", count: 3 }],
			["deribit_get_public_settlements", { currency: "BTC", type: "settlement", count: 3 }],
			["deribit_get_public_settlements", { instrument_name: "BTC-PERPETUAL", count: 2 }],
			["deribit_get_combos", { currency: "BTC", ids_only: true }],
			["deribit_get_combos", { currency: "BTC" }],
			["deribit_get_announcements", { count: 3 }],
		];
		let sweepFailures = 0;
		for (const [name, args] of sweep) {
			const result = await client.callTool({ name, arguments: args });
			if (result.isError === true) {
				sweepFailures += 1;
				console.log(`      ${name} ${JSON.stringify(args)} -> ${textOf(result).slice(0, 200)}`);
			}
		}
		check(
			`public tool sweep (${sweep.length} calls against testnet)`,
			sweepFailures === 0,
			`${sweep.length - sweepFailures}/${sweep.length} ok`,
		);

		// ---- 3. Error path regression: Deribit's business errors must surface verbatim ----
		const bad = await client.callTool({
			name: "deribit_get_market_quote",
			arguments: { instrument_name: "NOPE-XXX" },
		});
		const badText = textOf(bad);
		check("bad instrument -> isError", bad.isError === true, badText.slice(0, 160));
		check(
			"bad instrument -> surfaces Deribit's own reason",
			/wrong format|instrument_name|not_found/i.test(badText),
			badText.slice(0, 200),
		);
		check(
			"bad instrument -> NOT swallowed by an id-mismatch error",
			!/id mismatch|id did not match/i.test(badText),
			badText.slice(0, 200),
		);

		// ---- 4. Cross-field constraints must also reach the model as isError ----
		const both = await client.callTool({
			name: "deribit_get_option_chain",
			arguments: { currency: "BTC", instrument_name: "BTC-PERPETUAL" },
		});
		check("exactly-one violation -> isError", both.isError === true, textOf(both).slice(0, 160));
		check(
			"exactly-one violation message is actionable",
			/exactly one of currency or instrument_name/i.test(textOf(both)),
		);

		await client.close();
		await transport.close();
	}

	// ---- 5. The gate: write tools appear only with credentials plus trading enabled ----
	{
		const { client, transport } = await connect({
			DERIBIT_CLIENT_ID: "smoke-not-a-real-key",
			DERIBIT_CLIENT_SECRET: "smoke-not-a-real-secret",
		});
		const names = (await client.listTools()).tools.map((t) => t.name);
		check("with creds: private read tools appear", names.includes("deribit_get_account_status"));
		check("with creds but no flag: write tools hidden", !names.includes("deribit_place_order"));
		await client.close();
		await transport.close();
	}
	{
		const { client, transport } = await connect({
			DERIBIT_CLIENT_ID: "smoke-not-a-real-key",
			DERIBIT_CLIENT_SECRET: "smoke-not-a-real-secret",
			DERIBIT_ENABLE_TRADING: "true",
		});
		const { tools } = await client.listTools();
		const names = tools.map((t) => t.name);
		check("trading enabled: all 39 tools", tools.length === 39, String(tools.length));
		check("trading enabled: place_order appears", names.includes("deribit_place_order"));
		const placeOrder = tools.find((t) => t.name === "deribit_place_order");
		check("place_order is not marked readOnly", placeOrder?.annotations?.readOnlyHint === false);
		const cancel = tools.find((t) => t.name === "deribit_cancel_order");
		check("cancel_order is marked destructive", cancel?.annotations?.destructiveHint === true);

		// A private call with fake credentials must surface Deribit's real reason rather
		// than a generic failure
		const denied = await client.callTool({
			name: "deribit_get_account_summaries",
			arguments: {},
		});
		const deniedText = textOf(denied);
		check("bad creds -> isError", denied.isError === true, deniedText.slice(0, 160));
		check(
			"bad creds -> surfaces invalid_credentials",
			/invalid_credentials|13004/.test(deniedText),
			deniedText.slice(0, 200),
		);
		await client.close();
		await transport.close();
	}

	console.log(failures === 0 ? "\nAll smoke checks passed." : `\n${failures} check(s) failed.`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
