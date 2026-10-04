import type { DeribitCredentials, ServerConfig } from "../config.js";
import { DeribitApiError, MissingCredentialsError } from "../errors.js";
import { REQUIRED_CREDENTIAL_ENV } from "../config.js";
import type { DeribitScope } from "./constants.js";

/**
 * The authentication method. It belongs to no tool, but it is still an official
 * endpoint this server depends on, so it takes part in the check-api-drift
 * reconciliation.
 */
export const AUTH_METHOD = "public/auth";

/** Deribit's rate-limit error code; retrying after a backoff is worthwhile. */
const TOO_MANY_REQUESTS = 10_028;
/** The access token is no longer valid. Re-authenticating once is enough. */
const INVALID_TOKEN = 13_009;

/** How early a token is treated as expired, leaving room for clock drift and round trips. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;
const MIN_TOKEN_TTL_MS = 30_000;

interface RpcEnvelope {
	jsonrpc?: unknown;
	id?: unknown;
	result?: unknown;
	error?: unknown;
}

interface CachedToken {
	token: string;
	expiresAt: number;
}

interface RpcOptions {
	token?: string | undefined;
	readOnly: boolean;
	timeoutMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extract Deribit's error information.
 *
 * An observed error body looks like:
 *   {"jsonrpc":"2.0","error":{"code":-32602,"data":{"reason":"wrong format",
 *    "param":"instrument_name"},"message":"Invalid params"},"testnet":true,...}
 * Note there is **no id** in it, so callers must never validate the id on the
 * error branch.
 */
function toApiError(method: string, error: unknown): DeribitApiError {
	if (!isRecord(error)) {
		return new DeribitApiError(method, undefined, JSON.stringify(error), undefined);
	}
	const code = typeof error.code === "number" ? error.code : undefined;
	const message = typeof error.message === "string" ? error.message : "unknown error";
	return new DeribitApiError(method, code, message, error.data);
}

function isTransientNetworkError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if (error.name === "AbortError" || error.name === "TimeoutError") return true;
	const cause = (error as { cause?: { code?: unknown } }).cause;
	const causeCode = typeof cause?.code === "string" ? cause.code : "";
	if (["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND"].includes(causeCode)) {
		return true;
	}
	return /fetch failed|network|socket hang up|timeout/i.test(error.message);
}

