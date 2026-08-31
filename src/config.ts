import { MissingCredentialsError } from "./errors.js";

export const REQUIRED_CREDENTIAL_ENV = ["DERIBIT_CLIENT_ID", "DERIBIT_CLIENT_SECRET"] as const;

const MAINNET_BASE = "https://www.deribit.com";
const TESTNET_BASE = "https://test.deribit.com";

const TEST_ALIASES = new Set(["test", "testnet", "sandbox"]);
const PROD_ALIASES = new Set(["prod", "production", "main", "mainnet", "live"]);

export interface DeribitCredentials {
	clientId: string;
	clientSecret: string;
}

export interface ServerConfig {
	/** e.g. https://test.deribit.com */
	apiBase: string;
	/** e.g. https://test.deribit.com/api/v2 — method names are appended straight onto it */
	rpcBase: string;
	/** Human-readable environment label */
	envLabel: string;
	/** Real-money environment. The startup banner and the trading gate both read this */
	isMainnet: boolean;
	credentials: DeribitCredentials | undefined;
	enableTrading: boolean;
	timeouts: {
		publicMs: number;
		privateReadMs: number;
		writeMs: number;
	};
	/** Maximum attempts for a read-only request (first attempt included). Writes are always 1 */
	readAttempts: number;
}

function normalizeBase(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`DERIBIT_API_BASE is not a valid URL: ${raw}`);
	}
	if (url.protocol !== "https:") {
		throw new Error(`DERIBIT_API_BASE must use https, got: ${raw}`);
	}
	return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function truthy(value: string | undefined): boolean {
	if (value === undefined) return false;
	return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
	const explicitBase = env.DERIBIT_API_BASE?.trim();
	const rawEnvName = env.DERIBIT_ENV?.trim().toLowerCase();

	let apiBase: string;
	let envLabel: string;
	if (explicitBase) {
		apiBase = normalizeBase(explicitBase);
		envLabel = `custom (${apiBase})`;
	} else if (rawEnvName === undefined || rawEnvName === "" || TEST_ALIASES.has(rawEnvName)) {
		apiBase = TESTNET_BASE;
		envLabel = "testnet";
	} else if (PROD_ALIASES.has(rawEnvName)) {
		apiBase = MAINNET_BASE;
		envLabel = "MAINNET";
	} else {
		throw new Error(
			`DERIBIT_ENV must be one of test|testnet|sandbox|prod|production|mainnet, got: ${rawEnvName}`,
		);
	}

	// A custom base may point at mainnet too, so decide by host rather than by label
	const host = new URL(apiBase).host;
	const isMainnet = host === "www.deribit.com" || host === "deribit.com";
	if (explicitBase) {
		envLabel = `custom ${apiBase}${isMainnet ? " (MAINNET)" : ""}`;
	}

	const clientId = env.DERIBIT_CLIENT_ID?.trim();
	const clientSecret = env.DERIBIT_CLIENT_SECRET?.trim();
	let credentials: DeribitCredentials | undefined;
	if (clientId && clientSecret) {
		credentials = { clientId, clientSecret };
	} else if (clientId || clientSecret) {
		// Half a credential pair is almost certainly a typo; silently degrading to
		// "public tools only" would look like the server is broken
		throw new MissingCredentialsError(
			REQUIRED_CREDENTIAL_ENV.filter((key) => !env[key]?.trim()),
		);
	}

	return {
		apiBase,
		rpcBase: apiBase.endsWith("/api/v2") ? apiBase : `${apiBase}/api/v2`,
		envLabel,
		isMainnet,
		credentials,
		enableTrading: truthy(env.DERIBIT_ENABLE_TRADING),
		timeouts: { publicMs: 10_000, privateReadMs: 15_000, writeMs: 25_000 },
		readAttempts: 3,
	};
}
