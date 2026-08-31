import { z } from "zod";
import {
	DVOL_RESOLUTIONS,
	FUNDING_CHART_LENGTHS,
	INDEX_CHART_RANGES,
	SUPPORTED_INDEX_TYPES,
	TRADE_KINDS,
} from "../deribit/constants.js";
import { InvalidParamsError } from "../errors.js";
import * as S from "../schemas.js";
import { defineTool, type ToolModule } from "./types.js";

export const MARKET_ANALYTICS_TOOLS: ToolModule[] = [
	defineTool({
		name: "deribit_get_mark_price_history",
		title: "Deribit Mark Price History",
		group: "public",
		methods: ["public/get_mark_price_history"],
		description:
			"Historical mark price series for one instrument, returned as [timestamp, mark price] pairs. Timestamps are in milliseconds. Note that Deribit only keeps mark price history for the options that feed the volatility index: futures and perpetuals return an empty array, and an empty result is normal rather than a failure.",
		inputSchema: z.strictObject({
			instrument_name: S.instrumentName,
			start_timestamp: S.msTimestamp,
			end_timestamp: z.number().int().min(1).describe("UNIX timestamp in milliseconds"),
		}),
		handler: async (client, args) => {
			if (args.end_timestamp <= args.start_timestamp) {
				throw new InvalidParamsError("end_timestamp must be greater than start_timestamp");
			}
			const markPriceHistory = await client.publicCall("public/get_mark_price_history", {
				instrument_name: args.instrument_name,
				start_timestamp: args.start_timestamp,
				end_timestamp: args.end_timestamp,
			});
			return {
				exchange: "deribit",
				instrumentName: args.instrument_name,
				startTimestamp: args.start_timestamp,
				endTimestamp: args.end_timestamp,
				markPriceHistory,
			};
		},
	}),

	defineTool({
		name: "deribit_get_index_price",
		title: "Deribit Index Price",
		group: "public",
		methods: [
			"public/get_index_price",
			"public/get_index_chart_data",
			"public/get_index_price_names",
			"public/get_supported_index_names",
		],
		description:
			"Current price of an index; with range it also returns the index price history over that window; with index_name omitted it returns the available index names.",
		inputSchema: z.strictObject({
			index_name: S.indexName.optional(),
			range: z
				.enum(INDEX_CHART_RANGES)
				.describe("Index price history window; only applies when index_name is given")
				.optional(),
			type: z
				.enum(SUPPORTED_INDEX_TYPES)
				.describe("Filters supportedIndexNames; only applies when index_name is omitted")
				.optional(),
		}),
		handler: async (client, args) => {
			const indexName = S.low(args.index_name);
			const range = args.range;

			if (!indexName) {
				const [indexNames, supportedIndexNames] = await Promise.all([
					client.publicCall("public/get_index_price_names", {}),
					client.publicCall(
						"public/get_supported_index_names",
						S.compact({ type: args.type }),
					),
				]);
				return {
					exchange: "deribit",
					indexName: "",
					range: "",
					indexNames,
					supportedIndexNames,
					indexPrice: null,
					chartData: null,
					note: "No index_name was given, so only the available index names are returned; indexNames are the indexes whose price can be queried, supportedIndexNames are all supported indexes.",
				};
			}

			const [indexPrice, chartData] = await Promise.all([
				client.publicCall("public/get_index_price", { index_name: indexName }),
				range
					? client.publicCall("public/get_index_chart_data", {
							index_name: indexName,
							range,
						})
					: Promise.resolve(null),
			]);
			return {
				exchange: "deribit",
				indexName,
				range: range ?? "",
				indexNames: [],
				supportedIndexNames: [],
				indexPrice,
				chartData,
				note: range
					? ""
					: "No range was given, so only the current index price is returned; pass range to also fetch the historical series.",
			};
		},
	}),

	defineTool({
		name: "deribit_get_historical_volatility",
		title: "Deribit Historical Volatility",
		group: "public",
		methods: ["public/get_historical_volatility"],
		description:
			"Historical realised volatility series for one currency, as an annualised percentage.",
		inputSchema: z.strictObject({ currency: S.currency }),
		handler: async (client, args) => {
			const currency = args.currency.toUpperCase();
			const volatility = await client.publicCall("public/get_historical_volatility", {
				currency,
			});
			return { exchange: "deribit", currency, volatility };
		},
	}),

	defineTool({
		name: "deribit_get_volatility_index",
		title: "Deribit Volatility Index (DVOL)",
		group: "public",
		methods: ["public/get_volatility_index_data"],
		description: "OHLC data for the DVOL volatility index. Timestamps are in milliseconds.",
		inputSchema: z.strictObject({
			currency: S.currency,
			start_timestamp: S.msTimestamp,
			end_timestamp: z.number().int().min(1).describe("UNIX timestamp in milliseconds"),
			resolution: z.enum(DVOL_RESOLUTIONS).describe("Seconds, or 1D for daily"),
		}),
		handler: async (client, args) => {
			if (args.end_timestamp <= args.start_timestamp) {
				throw new InvalidParamsError("end_timestamp must be greater than start_timestamp");
			}
			const currency = args.currency.toUpperCase();
			const data = await client.publicCall("public/get_volatility_index_data", {
				currency,
				start_timestamp: args.start_timestamp,
				end_timestamp: args.end_timestamp,
				resolution: args.resolution,
			});
			return {
				exchange: "deribit",
				currency,
				startTimestamp: args.start_timestamp,
				endTimestamp: args.end_timestamp,
				resolution: args.resolution,
				data,
			};
		},
	}),

	defineTool({
		name: "deribit_get_funding",
		title: "Deribit Perpetual Funding",
		group: "public",
		methods: [
			"public/get_funding_rate_value",
			"public/get_funding_rate_history",
			"public/get_funding_chart_data",
		],
		description:
			"Cumulative funding rate and funding rate history for a perpetual over a time range; with length it also returns funding chart data for that length. Timestamps are in milliseconds.",
		inputSchema: z.strictObject({
			instrument_name: z.string().min(1).describe("Perpetual instrument name, e.g. BTC-PERPETUAL"),
			start_timestamp: S.msTimestamp,
			end_timestamp: z.number().int().min(1).describe("UNIX timestamp in milliseconds"),
			length: z
				.enum(FUNDING_CHART_LENGTHS)
				.describe(
					"Funding chart length. That endpoint returns the most recent data for a fixed length and ignores the time range above",
				)
				.optional(),
		}),
		handler: async (client, args) => {
			if (args.end_timestamp <= args.start_timestamp) {
				throw new InvalidParamsError("end_timestamp must be greater than start_timestamp");
			}
			const params = {
				instrument_name: args.instrument_name,
				start_timestamp: args.start_timestamp,
				end_timestamp: args.end_timestamp,
			};
			const [fundingRateValue, fundingRateHistory, fundingChart] = await Promise.all([
				client.publicCall("public/get_funding_rate_value", params),
				client.publicCall("public/get_funding_rate_history", params),
				args.length
					? client.publicCall("public/get_funding_chart_data", {
							instrument_name: args.instrument_name,
							length: args.length,
						})
					: Promise.resolve(null),
			]);
			return {
				exchange: "deribit",
				instrumentName: args.instrument_name,
				startTimestamp: args.start_timestamp,
				endTimestamp: args.end_timestamp,
				length: args.length ?? "",
				fundingRateValue,
				fundingRateHistory,
				fundingChart,
			};
		},
	}),

	defineTool({
		name: "deribit_get_public_trades",
		title: "Deribit Public Trades",
		group: "public",
		methods: [
			"public/get_last_trades_by_currency",
			"public/get_last_trades_by_currency_and_time",
			"public/get_last_trades_by_instrument",
			"public/get_last_trades_by_instrument_and_time",
		],
		description:
			"Public market-wide trades, excluding your own. Provide exactly one of currency or instrument_name. Passing timestamps routes to the official time-window endpoints, while start_seq/end_seq paginates by trade sequence number; the two filters cannot be combined. Spot instruments routed to Coinbase Exchange return not_supported_for_coinbase_routed_spot (11060).",
		inputSchema: z.strictObject({
			currency: S.currency.optional(),
			instrument_name: S.instrumentName.optional(),
			kind: z.enum(TRADE_KINDS).describe("Only applies when querying by currency").optional(),
			start_timestamp: S.msTimestamp.optional(),
			end_timestamp: S.msTimestamp.optional(),
			start_seq: z
				.number()
				.int()
				.min(0)
				.describe("Starting trade sequence number; mutually exclusive with the timestamps")
				.optional(),
			end_seq: z
				.number()
				.int()
				.min(0)
				.describe("Ending trade sequence number; mutually exclusive with the timestamps")
				.optional(),
			count: S.count(1000, 100),
			sorting: S.sorting.optional(),
		}),
		handler: async (client, args) => {
			const currency = S.up(args.currency);
			const instrumentName = args.instrument_name;
			S.requireExactlyOne(
				[Boolean(currency), Boolean(instrumentName)],
				"Provide exactly one of currency or instrument_name",
			);

			const timeRanged = args.start_timestamp !== undefined || args.end_timestamp !== undefined;
			const seqRanged = args.start_seq !== undefined || args.end_seq !== undefined;
			// The _and_time endpoints do not accept seq: mixing them would be silently
			// ignored and the model would believe the filter took effect
			if (timeRanged && seqRanged) {
				throw new InvalidParamsError(
					"start_timestamp/end_timestamp cannot be combined with start_seq/end_seq",
				);
			}

			const count = args.count;
			const shared = S.compact({
				count,
				sorting: args.sorting,
				start_timestamp: args.start_timestamp,
				end_timestamp: args.end_timestamp,
				start_seq: args.start_seq,
				end_seq: args.end_seq,
			});

			const apiMethod = instrumentName
				? timeRanged
					? "public/get_last_trades_by_instrument_and_time"
					: "public/get_last_trades_by_instrument"
				: timeRanged
					? "public/get_last_trades_by_currency_and_time"
					: "public/get_last_trades_by_currency";

			const params = instrumentName
				? { instrument_name: instrumentName, ...shared }
				: S.compact({ currency, kind: args.kind, ...shared });

			const trades = await client.publicCall(apiMethod, params);
			return {
				exchange: "deribit",
				apiMethod,
				currency: currency ?? "",
				instrumentName: instrumentName ?? "",
				count,
				trades,
			};
		},
	}),
];
