# AGENTS.md — Guide for AI Agents Working on bsky-mcp-server

## Project Overview

This is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that connects to [Bluesky](https://bsky.app/) via the ATProtocol. It exposes 28 tools for LLM applications to interact with Bluesky — reading timelines, searching posts, managing follows, and more.

**Stack**: TypeScript (ESM), Node.js, `@atproto/api`, `@modelcontextprotocol/sdk`
**Package manager**: pnpm (`packageManager: pnpm@9.15.4`)
**Build output**: `build/src/` (compiled JS)

## Directory Structure

```
src/
  index.ts              # Main entry point — stdio server setup + remote OAuth tools
  tools.ts              # Core Bluesky API tool implementations (25 tools)
  ai-preferences.ts     # AI preference reading, caching, and post filtering
  ai-label-filter.ts    # AI label detection: post-level no-AI hashtags, self-applied labels, profile bio declarations
  link-preview.ts       # Link preview metadata fetching & thumbnail upload
  llm-preprocessor.ts   # Post/thread formatting for LLM consumption
  mention-store.ts      # Persistent mention deduplication store (JSON file backend)
  thread-context.ts     # Thread context retrieval and formatting
  prompts.ts            # Prompt templates
  resources.ts          # MCP resource definitions
  utils.ts              # Shared utilities (handle cleaning, URI validation, etc.)
  remote/               # Remote HTTP + OAuth mode
    index.ts            # Remote server entry point
    oauth-bluesky.ts    # Bluesky OAuth flow
    oauth-mcp.ts        # MCP OAuth flow
    server.ts           # HTTP server implementation
    storage.ts          # Session/token persistence
  scripts/              # Development/utility scripts
test/                   # Test suites (see "Testing" below)
deploy/                 # Deployment artifacts (systemd, Caddyfile)
```

## Key Files to Know

| File | Purpose |
|------|---------|
| `src/index.ts` | Main entry point. Registers stdio MCP server + remote OAuth tools. ~1600 lines. |
| `src/tools.ts` | Core tool implementations (get-timeline-posts, search-posts, create-post, etc.). ~2000 lines. |
| `src/ai-preferences.ts` | AI preference system: reads/writes `community.lexicon.preference.ai` records, caches per-DID, filters posts. |
| `src/ai-label-filter.ts` | AI label detection layer: post-level no-AI hashtags, self-applied labels, profile bio declarations. |
| `src/mention-store.ts` | Persistent mention deduplication store with JSON file backend. |
| `src/thread-context.ts` | Thread context retrieval and formatting for mention context tool. |
| `src/utils.ts` | Shared helpers: `cleanHandle()`, `validateUri()`, `convertBskyUrlToAtUri()`, response formatters. |
| `src/llm-preprocessor.ts` | Formats raw Bluesky API responses into LLM-friendly text (POST_FORMAT_SPEC). |

## Tool Registration

Tools are registered in two places:
1. **`src/tools.ts`** — Core tools via `registerTools(server, getAgent)` helper function
2. **`src/index.ts`** — Additional tools registered directly on the server instance

To add a new tool:
- If it's a core Bluesky API tool, add it to `src/tools.ts` inside `registerTools()`
- If it's a remote/OAuth-specific tool, add it in `src/index.ts` or the appropriate `remote/` file
- Always update README.md with the new tool description

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BLUESKY_IDENTIFIER` | Yes (stdio) | Bluesky handle or DID |
| `BLUESKY_APP_PASSWORD` | Yes (stdio) | App password from Bluesky settings |
| `BLUESKY_SERVICE_URL` | No | AT Protocol service URL (default: `https://bsky.social`) |

Remote mode variables:
| Variable | Required | Description |
|----------|----------|-------------|
| `REMOTE_HOST` | No | Bind host (default: localhost) |
| `REMOTE_PORT` | No | Bind port (default: 3000) |
| `CLIENT_ID` | Yes | OAuth client ID registered with Bluesky |
| `CLIENT_SECRET` | Yes | OAuth client secret |

## Build & Test Commands

```bash
pnpm install              # Install dependencies
pnpm run build            # Compile TypeScript + post-build steps
pnpm run start            # Run the stdio MCP server
pnpm run dev              # Build and run in one step
pnpm run test             # Full test suite (all 4 suites)
pnpm run test:registration # Tool registration test (8/8 tools)
pnpm run test:remote      # Remote OAuth tests (7/7 tests)
pnpm run test:get-thread  # Post-thread tool test
pnpm run test:url-converter # URL converter test
pnpm run test:link-preview   # Link preview test
```

## Testing Conventions

- Tests are plain Node.js ESM scripts in `test/` (not Jest/Mocha)
- Each test file is self-contained and runs against the built output in `build/test/`
- The orchestrator (`test/final-test.ts`) runs all test suites sequentially
- Test files: `register-tools.test.ts`, `remote-oauth.test.ts`, `thread-context.test.ts`, `mention-context.test.ts`, `mention-monitor.test.ts`, `mention-store.test.ts`, `ai-preferences.test.ts`, `ai-preferences-tombstone.test.ts`, `create-reply.test.ts`
- Tests verify tool registration, remote OAuth flow, thread context retrieval, mention management, AI preferences, and link preview

## AI Preference System

The AI preference system filters content based on user-configured preferences stored as `community.lexicon.preference.ai` records:

1. **Reading**: `fetchAiPreferences(agent, did)` fetches from the user's repo
2. **Caching**: Results cached per-DID for 5 minutes (`PREF_CACHE_TTL_MS`)
3. **Filtering**: `filterPostsByAiPreferences(posts, allowedDids)` removes posts from denied users
4. **Categories**: `inference`, `training` (read preferences); `syntheticContent`, `embedding`

When modifying content-fetching tools, ensure they respect AI preferences via `batchCheckAiPreferences()` and `filterPostsByAiPreferences()`.

## Code Style Conventions

- **Indentation**: 2 spaces
- **Quotes**: Double quotes for strings in tool descriptions, single quotes elsewhere
- **Naming**: camelCase for variables/functions, PascalCase for types/interfaces
- **Error handling**: Wrap API calls in try/catch, return `mcpErrorResponse()` with descriptive messages
- **Response format**: Use `mcpSuccessResponse()` / `mcpErrorResponse()` from utils.ts
- **Limits**: Always impose reasonable limits on pagination (e.g., MAX_TOTAL_POSTS = 500)
- **Comments**: JSDoc-style for exported functions, inline comments for complex logic

## Important Notes

1. **No drive-by refactors**: Only touch what the task requires. Don't rename variables or reformat unrelated code.
2. **Tool descriptions matter**: These are shown to LLM clients — keep them clear and accurate.
3. **AI preferences are mandatory**: Any tool that fetches user content (posts, timelines, searches) must filter by AI preferences. No exceptions.
4. **Windows compatibility**: The build script includes a Windows-specific chmod workaround. Don't remove it.
5. **ESM only**: This project uses `"type": "module"` in package.json. Use `.js` extensions in imports.

## Adding a New Tool — Checklist

1. Add tool registration in `src/tools.ts` (or appropriate file)
2. Implement the tool handler with proper error handling
3. Add AI preference filtering if fetching user content
4. Update README.md with tool description and categorization
5. Add tests in `test/` directory
6. Run `pnpm run test` to verify nothing broke

## Remote OAuth Mode

The server supports a secondary HTTP mode for scenarios where stdio isn't practical:
- Starts via `pnpm run start:remote`
- Handles Bluesky OAuth dance automatically
- Persists sessions/tokens via `src/remote/storage.ts`
- Exposes the same tools over HTTP with JWT authentication