/** The docs quote roughly "500 credits restored every 50ms", so a linear backoff suffices. */
function retryDelayMs(attempt: number): number {
	return attempt * 150;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A Deribit JSON-RPC-over-HTTP client shared across the process. */
export class DeribitClient {
	private readonly tokens = new Map<string, CachedToken>();
	/** Concurrent private calls should not each fire their own public/auth; they share one in-flight request. */
	private readonly inflightAuth = new Map<string, Promise<string>>();

	constructor(private readonly config: ServerConfig) {}

	publicCall(method: string, params: Record<string, unknown>): Promise<unknown> {
		return this.rpc(method, params, {
			readOnly: true,
			timeoutMs: this.config.timeouts.publicMs,
		});
	}

	/**
	 * Private call. Writes (readOnly=false) are **never retried** — replaying a
	 * place/edit/cancel once means one extra real order.
	 */
	async privateCall(
		method: string,
		params: Record<string, unknown>,
		options: { scope?: DeribitScope; readOnly?: boolean } = {},
	): Promise<unknown> {
		const readOnly = options.readOnly ?? true;
		const scope = options.scope;
		const timeoutMs = readOnly
			? this.config.timeouts.privateReadMs
			: this.config.timeouts.writeMs;

		const token = await this.accessToken(scope);
		try {
			return await this.rpc(method, params, { token, readOnly, timeoutMs });
		} catch (error) {
			// Clear an invalid token for future calls, but only replay read-only
			// requests. Every write must be sent exactly once, including auth failures.
			if (error instanceof DeribitApiError && error.code === INVALID_TOKEN) {
				this.tokens.delete(scopeKey(scope));
				if (readOnly) {
					const fresh = await this.accessToken(scope);
					return await this.rpc(method, params, { token: fresh, readOnly, timeoutMs });
				}
			}
			throw error;
		}
	}

	private requireCredentials(): DeribitCredentials {
		const credentials = this.config.credentials;
		if (!credentials) throw new MissingCredentialsError(REQUIRED_CREDENTIAL_ENV);
		return credentials;
	}

	private async accessToken(scope: DeribitScope | undefined): Promise<string> {
		const key = scopeKey(scope);
		const cached = this.tokens.get(key);
		if (cached && cached.expiresAt > Date.now()) return cached.token;

		const inflight = this.inflightAuth.get(key);
		if (inflight) return inflight;

		const pending = this.authenticate(scope, key).finally(() => {
			this.inflightAuth.delete(key);
		});
		this.inflightAuth.set(key, pending);
		return pending;
	}

	private async authenticate(scope: DeribitScope | undefined, key: string): Promise<string> {
		const { clientId, clientSecret } = this.requireCredentials();
		const result = await this.rpc(
			AUTH_METHOD,
			{
				grant_type: "client_credentials",
				client_id: clientId,
				client_secret: clientSecret,
				...(scope ? { scope } : {}),
			},
			{ readOnly: true, timeoutMs: this.config.timeouts.publicMs },
		);
		if (!isRecord(result)) throw new Error("Deribit public/auth returned a non-object result");

		const token = result.access_token;
		if (typeof token !== "string" || token === "") {
			throw new Error("Deribit public/auth did not return access_token");
		}
		const grantedScope = typeof result.scope === "string" ? result.scope : "";
		if (scope && !grantedScope.split(/\s+/).includes(scope)) {
			// Fail early rather than letting the model believe an order request went out
			throw new Error(
				`Deribit API key did not grant the required scope "${scope}" ` +
					`(granted: "${grantedScope}"). Enable trading permissions on the key, ` +
					`or unset DERIBIT_ENABLE_TRADING.`,
			);
		}

		const expiresInSec = typeof result.expires_in === "number" ? result.expires_in : 0;
		const ttlMs = Math.max(expiresInSec * 1000 - TOKEN_EXPIRY_MARGIN_MS, MIN_TOKEN_TTL_MS);
		this.tokens.set(key, { token, expiresAt: Date.now() + ttlMs });
		return token;
	}

	private async rpc(
		method: string,
		params: Record<string, unknown>,
		options: RpcOptions,
	): Promise<unknown> {
		const attempts = options.readOnly ? this.config.readAttempts : 1;
		const url = `${this.config.rpcBase}/${method}`;
		let lastError: unknown = new Error(`Deribit request failed: ${method}`);

		for (let attempt = 1; attempt <= attempts; attempt += 1) {
			const requestId = `${method}-${attempt}-${randomId()}`;
			const headers: Record<string, string> = {
				Accept: "application/json",
				"Content-Type": "application/json",
			};
			if (options.token) headers.Authorization = `Bearer ${options.token}`;

			let response: Response;
			let text: string;
			try {
				response = await fetch(url, {
					method: "POST",
					headers,
					body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
					signal: AbortSignal.timeout(options.timeoutMs),
				});
				// A connection may fail after headers arrive. Body reads use the same
				// timeout and retry policy as fetch; writes still have one attempt.
				text = await response.text();
			} catch (error) {
				lastError = error;
				if (attempt >= attempts || !isTransientNetworkError(error)) throw error;
				await sleep(retryDelayMs(attempt));
				continue;
			}

			// Crucial: Deribit's business errors come back as HTTP 400 with a JSON-RPC
			// error in the body, so we must not short-circuit on the status code —
			// read and parse the body first.
			let envelope: RpcEnvelope;
			try {
				envelope = JSON.parse(text) as RpcEnvelope;
			} catch {
				const error = new Error(
					`Deribit returned non-JSON for ${method} (HTTP ${response.status}): ` +
						`${text.slice(0, 300)}`,
				);
				lastError = error;
				if (attempt < attempts && isRetryableStatus(response.status)) {
					await sleep(retryDelayMs(attempt));
					continue;
				}
				throw error;
			}

			if (envelope.error !== undefined && envelope.error !== null) {
				const apiError = toApiError(method, envelope.error);
				lastError = apiError;
				if (attempt < attempts && apiError.code === TOO_MANY_REQUESTS) {
					await sleep(retryDelayMs(attempt));
					continue;
				}
				throw apiError;
			}

			if (!("result" in envelope)) {
				const error = new Error(
					`Deribit response for ${method} contained neither result nor error ` +
						`(HTTP ${response.status})`,
				);
				lastError = error;
				if (attempt < attempts && isRetryableStatus(response.status)) {
					await sleep(retryDelayMs(attempt));
					continue;
				}
				throw error;
			}

			// The id is only validated on successful responses: error responses carry no id
			if (envelope.id !== requestId) {
				throw new Error(
					`Deribit response id mismatch for ${method} ` +
						`(sent ${requestId}, got ${String(envelope.id)})`,
				);
			}
			return envelope.result;
		}

		throw lastError;
	}
}

function isRetryableStatus(status: number): boolean {
	return status === 429 || status >= 500;
}

function scopeKey(scope: DeribitScope | undefined): string {
	return scope ?? "__default__";
}

function randomId(): string {
	return Math.random().toString(36).slice(2, 10);
}
