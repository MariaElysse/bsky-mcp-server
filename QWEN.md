# QWEN.md — Context for AI Interactions with bsky-mcp-server

## Project Overview

**bsky-mcp-server** is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that connects to [Bluesky](https://bsky.app/) via the ATProtocol. It exposes **23 tools** that allow LLM applications to interact with Bluesky — reading timelines, searching posts, managing follows, AI-preference filtering, mention handling, and more.

**Stack**: TypeScript (ESM, `nodenext` module resolution), Node.js 24, `@atproto/api`, `@modelcontextprotocol/sdk` (v1.7+), Zod for schema validation
**Package manager**: pnpm 12.3.4 (`"packageManager": "pnpm@12.3.4"`)
**Build output**: `build/src/` (compiled JS), `build/test/` (compiled tests)
**License**: MIT

## Directory Structure

```
src/
  index.ts              # Main entry point — stdio MCP server, Bluesky auth, server bootstrap
  tools.ts              # Core tool implementations (get-timeline-posts, search-posts, create-post, etc.) — ~2400 lines
  ai-preferences.ts     # AI preference reading/caching (community.lexicon.preference.ai records), batch checking, tombstone filtering
  link-preview.ts       # Link preview metadata fetching & thumbnail upload via cardyb
  llm-preprocessor.ts   # POST_FORMAT_SPEC post/thread formatting for LLM consumption (Markdown, XML attributes)
  mention-store.ts      # Persistent mention deduplication store (JSON file with atomic writes)
  thread-context.ts     # Thread context retrieval and formatting for mention context tool
  prompts.ts            # Prompt templates (mention reply generation)
  resources.ts          # MCP resource definitions
  utils.ts              # Shared utilities (cleanHandle, validateUri, response formatters, XML escaping)
  remote/               # Remote HTTP + OAuth mode
    index.ts            # Remote server entry point
    oauth-bluesky.ts    # Bluesky OAuth flow
    oauth-mcp.ts        # MCP OAuth flow
    server.ts           # HTTP server implementation
    storage.ts          # Session/token persistence
  scripts/              # Development/utility scripts
test/                   # Test suites (plain Node.js ESM scripts, not Jest/Mocha)
deploy/                 # Deployment artifacts (systemd, Caddyfile)
.github/workflows/      # CI pipeline
```

## Key Files & Their Roles

| File | Purpose | Lines |
|------|---------|-------|
| `src/index.ts` | Server bootstrap, stdio transport, Bluesky auth, environment loading, MCP registration | ~260 |
| `src/tools.ts` | All 23 tool handlers — pagination, AI preference filtering, link preview, thread context, rich text facets | ~2400 |
| `src/ai-preferences.ts` | Reads/writes AI preference records, cached per-DID (5 min TTL), batch-checking, tombstone replacement | ~350 |
| `src/llm-preprocessor.ts` | Converts Bluesky API responses to LLM-friendly formats (POST_FORMAT_SPEC), facet-to-markdown, thread formatting | ~1480 |
| `src/mention-store.ts` | JSON file-backed store for mention deduplication with atomic writes and concurrency locking | ~340 |
| `src/thread-context.ts` | Fetches full conversation threads for mentioned posts, AI-preference filtering | ~380 |
| `src/link-preview.ts` | Fetches URL metadata via cardyb, uploads thumbnails to Bluesky | — |
| `src/utils.ts` | `cleanHandle()`, `validateUri()`, `mcpSuccessResponse()`, `mcpErrorResponse()`, `escapeXml()` | ~350 |
| `test/final-test.ts` | Orchestrator that runs all 12 test suites sequentially | ~70 |
| `test/pagination.test.ts` | 23 tests covering auto-fetch, cursor mode, hours mode, edge cases | ~800 |
| `tsconfig.json` | ES2020 target, nodenext modules, strict mode, excludes remote/ and some test files | — |
| `Dockerfile` | Multi-stage build: install pnpm, install deps, compile TS | — |

## Building, Running & Testing

```bash
# Install dependencies
pnpm install

# Build (compiles TypeScript, creates build/test/ dir)
pnpm run build

# Run the stdio MCP server
pnpm run start

# Run dev (build + run in one step)
pnpm run dev

# Full test suite — builds then runs all 12 test suites
pnpm run test

# Individual test suites
pnpm run test:register-tools    # Tool registration (8 tests)
pnpm run test:remote            # Remote OAuth tests (7 tests)
pnpm run test:get-thread        # Post-thread tool test
pnpm run test:url-converter     # URL converter test
pnpm run test:link-preview      # Link preview test
```

**CI**: GitHub Actions (`.github/workflows/ci.yml`) runs on push/PR to `main`: checkout → pnpm 12.3.4 → Node 24 → install → build → test.

## Architecture & Patterns

### Server Lifecycle
1. **Bootstrap**: Create `McpServer` instance, register resources/prompts/tools
2. **Auth**: `initializeBlueskyConnection()` creates `AtpAgent`, logs in via `BLUESKY_IDENTIFIER` + `BLUESKY_APP_PASSWORD`
3. **Transport**: Connects via `StdioServerTransport` (stdio mode) or HTTP (remote OAuth mode)
4. **Tool handlers**: All tools resolve the agent lazily via `() => agent` provider pattern

### Tool Registration
- **Core tools** (23): Registered in `src/tools.ts` via `registerTools(server, getAgent)`
- **Additional tools**: Registered directly in `src/index.ts` on the server instance
- Each tool takes a Zod schema for params and returns `mcpSuccessResponse()` or `mcpErrorResponse()`

### AI Preference System
- Preferences stored as `community.lexicon.preference.ai` records in user's repo
- Categories: `inference`, `training`, `syntheticContent`, `embedding`
- Cached per-DID for 5 minutes (`PREF_CACHE_TTL_MS = 5 * 60 * 1000`)
- `batchCheckAiPreferences()` checks multiple DIDs in one API call
- Denied posts are replaced with **tombstones** (preserving feed order) via `filterPostsByAiPreferences()`
- AI preference filtering is **mandatory**: any tool fetching user content (timelines, feeds, search, likes, notifications) must filter by AI preferences

### Pagination (Cursor-Based)
- 6 tools support cursor-based pagination: `get-timeline-posts`, `get-feed-posts`, `get-list-posts`, `get-user-posts`, `get-liked-posts`, `get-notifications`
- **Auto-fetch mode** (no cursor): fetches up to `count` posts via internal pagination, signals `nextCursor` in response if more available
- **Cursor mode** (cursor provided): fetches single page starting from cursor, returns up to `count` posts
- **Hours-based mode** (`type: "hours"`): ignores cursor, fetches fresh results for time window
- Max total posts capped at 500 (`MAX_TOTAL_POSTS`)
- Default count/limit: 20

### Response Formatting
- `llm-preprocessor.ts` implements the POST_FORMAT_SPEC for LLM consumption
- Converts Bluesky facets → Markdown links/mentions
- Thread formatting with parent/child relationships, AI preference filtering with tombstones
- Supports custom `BSKY_WEB_URL` for non-default Bluesky frontends

## Environment Variables

| Variable | Required | Mode | Description |
|----------|----------|------|-------------|
| `BLUESKY_IDENTIFIER` | Yes (stdio) | stdio | Bluesky handle or DID |
| `BLUESKY_APP_PASSWORD` | Yes (stdio) | stdio | App password from Bluesky settings |
| `BLUESKY_SERVICE_URL` | Yes | Both | AT Protocol service URL (e.g., `https://bsky.social`) |
| `BLUESKY_WEB_URL` | No | Both | Web frontend base URL for link formatting (default: `https://bsky.app`) |
| `MENTION_STORE_PATH` | No | Both | Custom path for mention deduplication JSON store |
| `REMOTE_HOST` | No | Remote | Bind host (default: localhost) |
| `REMOTE_PORT` | No | Remote | Bind port (default: 3000) |
| `PUBLIC_URL` | Yes | Remote | Public-facing URL for OAuth redirects |
| `DATA_DIR` | No | Remote | Persistent data directory (default: `/var/lib/bsky-mcp`) |
| `PORT` | No | Remote | HTTP port (default: 8787) |

## Testing Conventions

- **No Jest/Mocha** — tests are plain Node.js ESM scripts run directly via `node`
- Each test file is self-contained and runs against the **compiled** output in `build/test/`
- The orchestrator (`test/final-test.ts`) runs all suites sequentially, printing per-suite pass/fail and a summary
- Test suites (12 total, 171 tests):
  1. `register-tools` — tool registration, error handling, agent resolution
  2. `url-converter` — Bluesky URL to AT URI parsing
  3. `link-preview` — cardyb extraction, thumbnail upload, error cases
  4. `ai-preferences` — flatten/unflatten, batch check, filter, integration with tools
  5. `ai-preferences-tombstone` — tombstone replacement, thread filtering, XML format
  6. `mention-store` — CRUD, atomic writes, concurrency, cleanup, persistence
  7. `thread-context` — thread fetching, participant extraction, formatting
  8. `mention-context` — mention tool, dedup, AI filtering
  9. `mention-monitor` — poll, auto-reply, dedup across runs
  10. `create-reply` — reply creation, URI validation, facets, dedup
  11. `custom-endpoint` — custom Bluesky frontend URL parsing
  12. `pagination` — auto-fetch, cursor mode, hours mode, edge cases

## Development Conventions

- **Indentation**: 2 spaces
- **Quotes**: Single quotes for code, double quotes in tool descriptions (shown to LLM clients)
- **Naming**: camelCase for variables/functions, PascalCase for types/interfaces
- **Error handling**: Try/catch around all API calls, return `mcpErrorResponse()` with descriptive messages
- **Response format**: Use `mcpSuccessResponse()` / `mcpErrorResponse()` from `utils.ts`
- **Limits**: Impose reasonable limits (e.g., `MAX_TOTAL_POSTS = 500`, `MAX_BATCH_SIZE = 100`)
- **Comments**: JSDoc-style for exported functions, inline comments for complex logic
- **No drive-by refactors**: Only touch what the task requires
- **Git trailer**: Every commit must include `Assisted-by: <model> via <agent>`

## Adding a New Tool — Checklist

1. Add tool registration in `src/tools.ts` (or `src/index.ts` for non-core tools)
2. Implement the handler with proper error handling via try/catch + `mcpErrorResponse()`
3. Add AI preference filtering if fetching user content (call `batchCheckAiPreferences()` + `filterPostsByAiPreferences()`)
4. Update README.md with tool description and categorization
5. Add tests in `test/` (or add to existing test suite)
6. Add test runner entry in `test/final-test.ts` if it's a new suite
7. Run `pnpm run test` — all 12 suites must pass

## Remote OAuth Mode

Alternative to stdio mode for scenarios where stdio isn't practical:
- Starts via: `PUBLIC_URL=http://localhost:8787 node build/src/remote/index.js`
- Handles Bluesky OAuth dance automatically (redirects to Bluesky auth, exchanges code for tokens)
- Persists sessions/tokens in SQLite via `src/remote/storage.ts`
- JWT-authenticated HTTP API exposing the same tools
- Deployment artifacts in `deploy/` (systemd unit, Caddyfile)

## Docker

```bash
# Build the image
docker build -t bsky-mcp-server .

# Run (requires env vars for Bluesky auth)
docker run --env BLUESKY_IDENTIFIER=... --env BLUESKY_APP_PASSWORD=... --env BLUESKY_SERVICE_URL=... bsky-mcp-server
```

The Dockerfile uses `node:lts-alpine`, installs pnpm globally, copies all source, and runs `pnpm run build`.
