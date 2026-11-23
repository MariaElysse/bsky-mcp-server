# Bluesky MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io/) server that connects to [Bluesky](https://bsky.app/) and provides tools to interact with the ATProtocol.

You can use this MCP server to bring context from various Bluesky / ATProtocol API endpoints directly into the context window of your LLM based application. For example, you can add this server to Claude Desktop and then use it as a natural language Bluesky client.

## Features & Tools

- Interact with common Bluesky features via natural language (e.g. "Get recent posts from David Roberts")
- Fetch and analyze feeds ("Find me a feed about Seattle and tell me what people are talking about")
- Fetch and analyze lists of followers ("What types of accounts does Mark Cuban follow? Give me a detailed report")
- Use an LLM to write a post and then post it for you (e.g. "Write a haiku about today's weather in my area and post it to bluesky")
- Search for feeds, posts, and people ("Find posts about the #teslatakedown and give me a summary of recent events")
- Analyze who follows you? ("Who follows me on Bluesky? Give me a report")

Here's the current list of tools provided:

### Profile & Account Tools
- **get-my-handle-and-did**: Return the handle and DID of the currently authenticated user for this Bluesky session. Useful when someone asks information about themselves using "me" or "my".
- **get-profile**: Returns the profile details of a specified user (handle, bio, follower/following counts, etc.)

### Timeline & Feed Tools
- **get-timeline-posts**: Returns posts from the authenticated user's home timeline. Supports count-based and time-based fetching (e.g., "posts" or "hours"). **Pagination**: Omit `cursor` to auto-fetch up to `count` posts, or pass a `cursor` from a previous response to fetch the next page.
- **get-feed-posts**: Returns posts from a specified feed (custom user feed, algorithmic feed, etc.). **Pagination**: Omit `cursor` to auto-fetch up to `count` posts, or pass a `cursor` from a previous response to fetch the next page.
- **get-notifications**: Fetches notifications from Bluesky, optionally filtered by type (reply, mention, like, repost, follow, quote). **Pagination**: Omit `cursor` to auto-fetch up to `limit` notifications, or pass a `cursor` from a previous response to fetch the next page.
- **get-mention-context**: Fetches recent mentions of the authenticated user with full conversation thread context and AI preference filtering.

### Search Tools
- **search-posts**: Searches for posts on Bluesky. Supports strict AND matching and operators: `from:`, `to:`, `mentions:`, `url:`, `lang:`, `has:images`, `has:video`, `has:link`. Sort by "top" or "latest".
- **search-people**: Searches for users/actors on Bluesky.
- **search-feeds**: Searches for feeds on Bluesky.

### Post & Thread Tools
- **create-post**: Publishes a new post to Bluesky. Supports replies, link previews (auto-detected or specified), and automatic facet detection (mentions, hashtags).
- **create-reply**: Creates a reply to an existing Bluesky post. Resolves root/parent CID references automatically, checks AI preferences of the target author, and deduplicates against previously handled mentions.
- **get-post-thread**: Returns a full conversation thread for a specific post, showing all replies and context up to configurable depth/parent height.
- **like-post**: Likes a post with a specific URI.
- **unfollow-user**: Unfollows a specific user.

### Social Graph Tools
- **get-follows**: Returns the set of users an account follows.
- **get-followers**: Returns the set of users who follow an account.
- **follow-user**: Follows a specific user.

### Content Discovery Tools
- **get-pinned-feeds**: Returns the set of all "pinned" items from the authenticated user's preferences.
- **get-list-posts**: Returns posts from a specified Bluesky list (curated collection). **Pagination**: Omit `cursor` to auto-fetch up to `count` posts, or pass a `cursor` from a previous response to fetch the next page.
- **get-user-posts**: Returns posts from a specific user. **Pagination**: Omit `cursor` to auto-fetch up to `count` posts, or pass a `cursor` from a previous response to fetch the next page.
- **get-liked-posts**: Returns recent posts liked by the authenticated user. **Pagination**: Omit `cursor` to auto-fetch up to `limit` posts, or pass a `cursor` from a previous response to fetch the next page.
- **get-post-likes**: Gets information about users who have liked a specific post.
- **get-trends**: Returns current trending topics on Bluesky with post counts.

