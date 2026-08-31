import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

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

/**
 * A prompt template that guides generating appropriate responses to Bluesky mentions.
 */
export const MENTION_REPLY_PROMPT = `
You are a helpful, courteous assistant on Bluesky.
Generate a concise, relevant reply to a user's mention.

Requirements:
- Stay within 256 characters (hard limit)
- Be conversational, helpful, and polite
- Address the user by their handle
- Do not generate empty replies or generic spam
`;

/**
 * Build a prompt string for generating a reply to a specific mention.
 */
export function buildMentionReplyPrompt(
  authorHandle: string,
  postText: string,
  contextText?: string
): string {
  const cleanHandle = authorHandle ? `@${authorHandle.replace(/^@/, '')}` : 'the user';
  let prompt = `${MENTION_REPLY_PROMPT.trim()}\n\nAuthor: ${cleanHandle}\nMentioned Post: "${postText}"`;
  if (contextText) {
    prompt += `\nThread Context:\n${contextText}`;
  }
  prompt += `\n\nGenerate reply:`;
  return prompt;
}

/**
 * Generates an appropriate auto-reply text for a mention.
 * Guaranteed to be non-empty and at most 256 characters.
 */
export function generateMentionReply(
  authorHandle: string,
  mentionText?: string,
  _threadContext?: any
): string {
  const handle = authorHandle ? `@${authorHandle.replace(/^@/, '')}` : '';
  const text = (mentionText || '').trim();

  let reply = '';
  if (text) {
    if (/\b(hello|hi|hey|greetings)\b/i.test(text)) {
      reply = `Hello ${handle}! Thanks for reaching out. How can I help you today?`.trim();
    } else if (/\b(help|how|what|why|where|when|who)\b/i.test(text)) {
      reply = `Hi ${handle}, thanks for your question! I received your mention and am looking into it.`.trim();
    } else if (/\b(thank|thanks|thx|appreciate)\b/i.test(text)) {
      reply = `You're welcome ${handle}! Glad I could help.`.trim();
    } else {
      reply = `Hi ${handle}, thanks for the mention! I've received your message.`.trim();
    }
  } else {
    reply = `Hi ${handle}, thanks for connecting!`.trim();
  }

  // Enforce max 256 chars
  if (reply.length > 256) {
    reply = reply.substring(0, 253) + '...';
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
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: TIMELINE_SUMMARY_PROMPT
        }
      }]
    })
  );

  // Mention reply prompt
  server.prompt(
    "reply-to-mention",
    {
      authorHandle: z.string().describe("Handle of the user who mentioned"),
      mentionText: z.string().describe("Text of the mentioning post"),
    },
    ({ authorHandle, mentionText }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: buildMentionReplyPrompt(authorHandle, mentionText)
        }
      }]
    })
  );
}
