# Multigmail

Remote [Model Context Protocol](https://modelcontextprotocol.io) connector that lets **Claude** use **multiple Google accounts** for **Gmail**, **Calendar**, and **Drive** from one connection.

Claude’s built-in Workspace connectors bind to a single Google identity. Multigmail stores per-alias refresh tokens behind one Claude OAuth connection so you can ask things like “what’s free across personal and work this week?”

Works with Claude.ai, Claude Desktop, and Claude mobile when installed as a **custom connector**.

## Architecture

1. **Claude → this Worker**: OAuth 2.1 (DCR + PKCE) via `@cloudflare/workers-oauth-provider`.
2. **Worker → Google**: separate OAuth per account alias (`personal`, `work`, …) with Gmail + Calendar + Drive scopes.
3. Tokens for Google accounts are **encrypted** in Workers KV.

MCP endpoint: `https://<your-worker>.workers.dev/mcp`

## Tools

| Area | Tools |
|------|--------|
| Accounts | `list_accounts`, `add_account`, `remove_account` |
| Gmail | `search_emails`, `get_email`, `get_thread`, `list_labels`, `modify_labels`, `create_draft`, `send_email`, `archive_email`, `trash_email` |
| Calendar | `list_calendars`, `list_events`, `get_event`, `create_event`, `update_event`, `delete_event`, `freebusy`, `respond_event` |
| Drive | `drive_search`, `drive_get_file`, `drive_list_folder`, `drive_create_folder`, `drive_trash` |

Read/query tools accept `account: "all"` to fan out across every linked account. Write tools require a specific alias.

## Prerequisites

- Node 20+
- Cloudflare account (Workers + KV)
- Google Cloud project with Gmail, Calendar, and Drive APIs (see [scripts/setup-google.md](scripts/setup-google.md))
- Claude plan that supports custom remote connectors (Pro / Max / Team / Enterprise)

## Local development

```bash
pnpm install
cp .dev.vars.example .dev.vars   # fill in Google OAuth + encryption key
pnpm exec wrangler kv namespace create OAUTH_KV
pnpm exec wrangler kv namespace create TOKEN_STORE
# put the returned ids into wrangler.toml (and create preview namespaces if prompted)
pnpm dev
```

For Claude to reach your laptop, tunnel the Worker:

```bash
# example
cloudflared tunnel --url http://localhost:8787
# set WORKER_URL in .dev.vars to the https tunnel origin, then restart pnpm dev
```

In Claude: **Settings → Connectors → Add custom connector** → URL `https://<tunnel>/mcp`.

## Deploy

```bash
pnpm exec wrangler kv namespace create OAUTH_KV
pnpm exec wrangler kv namespace create TOKEN_STORE
# update wrangler.toml binding ids

pnpm exec wrangler secret put GOOGLE_CLIENT_ID
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET
pnpm exec wrangler secret put COOKIE_ENCRYPTION_KEY
pnpm exec wrangler secret put WORKER_URL   # e.g. https://multigmail.<account>.workers.dev

pnpm deploy
```

Add the production redirect URI in Google Cloud: `https://<worker>/callback`.

Then in Claude add the custom connector pointing at `https://<worker>/mcp`.

## First-time use

1. Connect the connector in Claude (approve Multigmail, then sign in with Google for the first account).
2. Call `add_account` with alias `work` (or another name) and open the returned URL to link more accounts.
3. Confirm with `list_accounts`.
4. Try:

   - `freebusy` with `account: "all"`
   - `list_events` with `account: "all"`
   - `search_emails` with `account: "all"`

## Security & privacy

- Refresh tokens are AES-GCM encrypted at rest in your Cloudflare KV.
- This Worker is under **your** Cloudflare account; Claude talks to you, then you talk to Google.
- Revoke access anytime: `remove_account` plus [Google Account → Third-party access](https://myaccount.google.com/permissions).

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Local Wrangler |
| `pnpm deploy` | Deploy Worker |
| `pnpm type-check` | TypeScript |
| `pnpm test` | Unit tests |

## License

Private / use at your own risk unless you add a license.