### Utility Tools
- **convert-url-to-uri**: Converts a Bluesky web URL to an AT URI format that can be used with other tools (e.g., `https://bsky.app/profile/user.bsky.social/post/abc123` -> `at://...`).

Platform information (post limits, facet rules, AI preference categories, tool inventory) is served through the MCP resources API — your client lists it with `resources/list`, no tool call needed.

### AI Preference Tools
- **get-ai-preferences**: Retrieves the current user's AI preferences (community.lexicon.preference.ai record), which control whether content from specific users may be read based on categories like inference, training, synthetic content, and embedding.
- **set-ai-preference**: Sets or updates a category in the user's AI preferences record.

### Mention Management Tools
- **run-mention-monitor**: Monitors incoming mentions and can auto-reply. Uses a persistent mention store for deduplication and tracks handled mentions to avoid duplicate responses.

## Tips
- You can ask for posts from search, timelines, lists, feeds, or profiles by time range. For example: "Summarize posts from my timeline for the last three days" or "Find me the most interesting article people have been talking about this week".
- Get weird: "What's the funniest/most unhinged/weirdest/goofiest post you've seen on my timeline in the last 24 hours?"
- Learn about yourself: "Analyze my liked posts and tell me what I'm into. Give me 3 interesting facts about what you've found and how it relates to my personality on bluesky" or "Who follows me on Bluesky? Give me a comprehensive report."

## Cursor-Based Pagination

All post-fetching tools support cursor-based pagination. When a tool returns results, the response text will include a message like:

```
[More posts available — pass cursor="abc123..." to continue.]
```

To fetch the next page, call the same tool with the `cursor` parameter set to the returned value:

```
get-timeline-posts: { count: 20, type: "posts", cursor: "abc123..." }
```

**How it works:**
- **First call (no cursor):** The tool auto-fetches up to `count` posts by paginating internally. The response advertises a cursor whenever the Bluesky API returned one — including when your requested `count` was already satisfied — so you can always resume where the call stopped instead of silently missing results.
- **Subsequent calls (with cursor):** The tool fetches a single page starting from the cursor, returning up to `count` posts.
- **Time-based mode (`type: "hours"`):** Does not support cursor — always starts fresh from the current time window, so it never advertises a cursor.
- **Default `count`:** Most tools default to `count: 20` to keep responses concise. Increase it when you need more results in one call.

## Post & Thread Format

Post- and thread-fetching tools return text formatted for LLM consumption: structured `<posts>` / `<post>` / `<replies>` elements carrying attributes (`uri`, `bsky_url`, `author_handle`, `author_name`, `posted_at`, …), embedded links/images/video, quoted posts, and engagement counts. Reposts are wrapped in `<repost>`. The format is specified in [docs/post-format-spec.md](docs/post-format-spec.md); posts hidden by AI preferences are additionally replaced with tombstone placeholders so feed and thread order stays intact.

## Installation

### Installing Manually

First clone this repo, then install dependencies and build the server:

```bash
# Install pnpm if you don't have it
npm install -g pnpm

# Install dependencies
pnpm install

# Build the project
pnpm run build
```

### Testing with MCP Inspector

You can test the Bluesky tools directly without connecting to an LLM via the [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector). First make sure you have built the server and then run:

```bash
npx @modelcontextprotocol/inspector node build/src/index.js
```

Navigate to the local URL provided in your terminal, and then set your `BLUESKY_IDENTIFIER`, `BLUESKY_APP_PASSWORD`, and `BLUESKY_SERVICE_URL` environment variables from the panel on the left. Try the `get-timeline-posts` tool to see the most recent posts from your home timeline.

## MCP Client Configuration

