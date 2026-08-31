import type { ServerConfig } from "../config.js";
import { AUTH_METHOD } from "../deribit/client.js";
import { ACCOUNT_TOOLS } from "./account.js";
import { MARKET_ANALYTICS_TOOLS } from "./market-analytics.js";
import { MARKET_HISTORY_TOOLS } from "./market-history.js";
import { MARKET_INSTRUMENT_TOOLS } from "./market-instruments.js";
import { TRADING_READ_TOOLS } from "./trading-read.js";
import { TRADING_WRITE_TOOLS } from "./trading-write.js";
import type { ToolModule } from "./types.js";

export const ALL_TOOLS: readonly ToolModule[] = [
	...MARKET_INSTRUMENT_TOOLS,
	...MARKET_ANALYTICS_TOOLS,
	...MARKET_HISTORY_TOOLS,
	...ACCOUNT_TOOLS,
	...TRADING_READ_TOOLS,
	...TRADING_WRITE_TOOLS,
];

/**
 * Every Deribit RPC method that can be called, for check-api-drift and the docs
 * generator. Besides the methods each tool declares, it includes the
 * authentication method the client itself uses.
 */
export const ALL_DERIBIT_METHODS: readonly string[] = [
	...new Set([AUTH_METHOD, ...ALL_TOOLS.flatMap((tool) => tool.methods)]),
].sort();

/**
 * Pick which tools to register based on the runtime configuration.
 *
 * - No credentials -> public market data tools only; the private tools do not even
 *   appear in tools/list, so the model cannot keep calling them and keep collecting
 *   authentication errors.
 * - DERIBIT_ENABLE_TRADING not set -> the write tools are likewise not registered.
 *   This is the main gate against accidental orders.
 */
export function selectTools(config: ServerConfig): ToolModule[] {
	return ALL_TOOLS.filter((tool) => {
		if (tool.group === "public") return true;
		if (!config.credentials) return false;
		if (tool.group === "private-write") return config.enableTrading;
		return true;
	});
}

export type { ToolGroup, ToolModule } from "./types.js";
