/**
 * Both error classes deliberately extend plain Error rather than the SDK's McpError.
 *
 * McpServer's CallTool handler (sdk/server/mcp.js) treats the two differently:
 *   - McpError   -> rethrown as-is, becoming a JSON-RPC protocol error
 *   - plain Error -> wrapped into a { isError: true, content: [text] } tool result
 *
 * We want the latter: the model can read the reason, adjust its arguments and retry,
 * whereas a protocol error shows up in most clients as a bare "tool call failed".
 */

/** Illegal argument combination (cross-field constraints a Zod schema cannot express). */
export class InvalidParamsError extends Error {
	override readonly name = "InvalidParamsError";
}

/** Deribit returned a JSON-RPC error object. */
export class DeribitApiError extends Error {
	override readonly name = "DeribitApiError";

	constructor(
		readonly method: string,
		readonly code: number | undefined,
		readonly reason: string,
		readonly data: unknown,
	) {
		const suffix = data === undefined ? "" : ` ${JSON.stringify(data)}`;
		super(`Deribit API error (${method}): ${code ?? "?"} ${reason}${suffix}`);
	}
}

/** Thrown when API credentials are not configured; names the missing env vars. */
export class MissingCredentialsError extends Error {
	override readonly name = "MissingCredentialsError";

	constructor(missing: readonly string[]) {
		super(
			`Deribit credentials missing: ${missing.join(", ")}. ` +
				`Set them in the MCP server's env block and restart the client.`,
		);
	}
}
