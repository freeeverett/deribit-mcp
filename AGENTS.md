# AGENTS.md

A local stdio MCP server for the Deribit JSON-RPC v2 API. `src/` is the only implementation; `dist/` is build output.

## Commands

```bash
npm run dev         # run the sources directly via tsx, no build (development only)
npm run build       # tsc -> dist/
npm run typecheck
npm test            # = npm run smoke
npm run smoke       # real stdio client + testnet regression, needs no credentials
npm run check:api   # documentation drift detection; exit 1 = time to bump the version
npm run docs:coverage
```

Run at least `npm test` after any code change.

`tsx` is a devDependency only. **The published artifact must be compiled JS**, and `bin` points at `dist/index.js`: tsx drags startup from 77ms to 160ms (an MCP client launches the server once per session), grows a cold install from 24MB to 35MB (esbuild ships 26 platform binaries, and environments such as Alpine/musl then fail to run at all), and it bypasses the `prepublishOnly` type check, letting type errors ship silently to users' machines.

## Non-negotiable conventions

1. **stdout carries JSON-RPC only.** Every human-facing message goes to `process.stderr`. One extra stdout line breaks client parsing.
2. **Writes are never retried.** `privateCall(..., { readOnly: false })` sends exactly once. A replay is one extra real order.
3. **Deribit's error responses come back as HTTP 400 and carry no `id`.** So the `id` is validated on successful responses only, and the body must be parsed before the status code is inspected. Keep this rule when editing `src/deribit/client.ts` — losing it degrades every business error into a useless id-mismatch message.
4. **Handlers throw plain `Error` / `InvalidParamsError`**, which the SDK wraps into an `isError: true` tool result the model can read and retry from. **Do not throw `McpError`**: that becomes a protocol error, which most clients render as a bare "call failed".
5. **Every tool must declare `methods: [...]`.** It is the single source of truth `check:api` reconciles against, so a changed call must be mirrored there.
6. **Declare no `outputSchema` and return no `structuredContent`.** Only a single text block. Responses such as an option chain are already large, and a structured copy would double the payload.
7. **Cross-field constraints live in the handler**, not in a Zod `.superRefine()` — that keeps the error message under our control and delivers it as an `isError` result to the model.

## Version numbering

`2.<changelog date>.<local iteration>`, e.g. `2.20260818.0`. The minor segment must equal `DERIBIT_API_RELEASE` in `src/version.ts` (`check:api` verifies this).

When the Deribit docs move (`check:api` exits 1): walk the [changelog](https://docs.deribit.com/changelogs/jsonrpc) entry by entry → fix the affected tools → push `DERIBIT_API_RELEASE` and the minor segment of `SERVER_VERSION` to the new date together and reset the patch to zero → `npm run docs:coverage`.

## Protocol version (get the user's consent before upgrading)

We currently depend on `@modelcontextprotocol/sdk@1.30.0`, whose highest offered protocol is **`2025-11-25`**.

The current version of the MCP specification is **`2026-07-28`**. The SDK was split into new packages on 2026-07-27 (`@modelcontextprotocol/{core,server,client,node,hono}@2.0.0`), and `core` carries `MODERN_WIRE_REVISION = "2026-07-28"`. **But the server half cannot actually offer that protocol.** What testing showed:

- Official 2.0 client against official 2.0 server: with `mode:'auto'` the `server/discover` probe gets `-32601 Method not found` and falls back to the legacy handshake; with `mode:{pin:'2026-07-28'}` the connection fails outright
- `server/discover` appears only in the client package, never once in the server package
- Supplying the handler ourselves via `setRequestHandler` was tried (`core` does export `DiscoverRequestSchema`): registration does not error but dispatch does not route to it, still `-32601`; `ServerOptions` has no switch to enable the modern era either
- The "no handshake + per-request `_meta` version" half does work; what is missing is precisely the mandatory `server/discover` entry point

**So staying on 1.x is not an oversight — there is no usable server-side implementation.**

### When to upgrade, and how

Once the official server package gains `server/discover` (to re-verify: install the latest `@modelcontextprotocol/server`, connect with the official client using `{ versionNegotiation: { mode: { pin: "2026-07-28" } } }`, and a successful connection means it is usable), **explain the change to the user and get their consent before starting the refactor** — do not upgrade on your own initiative. This is an explicit user requirement.

Costs to spell out when asking: package names and import paths all change, `setRequestHandler`'s signature goes from `(schema, handler)` to `(method, ...)`, tool handlers become `(args, ctx)`, and **the emitted JSON Schema moves from draft-07 to draft 2020-12** — that last one affects how Claude Code / Codex parse every tool schema and must be re-verified.

## Data source

The endpoint list comes from the official **OpenAPI specification** (`https://docs.deribit.com/specifications/deribit_openapi.json`). **Do not switch back to `llms.txt`**: that index is missing `private/get_currencies` (added 2026-07-21) and 4 LSP methods, and using it as the source of truth distorts drift detection. `llms.txt` is only used to look up documentation links.

## Scope

Covers Market Data / Trading / Combo Books / Supporting, plus **read-only** account and wallet queries. Deliberately not implemented: subaccount and API key management, deposits, withdrawals and transfers, Block Trade / Block RFQ, Market Maker Protection (MMP) and mass quoting, LSP, and the subscriptions and session management that are WebSocket-only. Deliberately skipped endpoints are recorded with their reasons in `INTENTIONALLY_SKIPPED` in `scripts/check-api-drift.mjs`.
