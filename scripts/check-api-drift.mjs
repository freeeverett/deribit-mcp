#!/usr/bin/env node
/**
 * Deribit API documentation drift detection.
 *
 * The minor segment of this server's version number is the changelog release date
 * it is aligned to (see src/version.ts). This script answers "did the docs move?":
 *
 *   0. does the version's minor segment equal DERIBIT_API_RELEASE?
 *   1. do any methods we call no longer exist in the official spec? (breaking)
 *   2. which REST endpoints are still uncovered? (counted per business category;
 *      the target categories and every public endpoint are listed individually)
 *   3. does the changelog carry a release newer than DERIBIT_API_RELEASE?
 *      (time to bump)
 *
 * Any of 0 / 1 / 3 exits 1. Adding --write also regenerates docs/API-COVERAGE.md.
 *
 *   node scripts/check-api-drift.mjs [--write]
 *
 * The endpoint list comes from the official OpenAPI specification, not from
 * llms.txt: the latter is a navigation index written for LLMs and was observed to
 * be missing private/get_currencies and 4 LSP methods (all present in the
 * OpenAPI spec), so using it as the source of truth would distort both the
 * "method vanished" and the "new method" checks. llms.txt is only used to look up
 * documentation links.
 */
import { writeFileSync } from "node:fs";
import { AUTH_METHOD } from "../dist/deribit/client.js";
import { ALL_DERIBIT_METHODS, ALL_TOOLS } from "../dist/tools/index.js";
import {
	DERIBIT_API_RELEASE,
	DERIBIT_API_RELEASE_COMPACT,
	DERIBIT_API_VERSION,
	SERVER_VERSION,
} from "../dist/version.js";

const OPENAPI = "https://docs.deribit.com/specifications/deribit_openapi.json";
const LLMS_TXT = "https://docs.deribit.com/llms.txt";
const CHANGELOG = "https://docs.deribit.com/changelogs/jsonrpc.md";

/** Only these OpenAPI tags are in this server's target scope; uncovered endpoints in other categories are counted but not listed. */
const TARGET_TAGS = new Set(["Market Data", "Trading", "Combo Books", "Supporting"]);

/** Endpoints inside the target scope we deliberately do not implement, with reasons, so they stop showing up as to-do noise on every run. */
const INTENTIONALLY_SKIPPED = new Map([
	["private/cancel_quotes", "Market-maker quote management, out of scope for this server"],
	["private/mass_quote", "Market-maker mass quoting, out of scope for this server"],
	["private/get_mmp_config", "Market Maker Protection (MMP) configuration"],
	["private/set_mmp_config", "Market Maker Protection (MMP) configuration"],
	["private/get_mmp_status", "Market Maker Protection (MMP) status"],
	["private/reset_mmp", "Market Maker Protection (MMP) reset"],
	[
		"private/move_positions",
		"Moves positions between subaccounts; a funds operation, deliberately not exposed",
	],
	[
		"private/get_order_margin_by_ids",
		"deribit_get_margins already covers the margin estimation use case",
	],
	["public/test", "Connectivity self-check; deribit_get_status already covers the same need"],
	[
		"public/exchange_token",
		"Switches the session to a subaccount; this server targets queries with the subaccount_id parameter instead",
	],
	["public/fork_token", "Named session forking, only meaningful for long-lived connections"],
	["public/get_block_rfq_trades", "Block RFQ is out of scope as a whole; see the scope note below"],
]);

const BUSINESS_TAGS = [
	"Market Data",
	"Trading",
	"Combo Books",
	"Account Management",
	"Wallet",
	"Block Trade",
	"Block RFQ",
	"Authentication",
	"Session Management",
	"Supporting",
	"lsp",
	"Chat",
	"Portfolio Management",
];

async function fetchJson(url) {
	const response = await fetch(url, { headers: { Accept: "application/json" } });
	if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status}`);
	return response.json();
}

async function fetchText(url) {
	const response = await fetch(url, { headers: { Accept: "text/plain" } });
	if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status}`);
	return response.text();
}

/** OpenAPI specification -> { method -> {tag, wsOnly, summary} }. */
function parseSpec(spec) {
	const endpoints = new Map();
	for (const [path, operations] of Object.entries(spec.paths)) {
		const tags = new Set();
		let summary = "";
		for (const [verb, operation] of Object.entries(operations)) {
			if (!["get", "post", "put", "patch", "delete"].includes(verb)) continue;
			for (const tag of operation.tags ?? []) tags.add(tag);
			summary ||= (operation.summary ?? operation.description ?? "").split("\n")[0].trim();
		}
		endpoints.set(path.replace(/^\//, ""), {
			tag: BUSINESS_TAGS.find((tag) => tags.has(tag)) ?? "Other",
			wsOnly: tags.has("WebSocket Only"),
			summary,
		});
	}
	return endpoints;
}

