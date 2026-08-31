#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { DeribitClient } from "./deribit/client.js";
import { selectTools } from "./tools/index.js";
import {
	DERIBIT_API_RELEASE,
	DERIBIT_API_VERSION,
	SERVER_NAME,
	SERVER_VERSION,
} from "./version.js";

/**
 * Over the stdio transport, stdout must be a pure JSON-RPC stream: one extra line
 * makes the client fail to parse it. So every human-facing message in this process
 * goes to stderr.
 */
function log(message: string): void {
	process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
}

function buildInstructions(config: ServerConfig, toolCount: number): string {
	const lines = [
		`Deribit JSON-RPC ${DERIBIT_API_VERSION} toolset, aligned to the official changelog release ${DERIBIT_API_RELEASE}.`,
		`Current environment: ${config.envLabel}${config.isMainnet ? " (real funds)" : " (testnet, funds are not real)"}.`,
		"Every timestamp argument and return value is a UNIX timestamp in milliseconds. Use upper case for currency (BTC/ETH/USDC) and lower case for index_name (btc_usd).",
	];
	if (!config.credentials) {
		lines.push(
			"No API credentials are configured, so only the public market data tools are available. Set DERIBIT_CLIENT_ID and DERIBIT_CLIENT_SECRET to get the account and trading tools.",
		);
	} else if (!config.enableTrading) {
		lines.push(
			"Trading writes are disabled (DERIBIT_ENABLE_TRADING=true is not set): the place/edit/cancel/close tools are unavailable, queries only.",
		);
	} else {
		lines.push(
			config.isMainnet
				? "⚠️ Trading writes are enabled and pointed at mainnet: deribit_place_order / deribit_edit_order / deribit_cancel_order / deribit_close_position produce real fills. Always confirm with the user before executing them."
				: "Trading writes are enabled against testnet, so orders involve no real funds.",
		);
	}
	lines.push(`${toolCount} tools are registered in this session.`);
	return lines.join("\n");
}

async function main(): Promise<void> {
	const config = loadConfig();
	const client = new DeribitClient(config);
	const tools = selectTools(config);

	const server = new McpServer(
		{ name: SERVER_NAME, version: SERVER_VERSION },
		{
			capabilities: { tools: {} },
			instructions: buildInstructions(config, tools.length),
		},
	);

	for (const tool of tools) {
		server.registerTool(
			tool.name,
			{
				title: tool.title,
				description: tool.description,
				inputSchema: tool.inputSchema,
				annotations: tool.annotations,
			},
			async (args: unknown) => {
				// ToolModule is a type-erased collection: the real type of args is decided
				// by each tool's own Zod schema, and the SDK has already validated against
				// that schema before we get here.
				const payload = await tool.handler(client, args as never);
				// We declare no outputSchema and return no structuredContent: Deribit
				// responses such as an option chain are already large, and attaching a
				// structured copy would double the payload.
				return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
			},
		);
	}

	// The startup banner goes to stderr, which clients usually surface in their MCP
	// log. Mainnet plus trading enabled is the most dangerous combination, so the
	// environment has to be visible at a glance.
	log(`v${SERVER_VERSION} (Deribit API ${DERIBIT_API_VERSION}, docs ${DERIBIT_API_RELEASE})`);
	log(`endpoint: ${config.rpcBase}  [${config.isMainnet ? "MAINNET — real funds" : "testnet"}]`);
	log(
		`credentials: ${config.credentials ? "configured" : "absent (public tools only)"}  ` +
			`trading: ${config.enableTrading ? "ENABLED" : "disabled"}`,
	);
	log(`tools registered: ${tools.length}`);

	await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
	log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
