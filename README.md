# deribit-mcp

Bring [Deribit](https://www.deribit.com) into your AI assistant. Works with Claude Code, Codex
and any other MCP client — one command to install, and your assistant can read markets, inspect
your account and manage orders.

```bash
claude mcp add deribit -- npx -y deribit-mcp
```

Once it is installed you can ask things like "what does the BTC option chain look like right now?",
"show me the implied volatility on the March calls" or "how much free margin is left in my account?".

**Two safety defaults**: it connects to **testnet** by default, and **trading is off** by default.
Placing a real order requires you to turn both on explicitly.

---

## Installation

### Claude Code

For market data only, no configuration is needed:

```bash
claude mcp add deribit -- npx -y deribit-mcp
```

To query your account and orders, add API credentials and switch to mainnet:

```bash
claude mcp add deribit \
  --env DERIBIT_ENV=prod \
  --env DERIBIT_CLIENT_ID=your_client_id \
  --env DERIBIT_CLIENT_SECRET=your_client_secret \
  -- npx -y deribit-mcp
```

### Codex

Edit `~/.codex/config.toml` (or the project's `.codex/config.toml`):

```toml
[mcp_servers.deribit]
command = "npx"
args = ["-y", "deribit-mcp"]

[mcp_servers.deribit.env]
DERIBIT_ENV = "prod"
DERIBIT_CLIENT_ID = "your_client_id"
DERIBIT_CLIENT_SECRET = "your_client_secret"
```

### Other MCP clients

Any client that speaks stdio works. The command is `npx -y deribit-mcp`, and configuration is
passed through environment variables.

### Running from source (optional)

To pin a specific revision, or if you have modified the code yourself, you can point the client
straight at the sources and skip having to remember to rebuild after every change:

```bash
git clone https://github.com/freeeverett/deribit-mcp.git
cd deribit-mcp && npm install
```

```toml
[mcp_servers.deribit]
command = "npx"
args = ["tsx", "/absolute/path/deribit-mcp/src/index.ts"]
```

The cost is roughly twice the startup time (about 160ms vs 77ms) and a local dependency install.
For everyday use, `npx -y deribit-mcp` is still the recommendation.

### Getting API credentials

Create a key under [Deribit account settings → API](https://www.deribit.com/account/BTC/api).

| What you want to do | Permission the key needs |
| --- | --- |
| Read public market data only | no key required |
| Query account, positions, orders and fills | `trade:read` |
| Place, edit, cancel and close | `trade:read_write` |

Prefer least privilege: **if you only want the assistant to analyse things, `trade:read` is enough**,
and then no order can be placed even if the trading switch is turned on by mistake.

---

## Configuration

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `DERIBIT_ENV` | `test` | `test` for testnet, `prod` for mainnet |
| `DERIBIT_CLIENT_ID` | — | API key. Without it, only the public market data tools are available |
| `DERIBIT_CLIENT_SECRET` | — | API secret; must be set together with `DERIBIT_CLIENT_ID` |
| `DERIBIT_ENABLE_TRADING` | `false` | Set to `true` to expose place / edit / cancel / close |
| `DERIBIT_API_BASE` | — | Custom endpoint; rarely needed |

> **Testnet is a separate world**: accounts and API keys on `test.deribit.com` do not work on
> mainnet at all, so you need to register separately at [test.deribit.com](https://test.deribit.com).
> Testnet hands out free test coins, which makes it the right place to rehearse a workflow before
> switching to mainnet.

### Full testnet integration suite

Create a git-ignored `.env.test` in the project root containing testnet API credentials only:

```dotenv
DERIBIT_CLIENT_ID=your_testnet_client_id
DERIBIT_CLIENT_SECRET=your_testnet_client_secret
```

Then run:

```bash
npm run test:all
```

That entry point reads `.env.test` natively and **forces the connection to testnet** (it will not
adopt a mainnet or custom endpoint from the file). It drives all 39 tools through a real stdio MCP
client and requires a key with `trade:read_write`: it creates, edits and cancels a limit order
carrying a unique test label, briefly opens and closes a market position, and creates a test combo.
On exit the script cancels anything left under that label, and the command fails if that cleanup
fails. `npm test` remains the fast public-endpoint regression that needs no credentials.

---

## About the trading tools

The order-placing tools are **not exposed by default** — without `DERIBIT_ENABLE_TRADING=true`
your assistant cannot even see them, so it cannot trip over them.

Once enabled you get: place order, edit order, cancel order, close position, create combo instrument.

**Please understand**:

- These operations produce **real fills** on your real account, with real money
- Rehearse on testnet first, then consider mainnet
- On mainnet with trading enabled the server prints an explicit warning at startup, and the
  assistant is instructed that it must confirm with you before executing
- But the final gate is you: **when an order request appears, read it carefully before approving**

If you only want analysis and would rather the assistant never touched your orders, leave the switch
off — market data and account queries are entirely unaffected.

---

## What it can do

39 tools in total.

### Market data (18, no credentials needed)

Instrument and currency listings, contract specifications, expirations, **option chains**
(open interest / implied volatility / bid-ask), live quotes and order book depth, **option Greeks**,
historical candles, mark price history, index spot and history, historical realised volatility,
the **DVOL volatility index**, perpetual funding rates, market-wide trades, exchange volumes,
yield-bearing token APR, delivery prices, settlement and bankruptcy records, combo instruments,
platform status and exchange announcements.

### Account and orders (16, credentials required)

Account equity and margin, all-currency overview and account locks, position details, subaccount
listing, **portfolio margin simulation**, transaction log, settlement and delivery records,
deposit/withdrawal/transfer history, open orders, order state, order history, trigger order history,
fill details, per-order fills, and order margin estimation.

### Trading (5, credentials required and explicitly enabled)

Place order (limit / market / stop / take-profit / trailing stop / iceberg / advanced option
pricing), edit order, cancel order, close position, create multi-leg combo instrument.

---

## API coverage

How this server maps onto the official Deribit API, by the categories the official specification
uses. It covers 81 of the 172 REST endpoints.

| Category | Status |
| --- | --- |
| Market Data | **fully implemented** (30/30) |
| Combo Books | **fully implemented** (5/5) |
| Trading | **implemented except market-maker features** (29/37) — no MMP configuration/status/reset, no `mass_quote` / `cancel_quotes`, and `move_positions` is deliberately not exposed |
| Supporting | **implemented** — `public/status` and `public/get_time`; `public/test` is skipped as redundant |
| Authentication | **`public/auth` only** — `exchange_token` and `fork_token` are not implemented |
| Account Management | **read-only queries only** (11/41) — summaries, positions, subaccount listing, transaction log, portfolio simulation. No subaccount or API key management |
| Wallet | **read-only history only** (3/21) — transfers, deposits, withdrawals. Executing a deposit, withdrawal or transfer is not implemented |
| Block Trade | not implemented |
| Block RFQ | not implemented |
| Liquidity Support Program (lsp) | not implemented |
| Session Management | not implemented |

A further 10 endpoints are WebSocket-only (subscriptions and session management) and are out of
scope for a stdio JSON-RPC server.

The endpoint-level breakdown, including which tool calls which method, lives in
[`docs/API-COVERAGE.md`](docs/API-COVERAGE.md).

---

## Reading the version number

A version looks like `2.20260818.0`:

- `2` — the Deribit API major version (v2)
- `20260818` — the Deribit documentation release this is aligned to (2026-08-18)
- `0` — the nth revision against that documentation release

In other words, **the middle segment tells you which day's Deribit documentation a release tracks**.
When Deribit changes the API, this project follows by pushing that middle segment to the new date.

---

## FAQ

**The assistant says it cannot find the Deribit tools.**
Check the client's MCP log. At startup the server writes the current environment, credential status
and the number of registered tools to stderr, which usually makes it obvious whether the
configuration took effect.

**I only see the market data tools; the account tools are missing.**
The credentials were not picked up. Confirm that **both** `DERIBIT_CLIENT_ID` and
`DERIBIT_CLIENT_SECRET` are set — with only one of them the server fails to start and says which
one is missing.

**I cannot see the order-placing tools.**
They need `DERIBIT_ENABLE_TRADING=true` plus configured credentials. That default is deliberate.

**I get `invalid_credentials`.**
The key or secret is wrong, or you are using a testnet key against mainnet (or vice versa).
Accounts are not shared between the two.

**I get an error about an insufficient scope.**
The API key lacks `trade:read_write`. The server raises this **before** placing an order rather than
letting you believe one went out. Grant the permission in the Deribit dashboard, or turn the trading
switch off.

**I changed the configuration and nothing happened.**
The MCP server is launched by the client at startup, so restart the client after changing
environment variables.

---

## License

MIT