Follow the steps to set up MCP with your client of choice. For example, to set up Claude for desktop to connect to Bluesky, add the following to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bluesky": {
      "command": "node",
      "args": ["/path/to/bsky-mcp-server/build/src/index.js"],
      "env": {
        "BLUESKY_IDENTIFIER": "your-bluesky-handle",
        "BLUESKY_APP_PASSWORD": "your-app-password",
        "BLUESKY_SERVICE_URL": "https://bsky.social"
      }
    }
  }
}
```

For more details about running MCP servers in Claude for desktop, see https://modelcontextprotocol.io/quickstart/user

## Optional environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BSKY_WEB_URL` | `https://bsky.app` | Base URL used to render links back to the web client. Set it for self-hosted frontends. |
| `MENTION_STORE_PATH` | `.mention-store.json` | Location of the mention de-duplication store. Use one path per account. |
| `LOG_RESPONSES` | unset | Set to `true` to write tool diagnostics to stderr (never to stdout — that carries MCP traffic). |
| `ALLOW_AUTO_REPLY` | unset | Must be `true` for `run-mention-monitor`'s `autoReply: true` to actually post replies. Off by default: a tool argument alone can never publish on your behalf. Without it the monitor records mentions as `pending` and says the reply was refused. |

## Transport

This server speaks MCP over **stdio only**. Your MCP client launches it as a subprocess (`node build/src/index.js`) and authenticates to Bluesky with the app password from the environment variables above — there is no HTTP/OAuth server mode to deploy. An earlier remote/OAuth HTTP experiment lived in `src/remote/`; it was never compiled by `pnpm run build`, never tested, and could not start from a clean install, so it has been removed rather than left half-maintained. See [Differences from upstream](#differences-from-upstream).

## Creating App Passwords

To use this MCP server in stdio mode, you need to create an app password for your Bluesky account:

1. Log in to Bluesky
2. Go to Settings > App Passwords
3. Create a new app password specifically for this integration
4. Set the app password using the `BLUESKY_APP_PASSWORD` environment variable

## AI Preference Enforcement

This server respects user-configured AI preferences stored as `community.lexicon.preference.ai` records in Bluesky. When enabled, posts from users who have denied inference or training will be filtered out of timeline and search results. Preferences are cached for 5 minutes per DID to minimize API calls.

The following categories can be configured:
- **inference**: Whether content may be used for AI inference
- **training**: Whether content may be used for AI training
- **syntheticContent**: Whether synthetic/AI-generated content should be shown
- **embedding**: Whether content may be used for embedding generation

## Security Notes

- This server stores your session information in memory only and does not share it with the MCP client.
- The MCP client only has access to the tools, not to your authentication or app password.
- AI preferences are cached locally per DID with a 5-minute TTL.

## Differences from upstream

This repository is a fork of [lizthegrey/bsky-mcp-server](https://github.com/lizthegrey/bsky-mcp-server) and has moved well ahead of it. What to expect if you're comparing against upstream:

- **AI preference enforcement** — `community.lexicon.preference.ai` records are read and cached per DID, and enforced by every content-fetching tool; denied posts are replaced with tombstones so feed and thread order is preserved. `get-ai-preferences` / `set-ai-preference` manage the record.
- **Mention handling** — `get-mention-context`, `run-mention-monitor`, `create-reply`, and a persistent JSON mention store that deduplicates replies across runs.
- **Thread context** — `src/thread-context.ts` fetches and formats mention conversations with parent/child structure and AI-preference filtering.
- **Cursor-based pagination** on the post-fetching tools (auto-fetch, cursor, and hours modes, capped at 500 posts per call).
- **Self-hosted PDS support** — `BLUESKY_SERVICE_URL` and `BSKY_WEB_URL` for alternate PDSes and Bluesky web frontends; search tools run against `api.bsky.app` through a separate unauthenticated agent so they keep working when your home PDS doesn't proxy search.
- **No remote OAuth mode** — the upstream `src/remote/` HTTP + OAuth server, `src/scripts/generate-signing-key.ts`, `Dockerfile.remote`, `.env.remote.example`, the `deploy/` systemd/Caddy/Docker-Compose artifacts, and `test/remote-oauth.test.ts` have all been deleted. The server is stdio-only and binds no port.
- **CI** — GitHub Actions runs install → build → the full test suite on every push and PR to `main`.

Install and deploy from this repository's `main` (or your own fork of it), not from an upstream branch.

## License

MIT
