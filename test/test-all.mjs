#!/usr/bin/env node
/** Full testnet MCP integration suite. Run: npm run test:all */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const file = resolve(".env.test");
const btc = "BTC-PERPETUAL";
const label = `deribit-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const now = Date.now();
const dayAgo = now - 86_400_000;
const monthAgo = now - 2_592_000_000;
let failures = 0;
let limited = 0;

function check(name, condition, detail = "") {
	if (!condition) failures += 1;
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	return Boolean(condition);
}
function text(result) { return (result.content ?? []).map((part) => part.text ?? "").join(""); }
function error(result) { return text(result).replace(/\s+/g, " "); }
function parseEnv(path) {
	let source;
	try { source = readFileSync(path, "utf8"); } catch (cause) { throw new Error(`Cannot read ${path}: ${cause instanceof Error ? cause.message : String(cause)}`); }
	const env = {};
	for (const [index, raw] of source.split(/\r?\n/).entries()) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
		if (!match) throw new Error(`${path}:${index + 1} is not a valid KEY=value entry`);
		let [, key, value] = match;
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
		env[key] = value;
	}
	for (const key of ["DERIBIT_CLIENT_ID", "DERIBIT_CLIENT_SECRET"]) if (!env[key]?.trim()) throw new Error(`${path} must define ${key}`);
	return env;
}
async function connect(env) {
	const client = new Client({ name: "deribit-mcp-test-all", version: "0.0.0" });
	const transport = new StdioClientTransport({
		command: process.execPath, args: ["dist/index.js"], stderr: "pipe",
		// Never inherit a caller's production/custom endpoint or trading flag.
		env: { PATH: process.env.PATH, DERIBIT_ENV: "test", DERIBIT_ENABLE_TRADING: "true", DERIBIT_CLIENT_ID: env.DERIBIT_CLIENT_ID, DERIBIT_CLIENT_SECRET: env.DERIBIT_CLIENT_SECRET },
	});
	await client.connect(transport);
	return { client, transport };
}
async function call(client, name, args, optional = false) {
	const result = await client.callTool({ name, arguments: args });
	if (result.isError === true) {
		const detail = error(result);
		if (optional && /portfolio margin|not enabled|not available|not supported|access denied|permission denied|feature/i.test(detail)) {
			limited += 1; console.log(`LIMIT ${name} — ${detail.slice(0, 240)}`); return null;
		}
		check(name, false, detail.slice(0, 240)); return null;
	}
	try { const payload = JSON.parse(text(result)); check(name, true); return payload; }
	catch { check(`${name} returns JSON text`, false, text(result).slice(0, 240)); return null; }
}
function orderId(payload) {
	return [payload?.result?.order?.order_id, payload?.result?.order_id, payload?.order?.order_id, payload?.order_id]
		.find((value) => typeof value === "string" && value.length > 0);
}

async function main() {
	const env = parseEnv(file);
	console.log(`Using ${file}; endpoint forced to Deribit testnet.`);
	const { client, transport } = await connect(env);
	let positionOpened = false;
	try {
		const server = client.getServerVersion();
		check("serverInfo.name", server?.name === "deribit-mcp", server?.name);
		check("serverInfo.version", /^2\.\d{8}\.\d+$/.test(server?.version ?? ""), server?.version);
		const { tools } = await client.listTools();
		const names = new Set(tools.map((tool) => tool.name));
		check("all 39 MCP tools are registered", tools.length === 39, String(tools.length));
		check("all tools expose object input schemas", tools.every((tool) => tool.inputSchema?.type === "object"));
		check("all tools declare readOnlyHint", tools.every((tool) => typeof tool.annotations?.readOnlyHint === "boolean"));
		for (const name of ["deribit_place_order", "deribit_edit_order", "deribit_cancel_order", "deribit_close_position", "deribit_create_combo"]) check(`${name} is registered`, names.has(name));

		const quote = await call(client, "deribit_get_market_quote", { instrument_name: btc, depth: 5 });
		const mark = quote?.ticker?.mark_price ?? quote?.ticker?.last_price;
		check("BTC perpetual has a usable market price", typeof mark === "number" && mark > 0, String(mark));
		const instrument = await call(client, "deribit_get_instruments_info", { instrument_name: btc });
		const instrumentId = instrument?.instrument?.instrument_id;
		check("BTC perpetual resolves to instrument_id", Number.isInteger(instrumentId), String(instrumentId));
		const publicCalls = [
			["deribit_get_instruments_info", { currency: "BTC", kind: "future" }], ["deribit_get_expirations", { currency: "BTC", kind: "option" }], ["deribit_get_option_chain", { currency: "BTC", kind: "option" }], ["deribit_get_market_quote", { instrument_id: instrumentId, depth: 5 }],
			["deribit_get_historical_candles", { instrument_name: btc, resolution: "60", start_timestamp: dayAgo, end_timestamp: now }], ["deribit_get_mark_price_history", { instrument_name: btc, start_timestamp: dayAgo, end_timestamp: now }], ["deribit_get_index_price", { index_name: "btc_usd", range: "1d" }], ["deribit_get_historical_volatility", { currency: "BTC" }],
			["deribit_get_volatility_index", { currency: "BTC", start_timestamp: monthAgo, end_timestamp: now, resolution: "43200" }], ["deribit_get_funding", { instrument_name: btc, start_timestamp: dayAgo, end_timestamp: now, length: "8h" }], ["deribit_get_public_trades", { instrument_name: btc, count: 3 }], ["deribit_get_trade_volumes", { extended: true }], ["deribit_get_apr_history", { currency: "usdc", limit: 5 }],
			["deribit_get_delivery_prices", { index_name: "btc_usd", count: 3 }], ["deribit_get_public_settlements", { currency: "BTC", type: "settlement", count: 3 }], ["deribit_get_combos", { currency: "BTC", ids_only: true }], ["deribit_get_announcements", { count: 3 }], ["deribit_get_status", {}],
		];
		for (const [name, args] of publicCalls) await call(client, name, args);
		if (typeof mark !== "number" || mark <= 0) throw new Error("Cannot safely create a test order without a BTC perpetual market price");

		const passive = await call(client, "deribit_place_order", { instrument_name: btc, side: "buy", amount: 10, type: "limit", price: Math.max(1, Math.floor(mark * 0.1)), label, post_only: true });
		const passiveId = orderId(passive);
		check("passive test order has order_id", Boolean(passiveId));
		if (passiveId) {
			await call(client, "deribit_get_active_orders", { instrument_name: btc });
			await call(client, "deribit_get_order_state", { order_id: passiveId });
			await call(client, "deribit_get_order_state_by_label", { currency: "BTC", label });
			await call(client, "deribit_edit_order", { order_id: passiveId, amount: 10, price: Math.max(1, Math.floor(mark * 0.1) - 1) });
			await call(client, "deribit_cancel_order", { order_id: passiveId });
		}
		const market = await call(client, "deribit_place_order", { instrument_name: btc, side: "buy", amount: 10, type: "market", label: `${label}-market` });
		const marketId = orderId(market);
		positionOpened = Boolean(marketId);
		check("market test order has order_id", positionOpened);
		const privateCalls = [
			["deribit_get_account_status", { currency: "BTC", kind: "future" }], ["deribit_get_account_summaries", {}], ["deribit_get_subaccounts", { currency: "BTC", with_portfolio: true, with_open_orders: true }, true], ["deribit_simulate_portfolio", { currency: "BTC", simulated_positions: { [btc]: 10 }, add_positions: false }, true], ["deribit_get_position", { instrument_name: btc }],
			["deribit_get_transaction_log", { currency: "BTC", start_timestamp: dayAgo, end_timestamp: now, count: 10 }], ["deribit_get_settlement_history", { currency: "BTC", count: 10 }], ["deribit_get_wallet_history", { currency: "BTC", count: 10 }], ["deribit_get_active_orders", { currency: "BTC", kind: "future" }], ["deribit_get_order_history", { currency: "BTC", kind: "future", count: 10 }], ["deribit_get_trigger_order_history", { currency: "BTC", count: 10 }], ["deribit_get_trade_history", { instrument_name: btc, start_timestamp: dayAgo, end_timestamp: now, count: 10 }], ["deribit_get_margins", { instrument_name: btc, amount: 10, price: mark }],
		];
		for (const [name, args, optional] of privateCalls) await call(client, name, args, optional);
		if (marketId) await call(client, "deribit_get_order_trades", { order_id: marketId }); else check("deribit_get_order_trades has a test order", false);
		if (positionOpened) { const result = await call(client, "deribit_close_position", { instrument_name: btc, type: "market" }); check("close_position returned a result", result !== null); if (result !== null) positionOpened = false; }
		const chain = await call(client, "deribit_get_option_chain", { currency: "BTC", kind: "option" });
		const strategies = new Map();
		for (const instrumentName of (Array.isArray(chain?.summaries) ? chain.summaries : []).map((item) => item?.instrument_name)) {
			if (typeof instrumentName !== "string") continue;
			const match = instrumentName.match(/^BTC-([0-9A-Z]+)-(\d+)-([CP])/);
			if (!match) continue;
			const key = `${match[1]}-${match[3]}`;
			strategies.set(key, [...(strategies.get(key) ?? []), { instrumentName, strike: Number(match[2]) }]);
		}
		const legs = [...strategies.values()].find((group) => group.length >= 2)?.sort((a, b) => a.strike - b.strike).slice(0, 2) ?? [];
		check("resolved a same-expiry option vertical for combo", legs.length === 2);
		if (legs.length === 2) await call(client, "deribit_create_combo", { trades: [{ instrument_name: legs[0].instrumentName, amount: 1, direction: "buy" }, { instrument_name: legs[1].instrumentName, amount: 1, direction: "sell" }] });
	} finally {
		try {
			const result = await client.callTool({ name: "deribit_cancel_order", arguments: { label, currency: "BTC" } });
			check("cleanup: cancel orders by test label", result.isError !== true, error(result).slice(0, 240));
			if (positionOpened) { const result = await client.callTool({ name: "deribit_close_position", arguments: { instrument_name: btc, type: "market" } }); check("cleanup: close test position", result.isError !== true, error(result).slice(0, 240)); }
		} finally { await client.close(); await transport.close(); }
	}
	console.log(`\n${failures ? `${failures} check(s) failed.` : "All full-test checks passed."}`);
	if (limited) console.log(`${limited} tool(s) were called but limited by optional account capabilities.`);
	process.exit(failures ? 1 : 0);
}
main().catch((cause) => { console.error(cause instanceof Error ? cause.message : String(cause)); process.exit(1); });
