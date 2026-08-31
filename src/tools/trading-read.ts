import { z } from "zod";
import { CANCEL_ORDER_TYPES, INSTRUMENT_KINDS } from "../deribit/constants.js";
import { InvalidParamsError } from "../errors.js";
import * as S from "../schemas.js";
import { defineTool, type ToolModule } from "./types.js";

export const TRADING_READ_TOOLS: ToolModule[] = [
	defineTool({
		name: "deribit_get_active_orders",
		title: "Deribit Active Orders",
		group: "private-read",
		methods: [
			"private/get_open_orders",
			"private/get_open_orders_by_currency",
			"private/get_open_orders_by_instrument",
			"private/get_open_orders_by_label",
		],
		description:
			"Currently active, unfilled orders. Can be filtered by instrument, currency and label; when label is given, currency must be given too. With no filter it queries every currency.",
		inputSchema: z.strictObject({
			currency: S.currency.optional(),
			instrument_name: S.instrumentName.optional(),
			label: S.label.optional(),
			kind: z.enum(INSTRUMENT_KINDS).optional(),
			type: z.enum(CANCEL_ORDER_TYPES).optional(),
		}),
		handler: async (client, args) => {
			const currency = S.up(args.currency);
			const instrumentName = args.instrument_name;
			const label = args.label;
			if (label && !currency) {
				throw new InvalidParamsError("currency is required when querying by label");
			}

			let apiMethod: string;
			let params: Record<string, unknown>;
			if (instrumentName) {
				apiMethod = "private/get_open_orders_by_instrument";
				params = S.compact({ instrument_name: instrumentName, type: args.type });
			} else if (label) {
				apiMethod = "private/get_open_orders_by_label";
				params = { currency, label };
			} else if (currency) {
				apiMethod = "private/get_open_orders_by_currency";
				params = S.compact({ currency, kind: args.kind, type: args.type });
			} else {
				apiMethod = "private/get_open_orders";
				params = S.compact({ kind: args.kind, type: args.type });
			}

			const orders = await client.privateCall(apiMethod, params);
			return {
				exchange: "deribit",
				apiMethod,
				currency: currency ?? "",
				instrumentName: instrumentName ?? "",
				label: label ?? "",
				orders,
			};
		},
	}),

	defineTool({
		name: "deribit_get_order_state",
		title: "Deribit Order State",
		group: "private-read",
		methods: ["private/get_order_state"],
		description:
			"Current state of a single order: filled amount, average price and remaining amount. Orders matched in Starbase also carry starbase_order_id and starbase_last_update_timestamp.",
		inputSchema: z.strictObject({ order_id: S.orderId }),
		handler: async (client, args) => {
			const order = await client.privateCall("private/get_order_state", {
				order_id: args.order_id,
			});
			return { exchange: "deribit", orderId: args.order_id, order };
		},
	}),

	defineTool({
		name: "deribit_get_order_state_by_label",
		title: "Deribit Order State By Label",
		group: "private-read",
		methods: ["private/get_order_state_by_label"],
		description: "Look up order state by the label set when the order was placed.",
		inputSchema: z.strictObject({ currency: S.currency, label: S.label }),
		handler: async (client, args) => {
			const currency = args.currency.toUpperCase();
			const orders = await client.privateCall("private/get_order_state_by_label", {
				currency,
				label: args.label,
			});
			return { exchange: "deribit", currency, label: args.label, orders };
		},
	}),

	defineTool({
		name: "deribit_get_order_history",
		title: "Deribit Order History",
		group: "private-read",
		methods: [
			"private/get_order_history_by_currency",
			"private/get_order_history_by_instrument",
		],
		description:
			"Historical orders, including filled, cancelled and expired ones. Provide exactly one of currency or instrument_name.",
		inputSchema: z.strictObject({
			currency: S.currency.optional(),
			instrument_name: S.instrumentName.optional(),
			kind: z.enum(INSTRUMENT_KINDS).describe("Only applies when querying by currency").optional(),
			count: S.count(1000, 100),
			offset: z.number().int().min(0).optional(),
			include_old: z.boolean().describe("Whether to include orders up to two years old").optional(),
			include_unfilled: z
				.boolean()
				.describe("Whether to include orders that were cancelled without ever filling")
				.optional(),
			historical: z.boolean().default(true),
		}),
		handler: async (client, args) => {
			const currency = S.up(args.currency);
			const instrumentName = args.instrument_name;
			S.requireExactlyOne(
				[Boolean(currency), Boolean(instrumentName)],
				"Provide exactly one of currency or instrument_name",
			);

			const count = args.count;
			const historical = args.historical;
			const apiMethod = instrumentName
				? "private/get_order_history_by_instrument"
				: "private/get_order_history_by_currency";
			const orders = await client.privateCall(
				apiMethod,
				S.compact({
					currency,
					instrument_name: instrumentName,
					kind: instrumentName ? undefined : args.kind,
					count,
					offset: args.offset,
					include_old: args.include_old,
					include_unfilled: args.include_unfilled,
					historical,
				}),
			);
			return {
				exchange: "deribit",
				apiMethod,
				currency: currency ?? "",
				instrumentName: instrumentName ?? "",
				count,
				historical,
				orders,
			};
		},
	}),

	defineTool({
		name: "deribit_get_trigger_order_history",
		title: "Deribit Trigger Order History",
		group: "private-read",
		methods: ["private/get_trigger_order_history"],
		description:
			"History and trigger outcome of trigger orders such as stop-loss, take-profit and trailing stop.",
		inputSchema: z.strictObject({
			currency: S.currency,
			instrument_name: S.instrumentName.optional(),
			count: S.count(1000, 100),
			continuation: z
				.string()
				.describe("The continuation cursor returned by the previous page")
				.optional(),
		}),
		handler: async (client, args) => {
			const currency = args.currency.toUpperCase();
			const count = args.count;
			const orders = await client.privateCall(
				"private/get_trigger_order_history",
				S.compact({
					currency,
					instrument_name: args.instrument_name,
					count,
					continuation: args.continuation,
				}),
			);
			return { exchange: "deribit", currency, count, orders };
		},
	}),

	defineTool({
		name: "deribit_get_trade_history",
		title: "Deribit Trade History",
		group: "private-read",
		methods: [
			"private/get_user_trades_by_currency",
			"private/get_user_trades_by_currency_and_time",
			"private/get_user_trades_by_instrument",
			"private/get_user_trades_by_instrument_and_time",
		],
		description:
			"Your own historical fills. Provide exactly one of currency or instrument_name; giving both start_timestamp and end_timestamp routes to the official time-window endpoints. For funding and deliveries, use deribit_get_transaction_log. Trades matched in Starbase also carry starbase_match_id, starbase_order_id, starbase_client_order_id and starbase_timestamp.",
		inputSchema: z.strictObject({
			currency: S.currency.optional(),
			instrument_name: S.instrumentName.optional(),
			kind: z.enum(INSTRUMENT_KINDS).describe("Only applies when querying by currency").optional(),
			start_timestamp: S.msTimestamp
				.describe("UNIX timestamp in milliseconds. If given, end_timestamp must be given too")
				.optional(),
			end_timestamp: S.msTimestamp
				.describe("UNIX timestamp in milliseconds. If given, start_timestamp must be given too")
				.optional(),
			count: S.count(1000, 100),
			sorting: S.sorting.optional(),
			historical: z.boolean().default(true),
		}),
		handler: async (client, args) => {
			const currency = S.up(args.currency);
			const instrumentName = args.instrument_name;
			S.requireExactlyOne(
				[Boolean(currency), Boolean(instrumentName)],
				"Provide exactly one of currency or instrument_name",
			);

			const { start_timestamp: startTs, end_timestamp: endTs } = args;
			// The _and_time endpoints mark both timestamps as required; giving only one
			// gets rejected by Deribit
			if ((startTs === undefined) !== (endTs === undefined)) {
				throw new InvalidParamsError(
					"start_timestamp and end_timestamp must be provided together for a time-ranged query",
				);
			}
			const timeRanged = startTs !== undefined && endTs !== undefined;
			if (timeRanged && endTs <= startTs) {
				throw new InvalidParamsError("end_timestamp must be greater than start_timestamp");
			}

			const count = args.count;
			const historical = args.historical;
			const apiMethod = instrumentName
				? timeRanged
					? "private/get_user_trades_by_instrument_and_time"
					: "private/get_user_trades_by_instrument"
				: timeRanged
					? "private/get_user_trades_by_currency_and_time"
					: "private/get_user_trades_by_currency";

			const trades = await client.privateCall(
				apiMethod,
				S.compact({
					currency,
					instrument_name: instrumentName,
					kind: instrumentName ? undefined : args.kind,
					start_timestamp: startTs,
					end_timestamp: endTs,
					count,
					sorting: args.sorting,
					historical,
				}),
			);
			return {
				exchange: "deribit",
				apiMethod,
				currency: currency ?? "",
				instrumentName: instrumentName ?? "",
				count,
				historical,
				trades,
			};
		},
	}),

	defineTool({
		name: "deribit_get_order_trades",
		title: "Deribit Order Fills",
		group: "private-read",
		methods: ["private/get_user_trades_by_order"],
		description: "Every fill of one order, including price, amount and fee.",
		inputSchema: z.strictObject({
			order_id: S.orderId,
			sorting: S.sorting.optional(),
			historical: z.boolean().default(true),
		}),
		handler: async (client, args) => {
			const historical = args.historical;
			const trades = await client.privateCall(
				"private/get_user_trades_by_order",
				S.compact({ order_id: args.order_id, sorting: args.sorting, historical }),
			);
			return { exchange: "deribit", orderId: args.order_id, historical, trades };
		},
	}),

	defineTool({
		name: "deribit_get_margins",
		title: "Deribit Order Margin Estimate",
		group: "private-read",
		methods: ["private/get_margins"],
		description:
			"Estimate the buy-side and sell-side margin an order would consume. It creates no order. The response also includes fee fields.",
		inputSchema: z.strictObject({
			instrument_name: S.instrumentName,
			amount: S.positiveNumber,
			price: S.positiveNumber,
		}),
		handler: async (client, args) => {
			const margins = await client.privateCall("private/get_margins", {
				instrument_name: args.instrument_name,
				amount: args.amount,
				price: args.price,
			});
			return {
				exchange: "deribit",
				instrumentName: args.instrument_name,
				amount: args.amount,
				price: args.price,
				margins,
			};
		},
	}),
];
