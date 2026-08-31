import { z } from "zod";
import { APR_CURRENCIES, COMBO_STATES, SETTLEMENT_TYPES } from "../deribit/constants.js";
import { InvalidParamsError } from "../errors.js";
import * as S from "../schemas.js";
import { defineTool, type ToolModule } from "./types.js";

export const MARKET_HISTORY_TOOLS: ToolModule[] = [
	defineTool({
		name: "deribit_get_trade_volumes",
		title: "Deribit Trade Volumes",
		group: "public",
		methods: ["public/get_trade_volumes"],
		description:
			"Exchange-wide 24-hour volume per currency, split into calls, puts, futures and spot. With extended=true it also returns 7-day and 30-day volume. This is aggregate exchange data and has nothing to do with your own trades. For any currency with a spot pair routed to Coinbase Exchange, spot_volume (and spot_volume_7d / spot_volume_30d under extended) is omitted.",
		inputSchema: z.strictObject({
			extended: z.boolean().describe("When true, also return 7-day and 30-day volume").optional(),
		}),
		handler: async (client, args) => {
			const volumes = await client.publicCall(
				"public/get_trade_volumes",
				S.compact({ extended: args.extended }),
			);
			return { exchange: "deribit", extended: args.extended ?? false, volumes };
		},
	}),

	defineTool({
		name: "deribit_get_apr_history",
		title: "Deribit APR History",
		group: "public",
		methods: ["public/get_apr_history"],
		description:
			"Historical annual percentage rate (APR) of yield-bearing tokens, one entry per calendar day. Only usde, steth, usdc and build are supported; no other currency has this data.",
		inputSchema: z.strictObject({
			// The official values are lower case and must not be upper-cased
			currency: z.enum(APR_CURRENCIES).describe("Yield-bearing token, in lower case"),
			limit: z
				.number()
				.int()
				.min(1)
				.max(365)
				.describe("Number of days to return; defaults to 365, at most 365")
				.optional(),
			before: z
				.number()
				.int()
				.min(0)
				.describe("Pagination cursor: return data from before this epoch day")
				.optional(),
		}),
		handler: async (client, args) => {
			const aprHistory = await client.publicCall(
				"public/get_apr_history",
				S.compact({ currency: args.currency, limit: args.limit, before: args.before }),
			);
			return { exchange: "deribit", currency: args.currency, aprHistory };
		},
	}),

	defineTool({
		name: "deribit_get_delivery_prices",
		title: "Deribit Delivery Prices",
		group: "public",
		methods: ["public/get_delivery_prices"],
		description:
			"Historical delivery prices for an index, for reconciling the settlement of expired instruments.",
		inputSchema: z.strictObject({
			index_name: S.indexName,
			offset: z.number().int().min(0).optional(),
			count: S.count(1000, 10),
		}),
		handler: async (client, args) => {
			const indexName = args.index_name.toLowerCase();
			const deliveryPrices = await client.publicCall(
				"public/get_delivery_prices",
				S.compact({
					index_name: indexName,
					offset: args.offset,
					count: args.count,
				}),
			);
			return { exchange: "deribit", indexName, deliveryPrices };
		},
	}),

	defineTool({
		name: "deribit_get_public_settlements",
		title: "Deribit Public Settlements",
		group: "public",
		methods: [
			"public/get_last_settlements_by_currency",
			"public/get_last_settlements_by_instrument",
		],
		description:
			"Market-wide settlement, delivery and bankruptcy events, excluding your own position P&L. Provide exactly one of currency or instrument_name. For your own option deliveries and settlement results, use deribit_get_settlement_history.",
		inputSchema: z.strictObject({
			currency: S.currency.optional(),
			instrument_name: S.instrumentName.optional(),
			type: z.enum(SETTLEMENT_TYPES).optional(),
			count: S.count(1000, 20),
			continuation: z
				.string()
				.describe("Pagination cursor, taken from the continuation field of the previous response")
				.optional(),
			search_start_timestamp: S.msTimestamp.optional(),
		}),
		handler: async (client, args) => {
			const currency = S.up(args.currency);
			const instrumentName = args.instrument_name;
			S.requireExactlyOne(
				[Boolean(currency), Boolean(instrumentName)],
				"Provide exactly one of currency or instrument_name",
			);

			const count = args.count;
			const shared = S.compact({
				count,
				type: args.type,
				continuation: args.continuation,
				search_start_timestamp: args.search_start_timestamp,
			});
			const apiMethod = instrumentName
				? "public/get_last_settlements_by_instrument"
				: "public/get_last_settlements_by_currency";
			const params = instrumentName
				? { instrument_name: instrumentName, ...shared }
				: S.compact({ currency, ...shared });

			const settlements = await client.publicCall(apiMethod, params);
			return {
				exchange: "deribit",
				apiMethod,
				currency: currency ?? "",
				instrumentName: instrumentName ?? "",
				count,
				settlements,
			};
		},
	}),

	defineTool({
		name: "deribit_get_combos",
		title: "Deribit Combos",
		group: "public",
		methods: ["public/get_combo_details", "public/get_combo_ids", "public/get_combos"],
		description:
			"The combo instruments that exist on the exchange. With combo_id it returns a single combo's details; with ids_only=true it returns just that currency's combo id list (a far smaller payload than the full list); otherwise it returns the full combo list for the currency.",
		inputSchema: z.strictObject({
			currency: S.currency.describe("Settlement currency; required when combo_id is omitted").optional(),
			combo_id: z.string().min(1).describe("Combo identifier, e.g. BTC-STRG-28JUN24-65000").optional(),
			state: z.enum(COMBO_STATES).optional(),
			ids_only: z
				.boolean()
				.describe("When true, return only the combo id list without each combo's legs and state")
				.optional(),
		}),
		handler: async (client, args) => {
			if (args.combo_id) {
				const combo = await client.publicCall("public/get_combo_details", {
					combo_id: args.combo_id,
				});
				return {
					exchange: "deribit",
					apiMethod: "public/get_combo_details",
					currency: "",
					state: "",
					combo,
					comboIds: [],
					combos: [],
				};
			}

			if (!args.currency) throw new InvalidParamsError("Provide currency when combo_id is omitted");
			const currency = args.currency.toUpperCase();
			const state = args.state;

			if (args.ids_only) {
				const comboIds = await client.publicCall(
					"public/get_combo_ids",
					S.compact({ currency, state }),
				);
				return {
					exchange: "deribit",
					apiMethod: "public/get_combo_ids",
					currency,
					state: state ?? "",
					combo: null,
					comboIds,
					combos: [],
				};
			}

			const combos = await client.publicCall(
				"public/get_combos",
				S.compact({ currency, state }),
			);
			return {
				exchange: "deribit",
				apiMethod: "public/get_combos",
				currency,
				state: state ?? "",
				combo: null,
				comboIds: [],
				combos,
			};
		},
	}),

	defineTool({
		name: "deribit_get_announcements",
		title: "Deribit Announcements",
		group: "public",
		methods: ["public/get_announcements"],
		description:
			"Exchange announcements: system upgrades, maintenance windows, new instrument listings and rule changes. The body field is HTML. Worth checking here first when investigating odd market behaviour or order rejections.",
		inputSchema: z.strictObject({
			count: z
				.number()
				.int()
				.min(1)
				.max(50)
				.default(5)
				.describe("Number of entries to return, at most 50"),
			start_timestamp: S.msTimestamp
				.describe(
					"Return only announcements older than this millisecond timestamp, for pagination; omit to read back from now",
				)
				.optional(),
		}),
		handler: async (client, args) => {
			const announcements = await client.publicCall(
				"public/get_announcements",
				S.compact({ count: args.count, start_timestamp: args.start_timestamp }),
			);
			return { exchange: "deribit", count: args.count, announcements };
		},
	}),

	defineTool({
		name: "deribit_get_status",
		title: "Deribit Platform Status",
		group: "public",
		methods: ["public/status", "public/get_time"],
		description:
			"Deribit platform status and server time, useful for confirming a maintenance or settlement window.",
		inputSchema: z.strictObject({}),
		handler: async (client) => {
			const [status, serverTime] = await Promise.all([
				client.publicCall("public/status", {}),
				client.publicCall("public/get_time", {}),
			]);
			return { exchange: "deribit", status, serverTime };
		},
	}),
];
