# Railguey

Cloudflare Worker MCP server that bridges Grok to the Railway GraphQL API.

Railway’s hosted MCP (`mcp.railway.com`) is OAuth/CLI-shaped. Grok custom connectors want a public Streamable HTTP URL plus a static bearer header. Railguey is that URL.

## Pairing (claim codes)

Railway tokens never go through Grok chat. Pairing is a device-code flow:

1. Grok calls `account_pair_begin` (or a code is minted here).
2. You open `/pair/<CODE>` on this worker.
3. Paste a Railway token and give the account a slug (`eidos`, `personal`, `client-acme`).
4. The worker validates the token against Railway, stores it in KV, and Grok sees it via `account_list`.

Codes expire in 10 minutes, are single-use, and burn after 8 failed pastes.

Account tokens (`railway.com/account/tokens`), workspace tokens, and project tokens (Project → Settings → Tokens) are all accepted. Kind is recorded so Grok knows the scope.

## Multiple accounts

Each pair is a named slot. Railway tools take an optional `account` slug. One slot is the default.

This matches the Python railguey model (`~/.railguey/accounts.json`) — named accounts, one default — stored in Workers KV instead of a home directory.

## Endpoints

- `GET /` — status page
- `GET /health` — JSON health (no secrets; includes paired account metadata)
- `GET /pair` — enter a claim code
- `GET|POST /pair/:code` — paste a Railway token
- `POST /mcp` — MCP Streamable HTTP (auth required)

Live: https://railguey.eidos-agi.workers.dev/mcp

## Secrets and bindings

- `MCP_AUTH_TOKEN` — bearer Grok sends as `Authorization: Bearer …`
- KV `ACCOUNTS` (`railguey-accounts`) — paired Railway tokens, claim codes, default slug

## Connect in Grok

1. grok.com/connectors → Add connector → Other
2. Server URL: `https://railguey.eidos-agi.workers.dev/mcp`
3. Header: `Authorization: Bearer <MCP_AUTH_TOKEN>`
4. Ask Grok to pair a Railway account, then open the claim URL it returns