/** llms.txt is only used to add documentation links to the coverage table; without a hit we fall back to the bare method name. */
function parseDocLinks(llmsTxt) {
	const links = new Map();
	const pattern = /\[((?:public|private)\/[a-z_0-9/]+)\]\((https:\/\/docs\.deribit\.com\/[^)]+)\)/g;
	for (const match of llmsTxt.matchAll(pattern)) links.set(match[1], match[2]);
	return links;
}

function parseReleases(changelog) {
	const releases = [];
	for (const match of changelog.matchAll(/Release (\d{2})\.(\d{2})\.(\d{4})/g)) {
		const iso = `${match[3]}-${match[2]}-${match[1]}`;
		if (!releases.includes(iso)) releases.push(iso);
	}
	return releases.sort().reverse();
}

function renderCoverage(endpoints, docLinks, stats) {
	const link = (method) => {
		const url = docLinks.get(method);
		return url ? `[\`${method}\`](${url})` : `\`${method}\``;
	};

	const lines = [
		"# Deribit API coverage",
		"",
		"> Generated by `node scripts/check-api-drift.mjs --write`. Do not edit by hand.",
		"",
		`- Server version: \`${SERVER_VERSION}\``,
		`- Deribit API: \`${DERIBIT_API_VERSION}\` (the OpenAPI spec declares \`info.version\` as \`${stats.specVersion}\`)`,
		`- Aligned changelog release: **${DERIBIT_API_RELEASE}**`,
		`- Tools: ${ALL_TOOLS.length} — endpoints covered: ${stats.covered} / ${stats.restTotal} REST endpoints` +
			` (a further ${stats.wsOnly} endpoints are WebSocket-only and out of scope for this server)`,
		"",
		"For the version numbering rule see [`src/version.ts`](../src/version.ts): `2.<changelog date>.<local iteration>`.",
		"",
		"## Coverage by category",
		"",
		"| Category | Implemented | Not implemented | Total |",
		"| --- | ---: | ---: | ---: |",
	];
	for (const [tag, bucket] of stats.byTag) {
		lines.push(
			`| ${tag} | ${bucket.covered.length} | ${bucket.missing.length} | ` +
				`${bucket.covered.length + bucket.missing.length} |`,
		);
	}
	lines.push(`| **Total** | **${stats.covered}** | **${stats.missing}** | **${stats.restTotal}** |`);

	lines.push(
		"",
		"## Tool → RPC method",
		"",
		"| Tool | Group | Deribit methods called |",
		"| --- | --- | --- |",
	);
	for (const tool of ALL_TOOLS) {
		const methods = tool.methods
			.map((method) =>
				endpoints.has(method) ? link(method) : `\`${method}\` ⚠️ not in the OpenAPI spec`,
			)
			.join("<br>");
		lines.push(`| \`${tool.name}\` | ${tool.group} | ${methods} |`);
	}

	lines.push(
		"",
		"## Methods the client itself depends on",
		"",
		"| Method | Purpose |",
		"| --- | --- |",
		`| ${link(AUTH_METHOD)} | client_credentials authentication, caching the access token per scope |`,
	);

	lines.push(
		"",
		"## Endpoints deliberately not covered inside the target categories",
		"",
		"| Endpoint | Reason |",
		"| --- | --- |",
	);
	for (const [method, reason] of INTENTIONALLY_SKIPPED) {
		lines.push(`| \`${method}\` | ${reason} |`);
	}

	lines.push(
		"",
		"## Scope",
		"",
		`This server focuses on the ${[...TARGET_TAGS].join(" / ")} categories, plus **read-only** account and wallet queries.`,
		"The following are out of scope in their entirety: subaccount and API key management, deposits,",
		"withdrawals and transfers, Block Trade / Block RFQ, Market Maker Protection (MMP) and mass quoting,",
		"the Liquidity Support Program (LSP), and the subscriptions and session management that are",
		"WebSocket-only.",
		"Run `node scripts/check-api-drift.mjs` for the full, up-to-date list of what is not implemented.",
		"",
	);
	return lines.join("\n");
}

