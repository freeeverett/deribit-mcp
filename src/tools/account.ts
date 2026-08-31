import { z } from "zod";
import { POSITION_KINDS, SETTLEMENT_TYPES } from "../deribit/constants.js";
import { InvalidParamsError } from "../errors.js";
import * as S from "../schemas.js";
import { defineTool, type ToolModule } from "./types.js";

export const ACCOUNT_TOOLS: ToolModule[] = [
	defineTool({
		name: "deribit_get_account_status",
		title: "Deribit Account Status",
		group: "private-read",
		methods: ["private/get_account_summary", "private/get_positions"],
		description:
			"Account equity, margin, risk metrics and positions for one currency. When unsure which currency to ask for, start with deribit_get_account_summaries. Note that estimated_liquidation_ratio was removed from account summaries, and estimated_liquidation_price is deprecated and no longer returned for segregated_sm accounts.",
		inputSchema: z.strictObject({
			currency: S.currency,
			subaccount_id: S.subaccountId.optional(),
			kind: z.enum(POSITION_KINDS).optional(),
		}),
		handler: async (client, args) => {
			const currency = args.currency.toUpperCase();
			const shared = S.compact({ currency, subaccount_id: args.subaccount_id });
			const [accountSummary, positions] = await Promise.all([
				client.privateCall("private/get_account_summary", { ...shared, extended: true }),
				client.privateCall("private/get_positions", S.compact({ ...shared, kind: args.kind })),
			]);
			return {
				exchange: "deribit",
				currency,
				subaccountId: args.subaccount_id ?? null,
				kind: args.kind ?? "",
				accountSummary,
				positions,
			};
		},
	}),

	defineTool({
		name: "deribit_get_account_summaries",
		title: "Deribit Account Summaries",
		group: "private-read",
		methods: [
			"private/get_account_summaries",
			"private/get_currencies",
			"private/get_user_locks",
		],
		description:
			"Account overview across every currency — equity, margin and available balance — together with the currencies available to the account and the account locks currently in force. When an order is rejected or a withdrawal fails, locks is often the reason. Note that estimated_liquidation_ratio and estimated_liquidation_ratio_map were removed from the summary objects.",
		inputSchema: z.strictObject({
			subaccount_id: S.subaccountId.optional(),
			extended: z.boolean().optional(),
		}),
		handler: async (client, args) => {
			// currencies and locks are both tiny account-level facts; returning them
			// alongside the overview saves the model another round trip. All three calls
			// share one access token, so this is only two extra concurrent requests.
			const [summaries, currencies, locks] = await Promise.all([
				client.privateCall(
					"private/get_account_summaries",
					S.compact({
						subaccount_id: args.subaccount_id,
						extended: args.extended ?? true,
					}),
				),
				client.privateCall("private/get_currencies", {}),
				client.privateCall("private/get_user_locks", {}),
			]);
			return { exchange: "deribit", summaries, currencies, locks };
		},
	}),

	defineTool({
		name: "deribit_get_subaccounts",
		title: "Deribit Subaccounts",
		group: "private-read",
		methods: ["private/get_subaccounts", "private/get_subaccounts_details"],
		description:
			"List every subaccount under the main account with its id — this is where the subaccount_id parameter of the other tools comes from. With currency it also returns each subaccount's position details in that currency. This server only reads subaccounts; it offers no create, rename or delete capability.",
		inputSchema: z.strictObject({
			currency: S.currency
				.describe(
					"When given, also fetch each subaccount's position details in that currency; omit to return the subaccount list only",
				)
				.optional(),
			with_portfolio: z
				.boolean()
				.describe("When true, include portfolio information in the subaccount list")
				.optional(),
			with_open_orders: z
				.boolean()
				.describe(
					"When true, include open orders in the position details; only applies when currency is given",
				)
				.optional(),
		}),
		handler: async (client, args) => {
			const currency = S.up(args.currency);
			const [subaccounts, details] = await Promise.all([
				client.privateCall(
					"private/get_subaccounts",
					S.compact({ with_portfolio: args.with_portfolio }),
				),
				currency
					? client.privateCall(
							"private/get_subaccounts_details",
							S.compact({ currency, with_open_orders: args.with_open_orders }),
						)
					: Promise.resolve(null),
			]);
			return {
				exchange: "deribit",
				currency: currency ?? "",
				subaccounts,
				details,
				note: currency
					? ""
					: "No currency was given, so only the subaccount list is returned; pass currency to also fetch each subaccount's position details in that currency.",
			};
		},
	}),

	defineTool({
		name: "deribit_simulate_portfolio",
		title: "Deribit Portfolio Margin Simulation",
		group: "private-read",
		methods: ["private/simulate_portfolio"],
		description:
			"Simulate portfolio margin: given a set of hypothetical positions, compute the margin requirement and risk metrics. It places no orders and changes no real position. Use it before opening a position to estimate how much margin it would consume. Only meaningful for accounts with Portfolio Margin enabled.",
		inputSchema: z.strictObject({
			currency: S.currency,
			simulated_positions: z
				.record(S.instrumentName, z.number())
				.describe(
					'Hypothetical positions, e.g. {"BTC-PERPETUAL": -1000}. Positive is long, negative is short; futures are denominated in USD and options in the underlying currency',
				)
				.optional(),
			add_positions: z
				.boolean()
				.describe(
					"true (Deribit's default) layers the hypothetical positions on top of the current real positions; false computes from the hypothetical positions alone",
				)
				.optional(),
		}),
		handler: async (client, args) => {
			const currency = args.currency.toUpperCase();
			// simulated_positions has to be URI-encoded over HTTP GET, but the official
			// example for JSON-RPC POST is a nested object, so it is passed through as-is.
			const portfolio = await client.privateCall(
				"private/simulate_portfolio",
				S.compact({
					currency,
					simulated_positions: args.simulated_positions,
					add_positions: args.add_positions,
				}),
			);
			return { exchange: "deribit", currency, portfolio };
		},
	}),

	defineTool({
		name: "deribit_get_position",
		title: "Deribit Single Position",
		group: "private-read",
		methods: ["private/get_position"],
		description:
			"One instrument's position: size, direction, average price, mark price, unrealised P&L, margin and option Greeks. estimated_liquidation_price is deprecated and is no longer returned for segregated_sm accounts.",
		inputSchema: z.strictObject({ instrument_name: S.instrumentName }),
		handler: async (client, args) => {
			const position = await client.privateCall("private/get_position", {
				instrument_name: args.instrument_name,
			});
			return { exchange: "deribit", instrumentName: args.instrument_name, position };
		},
	}),

	defineTool({
		name: "deribit_get_transaction_log",
		title: "Deribit Transaction Log",
		group: "private-read",
		methods: ["private/get_transaction_log"],
		description:
			"Account transaction log: trades, fees, funding, settlements, deliveries and transfers. Timestamps are in milliseconds.",
		inputSchema: z.strictObject({
			currency: S.currency,
			start_timestamp: S.msTimestamp,
			end_timestamp: z.number().int().min(1).describe("UNIX timestamp in milliseconds"),
			query: z
				.string()
				.describe(
					"Filter by type, e.g. trade, deposit, withdrawal, settlement, delivery, transfer; omit to return everything",
				)
				.optional(),
			count: S.count(1000, 100),
			continuation: z
				.number()
				.int()
				.describe("The continuation cursor returned by the previous page")
				.optional(),
			subaccount_id: S.subaccountId.optional(),
		}),
		handler: async (client, args) => {
			if (args.end_timestamp <= args.start_timestamp) {
				throw new InvalidParamsError("end_timestamp must be greater than start_timestamp");
			}
			const currency = args.currency.toUpperCase();
			const count = args.count;
			const log = await client.privateCall(
				"private/get_transaction_log",
				S.compact({
					currency,
					start_timestamp: args.start_timestamp,
					end_timestamp: args.end_timestamp,
					query: args.query,
					count,
					continuation: args.continuation,
					subaccount_id: args.subaccount_id,
				}),
			);
			return {
				exchange: "deribit",
				currency,
				startTimestamp: args.start_timestamp,
				endTimestamp: args.end_timestamp,
				count,
				log,
			};
		},
	}),

	defineTool({
		name: "deribit_get_settlement_history",
		title: "Deribit Settlement History",
		group: "private-read",
		methods: [
			"private/get_settlement_history_by_currency",
			"private/get_settlement_history_by_instrument",
		],
		description:
			"Your own settlement, delivery and bankruptcy records for options and futures. Provide exactly one of currency or instrument_name.",
		inputSchema: z.strictObject({
			currency: S.currency.optional(),
			instrument_name: S.instrumentName.optional(),
			type: z.enum(SETTLEMENT_TYPES).optional(),
			count: S.count(1000, 100),
			continuation: z
				.string()
				.describe("The continuation cursor returned by the previous page")
				.optional(),
			search_start_timestamp: S.msTimestamp
				.describe("UNIX timestamp in milliseconds; the search runs backwards from this point")
				.optional(),
		}),
		handler: async (client, args) => {
			const currency = S.up(args.currency);
			const instrumentName = args.instrument_name;
			S.requireExactlyOne(
				[Boolean(currency), Boolean(instrumentName)],
				"Provide exactly one of currency or instrument_name",
			);

			const count = args.count;
			const apiMethod = instrumentName
				? "private/get_settlement_history_by_instrument"
				: "private/get_settlement_history_by_currency";
			const settlements = await client.privateCall(
				apiMethod,
				S.compact({
					currency,
					instrument_name: instrumentName,
					type: args.type,
					count,
					continuation: args.continuation,
					search_start_timestamp: args.search_start_timestamp,
				}),
			);
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
		name: "deribit_get_wallet_history",
		title: "Deribit Wallet History",
		group: "private-read",
		methods: ["private/get_transfers", "private/get_deposits", "private/get_withdrawals"],
		description: "Transfer, deposit and withdrawal history for one currency.",
		inputSchema: z.strictObject({
			currency: S.currency,
			count: S.count(1000, 100),
		}),
		handler: async (client, args) => {
			const currency = args.currency.toUpperCase();
			const count = args.count;
			const params = { currency, count };
			const [transfers, deposits, withdrawals] = await Promise.all([
				client.privateCall("private/get_transfers", params),
				client.privateCall("private/get_deposits", params),
				client.privateCall("private/get_withdrawals", params),
			]);
			return { exchange: "deribit", currency, count, transfers, deposits, withdrawals };
		},
	}),
];
