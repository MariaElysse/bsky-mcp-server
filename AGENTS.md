# AGENTS.md — Guide for AI Agents Working on bsky-mcp-server

## Project Overview

**bsky-mcp-server** is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that connects to [Bluesky](https://bsky.app/) via the ATProtocol. It exposes **28 tools** for LLM applications to interact with Bluesky — reading timelines, searching posts, managing follows, AI-preference filtering, mention handling, and more.

**Stack**: TypeScript (ESM, `nodenext` module resolution), Node.js 24, `@atproto/api`, `@modelcontextprotocol/sdk` (v1.7+), Zod for schema validation
**Package manager**: pnpm 12.3.4 (`packageManager: pnpm@12.3.4`)
**Build output**: `build/src/` (compiled JS), `build/test/` (compiled tests)
**License**: MIT

## Directory Structure

```
src/
  index.ts              # Main entry point — stdio MCP server, Bluesky auth, server bootstrap
  tools.ts              # Core tool implementations (get-timeline-posts, search-posts, create-post, etc.) — ~2400 lines
  ai-preferences.ts     # AI preference reading/caching (community.lexicon.preference.ai records), batch checking, tombstone filtering
  link-preview.ts       # Link preview metadata fetching & thumbnail upload via cardyb
  llm-preprocessor.ts   # Post/thread formatting per docs/post-format-spec.md (Markdown, XML attributes)
  mention-store.ts      # Persistent mention deduplication store (JSON file with atomic writes)
  thread-context.ts     # Thread context retrieval and formatting for mention context tool
  prompts.ts            # Prompt templates (mention reply generation)
  resources.ts          # MCP resource definitions
  utils.ts              # Shared utilities (cleanHandle, validateUri, response formatters, XML escaping)
  scripts/              # Development/utility scripts
test/                   # Test suites (plain Node.js ESM scripts, not Jest/Mocha)
docs/                   # Project documentation (post-format-spec.md)
.github/workflows/      # CI pipeline (GitHub Actions)
```

## Key Files to Know

| File | Purpose | Lines |
|------|---------|-------|
| `src/index.ts` | Server bootstrap, stdio transport, Bluesky auth, environment loading, MCP registration | ~260 |
| `src/tools.ts` | All 26 tool handlers — pagination, AI preference filtering, link preview, thread context, rich text facets | ~2460 |
| `src/ai-preferences.ts` | AI preference system: reads/writes `community.lexicon.preference.ai` records, caches per-DID (5 min TTL), batch-checking, tombstone replacement | ~350 |
| `src/mention-store.ts` | Persistent mention deduplication store with JSON file backend, atomic writes, concurrency locking | ~450 |
| `src/thread-context.ts` | Thread context retrieval and formatting for mention context tool, AI-preference filtering | ~380 |
| `src/utils.ts` | Shared helpers: `cleanHandle()`, `validateUri()`, `mcpSuccessResponse()`, `mcpErrorResponse()`, `escapeXml()` | ~350 |
| `src/llm-preprocessor.ts` | Formats raw Bluesky API responses into LLM-friendly text (`docs/post-format-spec.md`), facet-to-markdown, thread formatting | ~1560 |
| `src/link-preview.ts` | Fetches URL metadata via cardyb, uploads thumbnails to Bluesky | — |
| `test/final-test.ts` | Orchestrator that runs all 12 test suites sequentially | ~70 |
| `test/pagination.test.ts` | 26 tests covering auto-fetch, cursor mode, hours mode, cursor-signal regressions | ~915 |
| `docs/post-format-spec.md` | The XML post/thread format every content tool emits | ~265 |
| `tsconfig.json` | ES2020 target, nodenext modules, strict mode. `"exclude": []` — everything under `src/`, `scripts/`, `test/` must compile | — |
| `Dockerfile` | Build: install pnpm, install deps, compile TS (uses `node:lts-alpine`) | — |

## Tool Registration

Tools are registered in two places:
1. **`src/tools.ts`** — Core tools via `registerTools(server, getAgent)` helper function
2. **`src/index.ts`** — Additional tools registered directly on the server instance

Each tool takes a Zod schema for params and returns `mcpSuccessResponse()` or `mcpErrorResponse()`.

To add a new tool:
- If it's a core Bluesky API tool, add it to `src/tools.ts` inside `registerTools()`
- If it's an account/config tool (AI preferences, resources), add it in `src/index.ts`
- Always update README.md with the new tool description

## Environment Variables

All variables are for the single stdio mode — the server listens on no port and reads no `PORT`/`HOST`/`PUBLIC_URL`/`DATA_DIR`.

| Variable | Required | Description |
|----------|----------|-------------|
| `BLUESKY_IDENTIFIER` | Yes | Bluesky handle or DID |
| `BLUESKY_APP_PASSWORD` | Yes | App password from Bluesky settings |
| `BLUESKY_SERVICE_URL` | Yes | AT Protocol service URL (e.g., `https://bsky.social`) |
| `BLUESKY_WEB_URL` | No | Web frontend base URL for link formatting (default: `https://bsky.app`) |
| `MENTION_STORE_PATH` | No | Custom path for mention deduplication JSON store |

## Build & Test Commands

```bash
pnpm install              # Install dependencies
pnpm run build            # Compile TypeScript + create build/test/ dir
pnpm run start            # Run the stdio MCP server
pnpm run dev              # Build and run in one step
pnpm run test             # Build, then run all 12 suites via test/final-test.ts

# Suites with their own package.json scripts:
pnpm run test:get-thread    # build/test/tools/test-get-post-thread.js
pnpm run test:url-converter # build/test/url-converter/test-url-converter.js

# Any other suite runs straight from the compiled output, e.g.:
node build/test/pagination.test.js
node build/test/link-preview/test-link-preview.js

# Example-data generators (rewrite test/*_examples_results.md):
pnpm run process-posts
pnpm run process-threads
```

`test/tools/test-get-post-thread.ts` is the one suite the orchestrator does not run — it only runs through `pnpm run test:get-thread`.

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`) runs on push/PR to `main`:
1. Checkout repository
2. Setup pnpm v12.3.4
3. Setup Node.js v24
4. `pnpm install`
5. `pnpm run build`
6. `pnpm run test`

`pnpm install` already runs with `--frozen-lockfile` by default in CI (pnpm enables it whenever `CI` is set and a lockfile is present), so editing `package.json` without committing a matching `pnpm-lock.yaml` fails the build instead of silently re-resolving.

## Testing Conventions

- Tests are plain Node.js ESM scripts in `test/` (not Jest/Mocha)
- Each test file is self-contained and runs against the built output in `build/test/`
- The orchestrator (`test/final-test.ts`) runs all test suites sequentially, printing per-suite pass/fail and a summary

**12 test suites (236 tests total — `pnpm run test` prints the live counts):**

1. `register-tools` — tool registration, error handling, agent resolution (19 tests)
2. `url-converter` — Bluesky URL to AT URI parsing (5 tests)
3. `link-preview` — cardyb extraction, thumbnail upload, error cases (11 tests)
4. `ai-preferences` — flatten/unflatten, batch check, filter, integration with tools (35 tests)
5. `ai-preferences-tombstone` — tombstone replacement, thread filtering, XML format, attribute escaping (21 tests)
6. `mention-store` — CRUD, atomic writes, concurrency, cleanup, persistence, `skipped` status (47 tests)
7. `thread-context` — thread fetching, participant extraction, formatting (20 tests)
8. `mention-context` — mention tool, dedup, AI filtering (14 tests)
9. `mention-monitor` — poll, auto-reply, dedup across runs (15 tests)
10. `create-reply` — reply creation, URI validation, facets, dedup (14 tests)
11. `custom-endpoint` — custom Bluesky frontend URL parsing (9 tests)
12. `pagination` — auto-fetch, cursor mode, hours mode, cursor-signal regressions (26 tests)

## AI Preference System

The AI preference system filters content based on user-configured preferences stored as `community.lexicon.preference.ai` records in the user's Bluesky repo.

**Categories:** `inference`, `training`, `syntheticContent`, `embedding`

**How it works:**
1. **Reading**: `fetchAiPreferences(agent, did)` fetches the user's preference record
2. **Caching**: Results cached per-DID for 5 minutes (`PREF_CACHE_TTL_MS = 5 * 60 * 1000`)
3. **Batch checking**: `batchCheckAiPreferences(agent, dids)` checks multiple DIDs in one API call
4. **Filtering**: `filterPostsByAiPreferences(posts, allowedMap)` replaces denied posts with **tombstones** (preserving feed order)
5. **Categories**: `inference`, `training` — read preferences; `syntheticContent`, `embedding` — display preferences

When modifying content-fetching tools, ensure they respect AI preferences via `batchCheckAiPreferences()` and `filterPostsByAiPreferences()`. AI preference filtering is **mandatory**: any tool that fetches user content (posts, timelines, searches, likes, notifications) must filter by AI preferences. No exceptions.

## Architecture & Patterns

### Server Lifecycle
1. **Bootstrap**: Create `McpServer` instance, register resources/prompts/tools
2. **Auth**: `initializeBlueskyConnection()` creates `AtpAgent`, logs in via `BLUESKY_IDENTIFIER` + `BLUESKY_APP_PASSWORD`
3. **Transport**: `StdioServerTransport` — stdio only, no port and no HTTP server
4. **Tool handlers**: All tools resolve the agent lazily via `() => agent` provider pattern

### Pagination (Cursor-Based)
6 tools support cursor-based pagination: `get-timeline-posts`, `get-feed-posts`, `get-list-posts`, `get-user-posts`, `get-liked-posts`, `get-notifications`

- **Auto-fetch mode** (no cursor): fetches pages sized to what is still needed (`Math.min(100, count - fetched)`), stopping when `count` is satisfied or the API stops returning a cursor
- **Cursor mode** (cursor provided): fetches single page starting from cursor, returns up to `count` posts
- **Cursor signal**: every pagination tool appends `[More posts available — pass cursor="…" to continue.]` whenever the API returned a cursor and the call produced results — **including when `count` was already satisfied**, so a caller can always resume instead of silently losing everything past the first page
- **Hours-based mode** (`type: "hours"`): ignores cursor, fetches fresh results for time window, and therefore never advertises a cursor
- Max total posts capped at 500 (`MAX_TOTAL_POSTS`)
- Default count/limit: 20

### Mention Deduplication Store

`src/mention-store.ts` tracks processed mentions by AT URI with statuses `pending`, `replied`, `failed`, `skipped`:

- `isHandled()` treats `pending` and `skipped` as **non-terminal**; `replied` and `failed` are terminal
- `skipped` is for policy skips (author opted out of AI inference/training): the mention is re-visited on a later poll, because preferences can flip
- Never record a policy opt-out as `failed` — that permanently suppresses the mention
- Display code reads `entry.reason` for skips (`entry.error` is for failures)

### Response Formatting
- `llm-preprocessor.ts` implements the post/thread format specified in `docs/post-format-spec.md`
- Converts Bluesky facets → Markdown links/mentions (uses `RichText` from `@atproto/api`)
- Thread formatting with parent/child relationships, AI preference filtering with tombstones
- Supports custom `BSKY_WEB_URL` for non-default Bluesky frontends

## Code Style Conventions

- **Indentation**: 2 spaces
- **Quotes**: Double quotes for strings in tool descriptions (shown to LLM clients), single quotes elsewhere
- **Naming**: camelCase for variables/functions, PascalCase for types/interfaces
- **Error handling**: Wrap API calls in try/catch, return `mcpErrorResponse()` with descriptive messages
- **Response format**: Use `mcpSuccessResponse()` / `mcpErrorResponse()` from `utils.ts`
- **Limits**: Impose reasonable limits on pagination (e.g., `MAX_TOTAL_POSTS = 500`, `MAX_BATCH_SIZE = 100`)
- **Comments**: JSDoc-style for exported functions, inline comments for complex logic
- **No drive-by refactors**: Only touch what the task requires. Don't rename variables or reformat unrelated code.

## Important Notes

1. **Tool descriptions matter**: These are shown to LLM clients — keep them clear and accurate.
2. **AI preferences are mandatory**: Any tool that fetches user content (posts, timelines, searches) must filter by AI preferences. No exceptions.
3. **ESM only**: This project uses `"type": "module"` in package.json. Use `.js` extensions in imports.
4. **Git trailer**: Every commit must include the trailer:
   `Assisted-by: <model> via <agent>`

## Adding a New Tool — Checklist

1. Add tool registration in `src/tools.ts` (or `src/index.ts` for non-core tools)
2. Implement the handler with proper error handling via try/catch + `mcpErrorResponse()`
3. Add AI preference filtering if fetching user content (call `batchCheckAiPreferences()` + `filterPostsByAiPreferences()`)
4. Update README.md with tool description and categorization
5. Add tests in `test/` (or add to existing test suite)
6. Add test runner entry in `test/final-test.ts` if it's a new suite
7. Run `pnpm run test` — all 12 suites must pass

## Transport

stdio only. `src/index.ts` logs in with `BLUESKY_IDENTIFIER` + `BLUESKY_APP_PASSWORD` and connects a `StdioServerTransport`; one process serves one MCP session over stdin/stdout and binds no port.

The upstream remote/OAuth mode is **not supported here**. `src/remote/`, `src/scripts/generate-signing-key.ts`, `test/remote-oauth.test.ts`, `Dockerfile.remote`, `.env.remote.example`, and `deploy/` were deleted: they were excluded from `tsconfig.json`, never compiled or run by CI, and their HTTP/OAuth dependencies (`express`, `better-sqlite3`, `@atproto/oauth-client-node`, `jose`) were never added to `package.json`, so they could not have started. Don't reintroduce an HTTP/OAuth transport unless the task also adds the dependencies, a compile target, tests, and CI coverage.

## Docker

```bash
# Build the image
docker build -t bsky-mcp-server .

# Run (requires env vars for Bluesky auth)
docker run --env BLUESKY_IDENTIFIER=... --env BLUESKY_APP_PASSWORD=... --env BLUESKY_SERVICE_URL=... bsky-mcp-server
```

The Dockerfile uses `node:lts-alpine`, installs pnpm globally, copies all source, and runs `pnpm run build`.

## Branching Workflow

- Pull from origin/main and merge upstream changes before starting work
- `main` -- stable baseline. Always keep up-to-date with origin/main
- Worktree branches (`wt/t_<task_id>`) -- isolated branches for kanban tasks.
- Merges happen via the kanban board workflow.