async function main() {
	const write = process.argv.includes("--write");
	const [spec, llmsTxt, changelog] = await Promise.all([
		fetchJson(OPENAPI),
		fetchText(LLMS_TXT),
		fetchText(CHANGELOG),
	]);

	const endpoints = parseSpec(spec);
	const docLinks = parseDocLinks(llmsTxt);
	const rest = new Map([...endpoints].filter(([, meta]) => !meta.wsOnly));
	const wsOnly = endpoints.size - rest.size;
	const ours = new Set(ALL_DERIBIT_METHODS);

	console.log(
		`OpenAPI spec ${spec.info.version}: ${endpoints.size} endpoints (${wsOnly} of them WebSocket-only)`,
	);
	console.log(`This server: ${ALL_TOOLS.length} tools / ${ALL_DERIBIT_METHODS.length} methods`);
	console.log(`Aligned release: ${DERIBIT_API_RELEASE} (server version ${SERVER_VERSION})`);
	console.log("");

	let breaking = false;

	// 0. Version self-consistency: the minor segment must be the aligned changelog
	//    date, otherwise the version number lies
	const expectedPrefix = `2.${DERIBIT_API_RELEASE_COMPACT}.`;
	if (!SERVER_VERSION.startsWith(expectedPrefix)) {
		breaking = true;
		console.log(
			`❌ Version disagrees with DERIBIT_API_RELEASE: SERVER_VERSION=${SERVER_VERSION}, ` +
				`but ${DERIBIT_API_RELEASE} implies ${expectedPrefix}<local iteration>`,
		);
	} else {
		console.log("✅ The version's minor segment matches DERIBIT_API_RELEASE");
	}

	// 1. Methods we use that the spec no longer has
	const vanished = ALL_DERIBIT_METHODS.filter((method) => !endpoints.has(method));
	if (vanished.length > 0) {
		breaking = true;
		console.log("❌ The following methods vanished from the OpenAPI spec; their tools need attention:");
		for (const method of vanished) {
			const owners = ALL_TOOLS.filter((t) => t.methods.includes(method)).map((t) => t.name);
			console.log(`   - ${method}  (used by: ${owners.join(", ") || "the client itself"})`);
		}
	} else {
		console.log("✅ Every method in use is still present in the OpenAPI spec");
	}

	// 2. Uncovered REST endpoints
	const byTag = new Map();
	for (const [method, meta] of rest) {
		if (!byTag.has(meta.tag)) byTag.set(meta.tag, { covered: [], missing: [] });
		byTag.get(meta.tag)[ours.has(method) ? "covered" : "missing"].push(method);
	}
	const sortedTags = [...byTag.entries()].sort(
		(a, b) => b[1].missing.length - a[1].missing.length || a[0].localeCompare(b[0]),
	);
	const coveredCount = [...ours].filter((m) => rest.has(m)).length;
	const missingCount = rest.size - coveredCount;

	console.log("");
	console.log(`ℹ️  REST endpoint coverage: ${coveredCount}/${rest.size}, ${missingCount} not implemented`);
	console.log(`    ${"Category".padEnd(24)}${"done".padStart(6)}${"missing".padStart(8)}`);
	for (const [tag, bucket] of sortedTags) {
		console.log(
			`    ${tag.padEnd(24)}${String(bucket.covered.length).padStart(6)}` +
				`${String(bucket.missing.length).padStart(8)}`,
		);
	}

	// Gaps inside the target categories, plus any uncovered public endpoint in any
	// category (public endpoints need no credentials, so they are the cheapest to add
	// and the most valuable to notice — hence they bypass the category filter)
	const gaps = [...rest.keys()]
		.filter((method) => !ours.has(method) && !INTENTIONALLY_SKIPPED.has(method))
		.filter((method) => TARGET_TAGS.has(rest.get(method).tag) || method.startsWith("public/"));
	console.log("");
	if (gaps.length > 0) {
		console.log(
			`ℹ️  ${gaps.length} endpoints across the target categories + public endpoints are uncovered (does not affect the exit code):`,
		);
		for (const method of gaps) {
			console.log(`   - ${method.padEnd(46)} ${rest.get(method).summary.slice(0, 70)}`);
		}
	} else {
		console.log("✅ Target categories and public endpoints are fully covered (deliberate skips aside)");
	}

	// 3. Changelog entries newer than the aligned release
	const releases = parseReleases(changelog);
	const newer = releases.filter((iso) => iso > DERIBIT_API_RELEASE);
	console.log("");
	if (newer.length > 0) {
		breaking = true;
		console.log(`❌ The changelog has ${newer.length} release(s) newer than ${DERIBIT_API_RELEASE}:`);
		for (const iso of newer) console.log(`   - ${iso}`);
		console.log("");
		console.log(`   Walk through ${CHANGELOG} entry by entry, then push DERIBIT_API_RELEASE and the`);
		console.log(
			`   minor segment of SERVER_VERSION in src/version.ts to ${newer[0].replaceAll("-", "")} together, resetting the patch to zero.`,
		);
	} else {
		console.log(`✅ The newest changelog release is still ${releases[0]}, matching this server`);
	}

	if (write) {
		writeFileSync(
			"docs/API-COVERAGE.md",
			renderCoverage(endpoints, docLinks, {
				specVersion: spec.info.version,
				restTotal: rest.size,
				wsOnly,
				covered: coveredCount,
				missing: missingCount,
				byTag: sortedTags,
			}),
		);
		console.log("\nRegenerated docs/API-COVERAGE.md");
	}

	process.exit(breaking ? 1 : 0);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
