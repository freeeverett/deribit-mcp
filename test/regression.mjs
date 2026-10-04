/** Offline regressions: no credentials or exchange requests. Built sources only. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { DeribitClient } from "../dist/deribit/client.js";
import { DeribitApiError, InvalidParamsError } from "../dist/errors.js";
import { ALL_TOOLS } from "../dist/tools/index.js";

function mockFetch(t, handler) {
	const original = globalThis.fetch;
	globalThis.fetch = async (url, options) => handler(JSON.parse(options.body), options, url);
	t.after(() => { globalThis.fetch = original; });
}

function success(request, result) {
	return Response.json({ jsonrpc: "2.0", id: request.id, result });
}

function invalidToken() {
	// Business errors are HTTP 400 and intentionally have no id.
	return Response.json({ jsonrpc: "2.0", error: { code: 13009, message: "invalid_token" } }, { status: 400 });
}

function auth(request, number = 1) {
	return success(request, { access_token: `fake-token-${number}`, expires_in: 3600, scope: "trade:read_write" });
}

function privateClient() {
	return new DeribitClient(loadConfig({ DERIBIT_CLIENT_ID: "fake", DERIBIT_CLIENT_SECRET: "fake" }));
}

function brokenBody(error) {
	return new Response(new ReadableStream({ start(controller) { controller.error(error); } }));
}

async function invoke(name, args) {
	const tool = ALL_TOOLS.find((candidate) => candidate.name === name);
	assert.ok(tool);
	const calls = [];
	const client = { privateCall: async (method, params, options) => {
		calls.push({ method, params, options });
		return [];
	} };
	const payload = await tool.handler(client, tool.inputSchema.parse(args));
	return { calls, payload };
}

const cancelCases = [
	[{ cancel_all: true, kind: "option" }, { currency: "any", kind: "option" }],
	[{ cancel_all: true, order_type: "limit" }, { currency: "any", type: "limit" }],
	[{ cancel_all: true, kind: "option", order_type: "limit", detailed: true, freeze_quotes: false },
		{ currency: "any", kind: "option", type: "limit", detailed: true, freeze_quotes: false }],
];
for (const [args, params] of cancelCases) {
	test(`filtered cancel-all preserves its scope: ${JSON.stringify(args)}`, async () => {
		const { calls } = await invoke("deribit_cancel_order", args);
		assert.deepEqual(calls, [{ method: "private/cancel_all_by_kind_or_type", params,
			options: { scope: "trade:read_write", readOnly: false } }]);
	});
}

test("unfiltered cancel-all retains the full-cancel endpoint", async () => {
	const { calls } = await invoke("deribit_cancel_order", { cancel_all: true, detailed: true });
	assert.equal(calls[0].method, "private/cancel_all");
	assert.deepEqual(calls[0].params, { detailed: true });
});

test("invalid_token never replays a write, but invalidates the token for the next call", async (t) => {
	let authCount = 0;
	const writes = [];
	mockFetch(t, (request, options) => {
		if (request.method === "public/auth") return auth(request, ++authCount);
		writes.push(options.headers.Authorization);
		return writes.length === 1 ? invalidToken() : success(request, "next write");
	});
	const client = privateClient();
	await assert.rejects(client.privateCall("private/buy", {}, { scope: "trade:read_write", readOnly: false }),
		(error) => error instanceof DeribitApiError && error.code === 13009);
	assert.equal(authCount, 1);
	assert.deepEqual(writes, ["Bearer fake-token-1"]);
	assert.equal(await client.privateCall("private/buy", {}, { scope: "trade:read_write", readOnly: false }), "next write");
	assert.equal(authCount, 2);
	assert.deepEqual(writes, ["Bearer fake-token-1", "Bearer fake-token-2"]);
});

test("invalid_token refreshes and retries a private read once", async (t) => {
	let authCount = 0;
	let reads = 0;
	mockFetch(t, (request) => {
		if (request.method === "public/auth") return auth(request, ++authCount);
		return ++reads === 1 ? invalidToken() : success(request, "read result");
	});
	assert.equal(await privateClient().privateCall("private/get_positions", {}), "read result");
	assert.equal(authCount, 2);
	assert.equal(reads, 2);
});

test("a private read does not loop indefinitely on invalid_token", async (t) => {
	let authCount = 0;
	let reads = 0;
	mockFetch(t, (request) => {
		if (request.method === "public/auth") return auth(request, ++authCount);
		reads++;
		return invalidToken();
	});
	await assert.rejects(privateClient().privateCall("private/get_positions", {}),
		(error) => error instanceof DeribitApiError && error.code === 13009);
	assert.equal(authCount, 2);
	assert.equal(reads, 2);
});

const conflictingFilters = [
	{ instrument_name: "BTC-PERPETUAL", currency: "BTC", label: "my-orders" },
	{ instrument_name: "BTC-PERPETUAL", currency: "BTC" },
	{ instrument_name: "BTC-PERPETUAL", label: "my-orders" },
	{ instrument_name: "BTC-PERPETUAL", kind: "future" },
	{ currency: "BTC", label: "my-orders", kind: "future" },
	{ currency: "BTC", label: "my-orders", type: "limit" },
	{ label: "my-orders" },
	{ label: "" },
];
for (const args of conflictingFilters) {
	test(`active orders rejects unsupported filters before calling Deribit: ${JSON.stringify(args)}`, async () => {
		const tool = ALL_TOOLS.find((candidate) => candidate.name === "deribit_get_active_orders");
		let calls = 0;
		await assert.rejects(tool.handler({ privateCall: async () => { calls++; return []; } }, tool.inputSchema.parse(args)), InvalidParamsError);
		assert.equal(calls, 0);
	});
}

const validFilters = [
	[{ instrument_name: "BTC-PERPETUAL", type: "limit" }, "private/get_open_orders_by_instrument", { instrument_name: "BTC-PERPETUAL", type: "limit" }],
	[{ currency: "btc", label: "my-orders" }, "private/get_open_orders_by_label", { currency: "BTC", label: "my-orders" }],
	[{ currency: "btc", label: "" }, "private/get_open_orders_by_label", { currency: "BTC", label: "" }],
	[{ currency: "btc", kind: "future", type: "limit" }, "private/get_open_orders_by_currency", { currency: "BTC", kind: "future", type: "limit" }],
	[{ kind: "future", type: "limit" }, "private/get_open_orders", { kind: "future", type: "limit" }],
	[{}, "private/get_open_orders", {}],
];
for (const [args, method, params] of validFilters) {
	test(`active orders retains supported filters: ${JSON.stringify(args)}`, async () => {
		const { calls } = await invoke("deribit_get_active_orders", args);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].method, method);
		assert.deepEqual(calls[0].params, params);
	});
}

for (const error of [new DOMException("body timeout", "TimeoutError"), new TypeError("terminated", { cause: { code: "ECONNRESET" } })]) {
	test(`public read retries a transient response-body failure: ${error.name}`, async (t) => {
		let reads = 0;
		mockFetch(t, (request) => ++reads === 1 ? brokenBody(error) : success(request, 123));
		assert.equal(await new DeribitClient(loadConfig({})).publicCall("public/get_time", {}), 123);
		assert.equal(reads, 2);
	});
}

test("response-body retry stops at readAttempts", async (t) => {
	let reads = 0;
	const error = new DOMException("body timeout", "TimeoutError");
	mockFetch(t, () => { reads++; return brokenBody(error); });
	const config = loadConfig({});
	await assert.rejects(new DeribitClient(config).publicCall("public/get_time", {}), (actual) => actual === error);
	assert.equal(reads, config.readAttempts);
});

test("a non-transient response-body failure is not retried", async (t) => {
	let reads = 0;
	const error = new Error("unexpected body failure");
	mockFetch(t, () => { reads++; return brokenBody(error); });
	await assert.rejects(new DeribitClient(loadConfig({})).publicCall("public/get_time", {}), (actual) => actual === error);
	assert.equal(reads, 1);
});

test("a write with a response-body timeout is sent once", async (t) => {
	let writes = 0;
	const error = new DOMException("body timeout", "TimeoutError");
	mockFetch(t, (request) => {
		if (request.method === "public/auth") return auth(request);
		writes++;
		return brokenBody(error);
	});
	await assert.rejects(privateClient().privateCall("private/buy", {}, { readOnly: false }), (actual) => actual === error);
	assert.equal(writes, 1);
});

test("HTTP 400 business error without id preserves Deribit's reason", async (t) => {
	let calls = 0;
	mockFetch(t, () => {
		calls++;
		return Response.json({ error: { code: -32602, message: "Invalid params", data: { param: "instrument_name", reason: "wrong format" } } }, { status: 400 });
	});
	await assert.rejects(new DeribitClient(loadConfig({})).publicCall("public/ticker", {}),
		(error) => error instanceof DeribitApiError && error.code === -32602 && /wrong format/.test(error.message));
	assert.equal(calls, 1);
});
