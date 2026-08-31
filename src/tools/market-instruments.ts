import { z } from "zod";
import {
	CHART_RESOLUTIONS,
	INSTRUMENT_KINDS,
	toChartResolution,
} from "../deribit/constants.js";
import { InvalidParamsError } from "../errors.js";
import * as S from "../schemas.js";
import { defineTool, type ToolModule } from "./types.js";

export const MARKET_INSTRUMENT_TOOLS: ToolModule[] = [
	defineTool({
		name: "deribit_get_instruments_info",
		title: "Deribit Instruments Info",
		group: "public",
		methods: [
			"public/get_currencies",
			"public/get_instruments",
			"public/get_instrument",
			"public/get_contract_size",
		],
		description:
			"List the currencies and tradable instruments Deribit supports. With no arguments it returns currencies only; with currency it returns that currency's instrument list; with instrument_name it returns one instrument's full specification (tick size, contract size, fee rates, expiry and instrument id). Instruments also carry product_group and index_id, and spot instruments routed to Coinbase Exchange carry is_cbe_routed / is_csr — both fields are omitted entirely for everything else, so test for presence rather than for a false value. Routed spot omits the block_trade_* fields.",
		inputSchema: z.strictObject({
			currency: S.currency.optional(),
			kind: z.enum(INSTRUMENT_KINDS).optional(),
			instrument_name: S.instrumentName
				.describe(
					"Instrument name, e.g. BTC-PERPETUAL, BTC-27JUN25-100000-C. Mutually exclusive with currency/kind",
				)
				.optional(),
		}),
		handler: async (client, args) => {
			const instrumentName = args.instrument_name;
			const currency = S.up(args.currency);
			const kind = args.kind;

			if (instrumentName) {
				if (currency || kind) {
					throw new InvalidParamsError("instrument_name cannot be combined with currency or kind");
				}
				const [instrument, contractSize] = await Promise.all([
					client.publicCall("public/get_instrument", { instrument_name: instrumentName }),
					client.publicCall("public/get_contract_size", {
						instrument_name: instrumentName,
					}),
				]);
				return {
					exchange: "deribit",
					currency: "",
					kind: "",
					instrumentName,
					currencies: [],
					instruments: [],
					instrument,
					contractSize,
					note: "contract_size is also present in the instrument body; contractSize is just the verbatim response of the dedicated official endpoint.",
				};
			}

			const [currencies, instruments] = await Promise.all([
				client.publicCall("public/get_currencies", {}),
				currency
					? client.publicCall(
							"public/get_instruments",
							S.compact({ currency, kind }),
						)
					: Promise.resolve([]),
			]);
			return {
				exchange: "deribit",
				currency: currency ?? "",
				kind: kind ?? "",
				instrumentName: "",
				currencies,
				instruments,
				instrument: null,
				contractSize: null,
				note: currency
					? "Both the currencies and the tradable instruments of the requested currency were returned."
					: "No currency was given, so only the supported currencies are returned; pass currency to also query the instrument list, or instrument_name for a single instrument's specification.",
			};
		},
	}),

	defineTool({
		name: "deribit_get_expirations",
		title: "Deribit Expirations",
		group: "public",
		methods: ["public/get_expirations"],
		description:
			"List the tradable expiration dates of futures or options. Timestamps are in milliseconds; both currency and kind accept any to disable filtering.",
		inputSchema: z.strictObject({
			currency: z.string().min(1).describe("Settlement currency or grouping, e.g. BTC, ETH, USDC, any"),
			kind: z.enum(["future", "option", "any"]),
			currency_pair: S.indexName.optional(),
		}),
		handler: async (client, args) => {
			const currency = args.currency;
			const expirations = await client.publicCall(
				"public/get_expirations",
				S.compact({
					// "any" is a documented value and must not be upper-cased
					currency: currency.toLowerCase() === "any" ? "any" : currency.toUpperCase(),
					kind: args.kind,
					currency_pair: S.low(args.currency_pair),
				}),
			);
			return { exchange: "deribit", currency, kind: args.kind, expirations };
		},
	}),

	defineTool({
		name: "deribit_get_option_chain",
		title: "Deribit Option Chain",
		group: "public",
		methods: [
			"public/get_book_summary_by_currency",
			"public/get_book_summary_by_instrument",
		],
		description:
			"Book summaries including open interest, implied volatility, volume and bid/ask. With currency it returns the whole option chain, or the summaries of that currency's other instrument kinds; with instrument_name it returns a single instrument's summary. Provide exactly one of the two.",
		inputSchema: z.strictObject({
			currency: S.currency.optional(),
			kind: z
				.enum(INSTRUMENT_KINDS)
				.describe("Only applies when querying by currency; defaults to option")
				.optional(),
			instrument_name: S.instrumentName.optional(),
		}),
		handler: async (client, args) => {
			const currency = S.up(args.currency);
			const instrumentName = args.instrument_name;
			S.requireExactlyOne(
				[Boolean(currency), Boolean(instrumentName)],
				"Provide exactly one of currency or instrument_name",
			);

			if (instrumentName) {
				const summaries = await client.publicCall(
					"public/get_book_summary_by_instrument",
					{ instrument_name: instrumentName },
				);
				return {
					exchange: "deribit",
					apiMethod: "public/get_book_summary_by_instrument",
					currency: "",
					kind: "",
					instrumentName,
					summaries,
				};
			}

			const kind = args.kind ?? "option";
			const summaries = await client.publicCall("public/get_book_summary_by_currency", {
				currency,
				kind,
			});
			return {
				exchange: "deribit",
				apiMethod: "public/get_book_summary_by_currency",
				currency,
				kind,
				instrumentName: "",
				summaries,
			};
		},
	}),

	defineTool({
		name: "deribit_get_market_quote",
		title: "Deribit Market Quote",
		group: "public",
		methods: [
			"public/ticker",
			"public/get_order_book",
			"public/get_order_book_by_instrument_id",
		],
		description:
			"Live ticker, order book depth, implied volatility and option Greeks for one instrument. Provide exactly one of instrument_name or instrument_id; querying by id returns the order book only. For spot routed to Coinbase Exchange the ticker omits volume_notional and volume_usd, but order book data is unaffected.",
		inputSchema: z.strictObject({
			instrument_name: S.instrumentName.optional(),
			instrument_id: z
				.number()
				.int()
				.min(1)
				.describe("Numeric instrument id, available from the instruments list of deribit_get_instruments_info")
				.optional(),
			depth: S.depth.optional(),
		}),
		handler: async (client, args) => {
			const instrumentName = args.instrument_name;
			const instrumentId = args.instrument_id;
			S.requireExactlyOne(
				[Boolean(instrumentName), instrumentId !== undefined],
				"Provide exactly one of instrument_name or instrument_id",
			);
			const depth = args.depth;

			if (instrumentId !== undefined) {
				const orderBook = await client.publicCall(
					"public/get_order_book_by_instrument_id",
					S.compact({ instrument_id: instrumentId, depth }),
				);
				return {
					exchange: "deribit",
					apiMethod: "public/get_order_book_by_instrument_id",
					instrumentName: "",
					instrumentId,
					depth: depth ?? 0,
					ticker: null,
					orderBook,
					note: "ticker has no by-instrument_id variant; use instrument_name when you need the market statistics and Greeks.",
				};
			}

			const [ticker, orderBook] = await Promise.all([
				client.publicCall("public/ticker", { instrument_name: instrumentName }),
				client.publicCall(
					"public/get_order_book",
					S.compact({ instrument_name: instrumentName, depth }),
				),
			]);
			return {
				exchange: "deribit",
				apiMethod: "public/get_order_book",
				instrumentName,
				instrumentId: 0,
				depth: depth ?? 0,
				ticker,
				orderBook,
				note: "",
			};
		},
	}),

	defineTool({
		name: "deribit_get_historical_candles",
		title: "Deribit Historical Candles",
		group: "public",
		methods: ["public/get_tradingview_chart_data"],
		description:
			"Historical candlesticks and volume for one instrument. Timestamps are in milliseconds. Spot instruments routed to Coinbase Exchange are not supported here and return not_supported_for_coinbase_routed_spot (11060).",
		inputSchema: z.strictObject({
			instrument_name: S.instrumentName,
			resolution: z
				.enum(CHART_RESOLUTIONS)
				.describe("Candle period; a number is minutes, 1D is daily"),
			start_timestamp: S.msTimestamp,
			end_timestamp: z.number().int().min(1).describe("UNIX timestamp in milliseconds"),
		}),
		handler: async (client, args) => {
			if (args.end_timestamp <= args.start_timestamp) {
				throw new InvalidParamsError("end_timestamp must be greater than start_timestamp");
			}
			const candles = await client.publicCall("public/get_tradingview_chart_data", {
				instrument_name: args.instrument_name,
				resolution: toChartResolution(args.resolution),
				start_timestamp: args.start_timestamp,
				end_timestamp: args.end_timestamp,
			});
			return {
				exchange: "deribit",
				instrumentName: args.instrument_name,
				resolution: args.resolution,
				startTimestamp: args.start_timestamp,
				endTimestamp: args.end_timestamp,
				candles,
			};
		},
	}),
];
