import { z } from "zod";
import {
	ADVANCED_PRICING,
	CANCEL_KINDS,
	CANCEL_ORDER_TYPES,
	DIRECTIONS,
	ORDER_TYPES,
	TIME_IN_FORCE,
	TRIGGER_ORDER_TYPES,
	TRIGGER_PRICE_ORDER_TYPES,
	TRIGGER_TYPES,
} from "../deribit/constants.js";
import { InvalidParamsError } from "../errors.js";
import * as S from "../schemas.js";
import { DESTRUCTIVE_ANNOTATIONS, PLACE_ANNOTATIONS, defineTool, type ToolModule } from "./types.js";

const TRADE_SCOPE = "trade:read_write" as const;

const validUntil = z
	.number()
	.int()
	.min(1)
	.describe(
		"Millisecond timestamp; the matching engine only processes the request before this moment and returns timed_out afterwards. It must line up with server time, which deribit_get_status reports",
	);

export const TRADING_WRITE_TOOLS: ToolModule[] = [
	defineTool({
		name: "deribit_place_order",
		title: "Deribit Place Order",
		group: "private-write",
		methods: ["private/buy", "private/sell"],
		annotations: PLACE_ANNOTATIONS,
		description:
			"Create a real order. Supports limit, market, stop, take-profit, market-limit, trailing stop and advanced option pricing. Spot instruments routed to Coinbase Exchange (is_cbe_routed / is_csr on the instrument) accept only limit, market and stop_limit; time_in_force is limited to good_til_cancelled, immediate_or_cancel and fill_or_kill; post_only is allowed only together with reject_post_only=true; reduce_only, display_amount (iceberg) and linked orders are not supported; and the stop-limit trigger is last_price only. good_til_day is rejected for every spot instrument. Fills on routed spot are asynchronous: placement is acknowledged once Coinbase accepts the order, so the trades array of the response may be empty.",
		inputSchema: z.strictObject({
			instrument_name: S.instrumentName,
			side: z.enum(DIRECTIONS),
			amount: S.positiveNumber
				.describe(
					"Order amount. Perpetuals and inverse futures are denominated in USD; options and linear futures in the underlying currency. Give at least one of amount or contracts; if both are given they must be equal or Deribit errors.",
				)
				.optional(),
			contracts: S.positiveNumber
				.describe("Order amount expressed in contracts, an alternative to amount")
				.optional(),
			type: z.enum(ORDER_TYPES).default("limit"),
			price: S.positiveNumber
				.describe(
					"Order price, used only by limit and stop_limit. With advanced=usd give the option's USD price; with advanced=implv give the implied volatility as a percentage (100 means 100%).",
				)
				.optional(),
			trigger: z
				.enum(TRIGGER_TYPES)
				.describe("Trigger type; required for stop, take-profit and trailing stop orders")
				.optional(),
			trigger_price: S.positiveNumber.describe("Required for stop-loss and take-profit orders").optional(),
			trigger_offset: S.positiveNumber
				.describe("Maximum deviation from the price peak for a trailing stop order")
				.optional(),
			advanced: z
				.enum(ADVANCED_PRICING)
				.describe("Advanced option pricing; options only, and linear options do not support usd")
				.optional(),
			label: S.label.optional(),
			time_in_force: z
				.enum(TIME_IN_FORCE)
				.describe("When omitted, Deribit treats the order as good_til_cancelled")
				.optional(),
			post_only: z
				.boolean()
				.describe(
					"Deribit defaults to true when omitted; only valid with time_in_force=good_til_cancelled",
				)
				.optional(),
			reject_post_only: z
				.boolean()
				.describe("Deribit defaults to false when omitted; only valid with post_only=true")
				.optional(),
			reduce_only: z.boolean().describe("Deribit defaults to false when omitted").optional(),
			display_amount: S.positiveNumber.describe("Initial displayed amount of an iceberg order").optional(),
			valid_until: validUntil.optional(),
		}),
		handler: async (client, args) => {
			// Only the constraints the private/buy docs state unconditionally are enforced
			// here. Anything the docs leave open (must a limit order carry a price? must a
			// trailing_stop carry a trigger_offset?) is left to Deribit: extra client-side
			// validation would block order shapes the docs allow, and Deribit's own
			// business errors already reach the model verbatim as isError results. The
			// same goes for the Coinbase-routed spot restrictions above — an instrument's
			// routing is not knowable here without an extra lookup. Quoting the docs:
			//   amount:            "mandatory parameter if contracts parameter is missing" (and vice versa)
			//   trigger_price:     "required for trigger orders only (Stop-loss or Take-profit orders)"
			//   trigger:           "Required for Stop-Loss, Take-Profit and Trailing trigger orders"
			//   post_only:         "Only valid in combination with time_in_force=good_til_cancelled"
			//   reject_post_only:  "Only valid in combination with post_only set to true"
			if (args.amount === undefined && args.contracts === undefined) {
				throw new InvalidParamsError("Provide amount or contracts");
			}
			if (
				(TRIGGER_PRICE_ORDER_TYPES as readonly string[]).includes(args.type) &&
				args.trigger_price === undefined
			) {
				throw new InvalidParamsError(`trigger_price is required for Deribit ${args.type} orders`);
			}
			if (
				(TRIGGER_ORDER_TYPES as readonly string[]).includes(args.type) &&
				args.trigger === undefined
			) {
				throw new InvalidParamsError(`trigger is required for Deribit ${args.type} orders`);
			}
			if (
				args.post_only === true &&
				args.time_in_force &&
				args.time_in_force !== "good_til_cancelled"
			) {
				throw new InvalidParamsError("post_only requires time_in_force=good_til_cancelled");
			}
			if (args.reject_post_only === true && args.post_only !== true) {
				throw new InvalidParamsError("reject_post_only requires post_only=true");
			}

			const params = S.compact({
				instrument_name: args.instrument_name,
				amount: args.amount,
				contracts: args.contracts,
				type: args.type,
				price: args.price,
				trigger: args.trigger,
				trigger_price: args.trigger_price,
				trigger_offset: args.trigger_offset,
				advanced: args.advanced,
				label: args.label,
				time_in_force: args.time_in_force,
				post_only: args.post_only,
				reject_post_only: args.reject_post_only,
				reduce_only: args.reduce_only,
				display_amount: args.display_amount,
				valid_until: args.valid_until,
			});
			const apiMethod = `private/${args.side}`;
			const result = await client.privateCall(apiMethod, params, {
				scope: TRADE_SCOPE,
				readOnly: false,
			});
			return { exchange: "deribit", apiMethod, result };
		},
	}),

	defineTool({
		name: "deribit_edit_order",
		title: "Deribit Edit Order",
		group: "private-write",
		methods: ["private/edit", "private/edit_by_label"],
		annotations: DESTRUCTIVE_ANNOTATIONS,
		description:
			"Edit an unfilled order. Provide exactly one of order_id or label; editing by label additionally requires instrument_name. Optional fields that are omitted keep their current value. Spot instruments routed to Coinbase Exchange (is_cbe_routed / is_csr on the instrument) accept only limit, market and stop_limit; time_in_force is limited to good_til_cancelled, immediate_or_cancel and fill_or_kill; post_only is allowed only together with reject_post_only=true; reduce_only, display_amount (iceberg) and linked orders are not supported; and the stop-limit trigger is last_price only. good_til_day is rejected for every spot instrument. Editing the mmp flag to a different value is rejected, and quote-originated orders cannot be edited (order_not_found, 10004).",
		inputSchema: z.strictObject({
			order_id: z.string().min(1).optional(),
			label: S.label.optional(),
			instrument_name: S.instrumentName.optional(),
			amount: S.positiveNumber
				.describe("New order amount; alternative to contracts, omit to keep the current value")
				.optional(),
			contracts: S.positiveNumber
				.describe("New amount expressed in contracts, an alternative to amount")
				.optional(),
			price: S.positiveNumber.describe("New order price; omit to keep the current value").optional(),
			advanced: z.enum(ADVANCED_PRICING).optional(),
			trigger_price: S.positiveNumber.optional(),
			trigger_offset: S.positiveNumber.optional(),
			post_only: z
				.boolean()
				.describe("Only valid with time_in_force=good_til_cancelled")
				.optional(),
			reduce_only: z.boolean().optional(),
			reject_post_only: z.boolean().describe("Only valid with post_only=true").optional(),
			display_amount: S.positiveNumber.describe("Displayed amount of an iceberg order").optional(),
			valid_until: validUntil.optional(),
		}),
		handler: async (client, args) => {
			S.requireExactlyOne(
				[Boolean(args.order_id), Boolean(args.label)],
				"Provide exactly one of order_id or label",
			);
			if (args.label && !args.instrument_name) {
				throw new InvalidParamsError("instrument_name is required when editing by label");
			}
			if (args.reject_post_only === true && args.post_only !== true) {
				throw new InvalidParamsError("reject_post_only requires post_only=true");
			}

			// In the private/edit docs only order_id is required; amount and price are both
			// optional (omitting them keeps the current value), so neither is forced here —
			// "change the price but not the size" is a common way to edit an order.
			const params = S.compact({
				order_id: args.order_id,
				label: args.label,
				instrument_name: args.instrument_name,
				amount: args.amount,
				contracts: args.contracts,
				price: args.price,
				advanced: args.advanced,
				trigger_price: args.trigger_price,
				trigger_offset: args.trigger_offset,
				post_only: args.post_only,
				reduce_only: args.reduce_only,
				reject_post_only: args.reject_post_only,
				display_amount: args.display_amount,
				valid_until: args.valid_until,
			});
			const apiMethod = args.label ? "private/edit_by_label" : "private/edit";
			const result = await client.privateCall(apiMethod, params, {
				scope: TRADE_SCOPE,
				readOnly: false,
			});
			return { exchange: "deribit", apiMethod, result };
		},
	}),

	defineTool({
		name: "deribit_cancel_order",
		title: "Deribit Cancel Order",
		group: "private-write",
		methods: [
			"private/cancel",
			"private/cancel_by_label",
			"private/cancel_all",
			"private/cancel_all_by_currency",
			"private/cancel_all_by_currency_pair",
			"private/cancel_all_by_instrument",
			"private/cancel_all_by_kind_or_type",
		],
		annotations: { ...DESTRUCTIVE_ANNOTATIONS, idempotentHint: true },
		description:
			"Cancel orders. Exactly one of order_id, label, instrument_name, currency, currency_pair, currencies or cancel_all=true must be chosen; empty arguments cancel nothing. With cancel_all=true, kind and order_type restrict cancellation across all currencies.",
		inputSchema: z.strictObject({
			order_id: z.string().min(1).optional(),
			label: S.label.optional(),
			instrument_name: S.instrumentName.optional(),
			currency: S.currency.optional(),
			currency_pair: z.string().min(1).describe("Index name, e.g. btc_usd").optional(),
			currencies: z.array(z.string().min(1)).min(1).optional(),
			cancel_all: z.boolean().optional(),
			kind: z.enum(CANCEL_KINDS).optional(),
			order_type: z.enum(CANCEL_ORDER_TYPES).optional(),
			detailed: z.boolean().optional(),
			include_combos: z.boolean().optional(),
			freeze_quotes: z.boolean().optional(),
		}),
		handler: async (client, args) => {
			const currency = S.up(args.currency);
			const currencyPair = S.low(args.currency_pair);
			const currencies = args.currencies?.map((item) => item.toUpperCase());
			const cancelAll = args.cancel_all === true;

			// When cancelling by label, currency is only an extra filter rather than a
			// cancellation scope of its own
			S.requireExactlyOne(
				[
					Boolean(args.order_id),
					Boolean(args.label),
					Boolean(args.instrument_name),
					Boolean(currencyPair),
					Boolean(currencies),
					Boolean(currency && !args.label),
					cancelAll,
				],
				"Choose exactly one cancellation selector: order_id, label, instrument_name, currency, currency_pair, currencies, or cancel_all=true",
			);

			const common = S.compact({
				kind: args.kind,
				type: args.order_type,
				detailed: args.detailed,
				freeze_quotes: args.freeze_quotes,
			});

			let apiMethod: string;
			let params: Record<string, unknown>;
			if (args.order_id) {
				apiMethod = "private/cancel";
				params = { order_id: args.order_id };
			} else if (args.label) {
				apiMethod = "private/cancel_by_label";
				params = S.compact({ label: args.label, currency });
			} else if (args.instrument_name) {
				apiMethod = "private/cancel_all_by_instrument";
				params = S.compact({
					instrument_name: args.instrument_name,
					type: args.order_type,
					detailed: args.detailed,
					include_combos: args.include_combos,
					freeze_quotes: args.freeze_quotes,
				});
			} else if (currencyPair) {
				apiMethod = "private/cancel_all_by_currency_pair";
				params = { currency_pair: currencyPair, ...common };
			} else if (currencies) {
				apiMethod = "private/cancel_all_by_kind_or_type";
				params = { currency: currencies, ...common };
			} else if (currency) {
				apiMethod = "private/cancel_all_by_currency";
				params = { currency, ...common };
			} else if (args.kind !== undefined || args.order_type !== undefined) {
				apiMethod = "private/cancel_all_by_kind_or_type";
				params = { currency: "any", ...common };
			} else {
				apiMethod = "private/cancel_all";
				params = S.compact({
					detailed: args.detailed,
					freeze_quotes: args.freeze_quotes,
				});
			}

			const result = await client.privateCall(apiMethod, params, {
				scope: TRADE_SCOPE,
				readOnly: false,
			});
			return { exchange: "deribit", apiMethod, result };
		},
	}),

	defineTool({
		name: "deribit_close_position",
		title: "Deribit Close Position",
		group: "private-write",
		methods: ["private/close_position"],
		annotations: DESTRUCTIVE_ANNOTATIONS,
		description:
			"Close the entire position in one instrument. A market close executes immediately; a limit close requires price. This creates a real order and will not open a reverse position.",
		inputSchema: z.strictObject({
			instrument_name: S.instrumentName,
			type: z.enum(["limit", "market"]),
			price: S.positiveNumber.describe("Required when type=limit").optional(),
		}),
		handler: async (client, args) => {
			if (args.type === "limit" && args.price === undefined) {
				throw new InvalidParamsError("price is required when type=limit");
			}
			if (args.type === "market" && args.price !== undefined) {
				throw new InvalidParamsError("price must be omitted when type=market");
			}
			const result = await client.privateCall(
				"private/close_position",
				S.compact({
					instrument_name: args.instrument_name,
					type: args.type,
					price: args.price,
				}),
				{ scope: TRADE_SCOPE, readOnly: false },
			);
			return {
				exchange: "deribit",
				apiMethod: "private/close_position",
				instrumentName: args.instrument_name,
				type: args.type,
				result,
			};
		},
	}),

	defineTool({
		name: "deribit_create_combo",
		title: "Deribit Create Combo",
		group: "private-write",
		methods: ["private/create_combo", "private/get_leg_prices"],
		annotations: PLACE_ANNOTATIONS,
		description:
			"Create a multi-leg combo instrument and return its tradable identifier; when a price is given it also returns the per-leg split prices. Every leg must supply instrument_name, amount and direction. This creates a real combo but places no order.",
		inputSchema: z.strictObject({
			trades: z
				.array(
					z.strictObject({
						instrument_name: S.instrumentName,
						amount: S.positiveNumber,
						direction: z.enum(DIRECTIONS),
					}),
				)
				.min(2)
				.describe("The legs of the combo"),
			price: S.positiveNumber
				.describe("Optional combo execution price; when given, the per-leg split prices are also returned")
				.optional(),
		}),
		handler: async (client, args) => {
			const trades = args.trades;
			const combo = await client.privateCall(
				"private/create_combo",
				{ trades },
				{ scope: TRADE_SCOPE, readOnly: false },
			);

			// The leg prices are a pure after-the-fact calculation; their failure must not
			// lose the combo that has already been created
			let legPrices: unknown = null;
			if (args.price !== undefined) {
				try {
					legPrices = await client.privateCall("private/get_leg_prices", {
						legs: trades,
						price: args.price,
					});
				} catch (error) {
					legPrices = { error: error instanceof Error ? error.message : String(error) };
				}
			}

			return {
				exchange: "deribit",
				apiMethod: "private/create_combo",
				combo,
				legPrices,
			};
		},
	}),
];
