import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * A prompt that instructs the LLM to fetch the Bluesky timeline and create a summary of posts.
 */
const TIMELINE_SUMMARY_PROMPT = `
I need you to get my Bluesky timeline and provide a summary of what people are talking about.

Please follow these steps:
1. Use the "get-timeline" tool to fetch my most recent posts (limit: 50)
2. Analyze the posts and identify common themes, topics, and discussions
3. Create a concise summary of the main conversations happening
4. Highlight any trending hashtags or notable discussions
5. Note any significant announcements or news being shared
6. Organize your summary into clear sections

For your summary, please include:
- Main topics/themes being discussed
- Any trending hashtags
- Notable conversations or threads
- Overall sentiment/mood of the timeline
- Any breaking news or important announcements

Please keep the summary concise (about 3-5 paragraphs) and focus on the most meaningful content rather than just listing all posts.
`;

/** Maximum length for an auto-generated mention reply. */
const MAX_REPLY_LENGTH = 256;

/**
 * Build a system prompt that instructs the LLM to generate a reply to a Bluesky mention.
 * @param authorHandle - The handle of the user who mentioned the bot (without @).
 * @param postText     - The text content of the mentioning post.
 * @returns A prompt string suitable for feeding to an LLM.
 */
export function buildMentionReplyPrompt(
  authorHandle: string,
  postText: string
): string {
  return `You are a helpful assistant on Bluesky. You were just mentioned by ${authorHandle} in the following post:\n\n"${postText}"\n\nPlease generate a friendly, concise reply (max ${MAX_REPLY_LENGTH} characters). Be polite and engaging.`;
}

/**
 * Generate a default mention-reply text when no LLM is available.
 * Truncates to MAX_REPLY_LENGTH if needed. Always returns non-empty text.
 */
export function generateMentionReply(
  authorHandle: string,
  postText: string
): string {
  let reply = `Thanks for the mention${authorHandle ? `, @${authorHandle}!` : "!"}`;

  if (postText && postText.trim().length > 0) {
    const snippet =
      postText.length > 120 ? postText.slice(0, 117) + "..." : postText;
    reply += ` I saw your message: "${snippet}".`;
  }

  reply += " I'll get back to you shortly!";

  if (reply.length > MAX_REPLY_LENGTH) {
    reply = reply.slice(0, MAX_REPLY_LENGTH - 1);
  }

  return reply;
}

/**
 * Registers all Bluesky MCP prompts on the provided MCP server
 * @param server The MCP server instance
 */
export function registerPrompts(server: McpServer): void {
  // Timeline summary prompt
  server.prompt(
    "summarize-timeline",
    {},
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: TIMELINE_SUMMARY_PROMPT,
          },
        },
      ],
    })
  );
}
