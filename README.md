# Bluesky MCP Server

[![smithery badge](https://smithery.ai/badge/@brianellin/bsky-mcp-server)](https://smithery.ai/server/@brianellin/bsky-mcp-server)

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
- **get-timeline-posts**: Returns posts from the authenticated user's home timeline. Supports count-based and time-based fetching (e.g., "posts" or "hours").
- **get-feed-posts**: Returns posts from a specified feed (custom user feed, algorithmic feed, etc.)
- **get-notifications**: Fetches notifications from Bluesky, optionally filtered by type (reply, mention, like, repost, follow, quote).

### Search Tools
- **search-posts**: Searches for posts on Bluesky. Supports strict AND matching and operators: `from:`, `to:`, `mentions:`, `url:`, `lang:`, `has:images`, `has:video`, `has:link`. Sort by "top" or "latest".
- **search-people**: Searches for users/actors on Bluesky.
- **search-feeds**: Searches for feeds on Bluesky.

### Post & Thread Tools
- **create-post**: Publishes a new post to Bluesky. Supports replies, link previews (auto-detected or specified), and automatic facet detection (mentions, hashtags).
- **get-post-thread**: Returns a full conversation thread for a specific post, showing all replies and context up to configurable depth/parent height.
- **like-post**: Likes a post with a specific URI.
- **unfollow-user**: Unfollows a specific user.

### Social Graph Tools
- **get-follows**: Returns the set of users an account follows.
- **get-followers**: Returns the set of users who follow an account.
- **follow-user**: Follows a specific user.

### Content Discovery Tools
- **get-pinned-feeds**: Returns the set of all "pinned" items from the authenticated user's preferences.
- **get-list-posts**: Returns posts from a specified Bluesky list (curated collection).
- **get-user-posts**: Returns posts from a specific user.
- **get-liked-posts**: Returns recent posts liked by the authenticated user.
- **get-post-likes**: Gets information about users who have liked a specific post.
- **get-trends**: Returns current trending topics on Bluesky with post counts.

### Utility Tools
- **convert-url-to-uri**: Converts a Bluesky web URL to an AT URI format that can be used with other tools (e.g., `https://bsky.app/profile/user.bsky.social/post/abc123` -> `at://...`).
- **list-resources**: Lists all available MCP resources with their descriptions.

### AI Preference Tools
- **get-ai-preferences**: Retrieves the current user's AI preferences (community.lexicon.preference.ai record), which control whether content from specific users may be read based on categories like inference, training, synthetic content, and embedding.
- **set-ai-preference**: Sets or updates a category in the user's AI preferences record.

## Tips
- You can ask for posts from search, timelines, lists, feeds, or profiles by time range. For example: "Summarize posts from my timeline for the last three days" or "Find me the most interesting article people have been talking about this week".
- Get weird: "What's the funniest/most unhinged/weirdest/goofiest post you've seen on my timeline in the last 24 hours?"
- Learn about yourself: "Analyze my liked posts and tell me what I'm into. Give me 3 interesting facts about what you've found and how it relates to my personality on bluesky" or "Who follows me on Bluesky? Give me a comprehensive report."

## Installation

### Installing via Smithery

To install Bluesky MCP Server for Claude Desktop automatically via [Smithery](https://smithery.ai/server/@brianellin/bsky-mcp-server):

```bash
npx -y @smithery/cli install @brianellin/bsky-mcp-server --client claude
```

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

## Remote OAuth Mode (Optional)

This server also supports a remote HTTP mode with OAuth authentication. Instead of using app passwords over stdio, the server runs as an HTTP service that handles Bluesky's OAuth flow:

```bash
# Start the remote OAuth server
pnpm run start:remote
```

Environment variables for remote mode:
- `REMOTE_HOST`: Host to bind (default: localhost)
- `REMOTE_PORT`: Port to listen on (default: 3000)
- `SERVICE_URL`: Bluesky AT Protocol service URL
- `CLIENT_ID`: OAuth client ID (registered with Bluesky)
- `CLIENT_SECRET`: OAuth client secret

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

## License

MIT
