/** Instrument kinds. Matches the `kind` parameter of public/get_instruments. */
export const INSTRUMENT_KINDS = ["future", "option", "spot", "future_combo", "option_combo"] as const;

/** Position kinds. private/get_positions does not accept spot. */
export const POSITION_KINDS = ["future", "option", "future_combo", "option_combo"] as const;

export const TRADE_KINDS = [...INSTRUMENT_KINDS, "combo", "any"] as const;

export const CANCEL_KINDS = [...INSTRUMENT_KINDS, "combo", "any"] as const;

export const ORDER_TYPES = [
	"limit",
	"stop_limit",
	"take_limit",
	"market",
	"stop_market",
	"take_market",
	"market_limit",
	"trailing_stop",
] as const;

/** Order types that require trigger_price. */
export const TRIGGER_PRICE_ORDER_TYPES = [
	"stop_limit",
	"take_limit",
	"stop_market",
	"take_market",
] as const;

/** Order types that require trigger (the above plus trailing_stop). */
export const TRIGGER_ORDER_TYPES = [...TRIGGER_PRICE_ORDER_TYPES, "trailing_stop"] as const;

export const TRIGGER_TYPES = ["index_price", "mark_price", "last_price"] as const;

export const TIME_IN_FORCE = [
	"good_til_cancelled",
	"good_til_day",
	"fill_or_kill",
	"immediate_or_cancel",
] as const;

export const CANCEL_ORDER_TYPES = [
	"all",
	"limit",
	"trigger_all",
	"stop",
	"take",
	"trailing_stop",
] as const;

export const SORTING_VALUES = ["asc", "desc", "default"] as const;

export const SETTLEMENT_TYPES = ["settlement", "delivery", "bankruptcy"] as const;

export const COMBO_STATES = ["active", "inactive"] as const;

export const INDEX_CHART_RANGES = ["1h", "1d", "2d", "1m", "1y", "all"] as const;

export const FUNDING_CHART_LENGTHS = ["8h", "24h", "1m"] as const;

export const SUPPORTED_INDEX_TYPES = ["all", "spot", "derivative"] as const;

/** APR is published only for these yield-bearing tokens, and the official values are lower case. */
export const APR_CURRENCIES = ["usde", "steth", "usdc", "build"] as const;

export const DIRECTIONS = ["buy", "sell"] as const;

export const ADVANCED_PRICING = ["usd", "implv"] as const;

/** public/get_order_book only accepts these discrete depth values. */
export const ORDER_BOOK_DEPTHS = [1, 5, 10, 20, 50, 100, 1000, 10000] as const;

/**
 * The resolution of public/get_tradingview_chart_data.
 *
 * Deribit accepts either a number (minutes) or the string "1D". We declare it
 * uniformly as a string enum: a property-level oneOf behaves inconsistently across
 * MCP clients' schema conversion, and a string enum is the most portable encoding.
 * toChartResolution converts it back to the type Deribit expects before the call.
 */
export const CHART_RESOLUTIONS = [
	"1",
	"3",
	"5",
	"10",
	"15",
	"30",
	"60",
	"120",
	"180",
	"360",
	"720",
	"1D",
] as const;

export function toChartResolution(value: (typeof CHART_RESOLUTIONS)[number]): string | number {
	return value === "1D" ? value : Number(value);
}

/** DVOL resolutions are strings to begin with, so they are passed through as-is. */
export const DVOL_RESOLUTIONS = ["1", "60", "3600", "43200", "1D"] as const;

/** Scopes that can be requested at authentication time. This server only ever needs the write one. */
export type DeribitScope = "trade:read_write";
