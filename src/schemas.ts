import { z } from "zod";
import { InvalidParamsError } from "./errors.js";
import { INSTRUMENT_KINDS, ORDER_BOOK_DEPTHS, SORTING_VALUES } from "./deribit/constants.js";

export const currency = z
	.string()
	.min(1)
	.describe("Settlement currency, e.g. BTC, ETH, USDC, USDT, EURR");

export const instrumentName = z
	.string()
	.min(1)
	.describe("Instrument name, e.g. BTC-PERPETUAL, BTC-27JUN25-100000-C");

export const indexName = z.string().min(1).describe("Index name, e.g. btc_usd, eth_usdc");

export const kind = z.enum(INSTRUMENT_KINDS);

export const sorting = z.enum(SORTING_VALUES);

export const label = z.string().max(64);

export const orderId = z.string().min(1).describe("Order id returned when the order was placed");

export const msTimestamp = z.number().int().min(0).describe("UNIX timestamp in milliseconds");

export const positiveNumber = z.number().gt(0);

export const depth = z
	.literal(ORDER_BOOK_DEPTHS)
	.describe("Number of order book levels; omit to let Deribit return its default depth");

export function count(max: number, dflt: number) {
	return z
		.number()
		.int()
		.min(1)
		.max(max)
		.default(dflt)
		.describe(`Number of entries to return, at most ${max}`);
}

export const subaccountId = z
	.number()
	.int()
	.min(0)
	.describe(
		"Only used to target a query at a specific subaccount; this server offers no subaccount management",
	);

/** Normalise to upper case. Deribit's currency parameter only accepts upper case. */
export function up<T extends string>(value: T | undefined): string | undefined {
	return value?.toUpperCase();
}

/** Normalise to lower case. index_name / currency_pair only accept lower case. */
export function low<T extends string>(value: T | undefined): string | undefined {
	return value?.toLowerCase();
}

/** Drop undefined keys so they never get serialised into the JSON-RPC params. */
export function compact<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		if (value !== undefined) out[key] = value;
	}
	return out;
}

/** Exactly one flag must hold, otherwise throw. Used for "one of these" cross-field constraints. */
export function requireExactlyOne(flags: readonly boolean[], message: string): void {
	if (flags.filter(Boolean).length !== 1) throw new InvalidParamsError(message);
}
