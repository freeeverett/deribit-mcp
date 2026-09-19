/**
 * Version alignment
 * -----------------
 * Deribit's JSON-RPC API has no semver: the path is always /api/v2. What actually
 * changes are the date-stamped releases on
 * https://docs.deribit.com/changelogs/jsonrpc.
 *
 * So this server's version number encodes both:
 *
 *     2   .   20260915   .   0
 *     ^        ^              ^
 *     |        |              +-- local iteration (Nth change against the same doc release)
 *     |        +----------------- the changelog release we are aligned to (YYYYMMDD)
 *     +-------------------------- Deribit API major version (v2)
 *
 * Upgrade flow: when `npm run check:api` reports a release newer than
 * DERIBIT_API_RELEASE, walk the changelog entry by entry, fix the affected tools,
 * then push DERIBIT_API_RELEASE and the minor segment of SERVER_VERSION to the new
 * date together and reset the patch to zero.
 */

export const DERIBIT_API_VERSION = "v2";

/** The Deribit JSON-RPC changelog release this server has been reconciled against (ISO date). */
export const DERIBIT_API_RELEASE = "2026-09-15";

export const SERVER_NAME = "deribit-mcp";

export const SERVER_VERSION = "2.20260915.0";

/** Compact form of DERIBIT_API_RELEASE; must match the minor segment of SERVER_VERSION. */
export const DERIBIT_API_RELEASE_COMPACT = DERIBIT_API_RELEASE.replaceAll("-", "");
