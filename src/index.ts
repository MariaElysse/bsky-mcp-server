#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AtpAgent } from "@atproto/api";
import * as dotenv from "dotenv";
import { cleanHandle, mcpErrorResponse, mcpSuccessResponse } from './utils.js';
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';
import {
  flattenAiPreferences,
  unflattenAiPreferences,
  type AiPreferencesRecord,
  type AiPreferencesRecordRaw,
} from './ai-preferences.js';
import { registerTools } from './tools.js';

// Load environment variables
dotenv.config({ path: '.env' });
dotenv.config({ path: '.env.local', override: true });

// Create server instance
const server = new McpServer({
  name: "bluesky",
  version: "1.0.0",
});

// Register resources from the resources.ts file
registerResources(server);

// Register prompts from the prompts.ts file
registerPrompts(server);

// Initialize ATP agent and session
let agent: AtpAgent | null = null;

// Register core Bluesky tools (canonical implementations live in tools.ts)
registerTools(server, () => agent);

// Connect to Bluesky using environment variables
async function initializeBlueskyConnection() {
  const identifier = process.env.BLUESKY_IDENTIFIER;
  const password = process.env.BLUESKY_APP_PASSWORD;
  const service = process.env.BLUESKY_SERVICE_URL;
  if (!service) {
    console.error("Error: BLUESKY_SERVICE_URL environment variable must be set (e.g., https://bsky.social or https://your-custom-pds.example.com)");
    return false;
  }

  if (!identifier || !password) {
    console.error("Error: BLUESKY_IDENTIFIER and BLUESKY_APP_PASSWORD environment variables must be set");
    return false;
  }

  try {
    agent = new AtpAgent({ service });
    const result = await agent.login({ identifier, password });

    if (result.success) {
      console.error(`Successfully logged in as ${result.data.handle} (${result.data.did})`);
      return true;
    } else {
      console.error("Login failed: Invalid credentials.");
      return false;
    }
  } catch (error) {
    console.error(`Login failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// AI Preferences tools
// ---------------------------------------------------------------------------
// The community.lexicon.preference.ai record lives at:
//   at://<user-did>/community.lexicon.preference.ai/self
// It contains four categories, each with a tri-state value (allow / deny):
//   training       – whether the user's content may be used for model training
//   inference      – whether the user's content may be used for inference
//   syntheticContent – whether the user allows AI-generated/synthetic content
//   embedding      – whether the user's content may be embedded in embeddings

const AI_PREFS_COLLECTION = 'community.lexicon.preference.ai';
const AI_PREFS_RKEY = 'self';
const AI_PREF_CATEGORIES: Array<keyof AiPreferencesRecord> = [
  'training',
  'inference',
  'syntheticContent',
  'embedding',
];

/** Human-readable label for a preference category */
const CATEGORY_LABELS: Record<string, string> = {
  training: 'Training',
  inference: 'Inference',
  syntheticContent: 'Synthetic Content',
  embedding: 'Embedding',
};

server.tool(
  'get-ai-preferences',
  "Get the authenticated user's AI usage preferences stored on their Bluesky repo. Returns the current allow/deny settings for training, inference, synthetic content, and embedding.",
  {
    user_id: z.string().optional().describe('The target user\'s handle (e.g., alice.bsky.social) or DID (e.g., did:plc:abcdef). If omitted, returns preferences for the authenticated user.'),
  },
  async ({ user_id }) => {
    if (!agent) {
      return mcpErrorResponse(
        'Not connected to Bluesky. Check your environment variables.'
      );
    }

    const currentAgent = agent;

    // Resolve target DID: use provided user_id or fall back to authenticated session
    let did: string;
    if (user_id) {
      const cleaned = cleanHandle(user_id);
      if (cleaned.startsWith('did:')) {
        did = cleaned;
      } else {
        // Resolve handle → DID via atproto API
        const resolveResp = await currentAgent.resolveHandle({ handle: cleaned });
        if (!resolveResp || !resolveResp.data?.did) {
          return mcpErrorResponse(
            `Could not find a user with handle "${user_id}". Please check the handle and try again.`
          );
        }
        did = resolveResp.data.did;
      }
    } else {
      if (!currentAgent.session?.did) {
        return mcpErrorResponse('Not properly authenticated.');
      }
      did = currentAgent.session.did;
    }

    try {
      const collection = AI_PREFS_COLLECTION;
      const rkey = AI_PREFS_RKEY;

      // Fetch the record from the target user's repo
      const response = await currentAgent.com.atproto.repo.getRecord({
        repo: did,
        collection,
        rkey,
      });

      if (!response.success) {
        return mcpSuccessResponse(
          'No AI preferences found for this user. They may not have set any preferences yet.'
        );
      }

      // @atproto/api getRecord returns { uri, cid, value: { ...actual data... } }.
      // Extract the actual record before flattening.
      const rawRecord = (response.data as any).value as AiPreferencesRecordRaw;
      const record = flattenAiPreferences(rawRecord);

      // Build a human-readable summary
      let output = `AI Preferences for ${did}:\n\n`;
      for (const cat of AI_PREF_CATEGORIES) {
        const label = CATEGORY_LABELS[cat] ?? cat;
        const value = record[cat];
        output += `- ${label}: ${value ?? 'unset'}\n`;
      }

      return mcpSuccessResponse(output.trimEnd());
    } catch (error) {
      return mcpErrorResponse(
        `Error fetching AI preferences: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
);

server.tool(
  'set-ai-preference',
  "Set an individual AI preference for the authenticated user. Categories: training, inference, syntheticContent, embedding. Values: allow or deny.",
  {
    category: z.enum(['training', 'inference', 'syntheticContent', 'embedding']).describe('The preference category to update'),
    value: z.enum(['allow', 'deny']).describe('Whether to allow or deny this AI usage type'),
  },
  async ({ category, value }) => {
    if (!agent) {
      return mcpErrorResponse(
        'Not connected to Bluesky. Check your environment variables.'
      );
    }

    const currentAgent = agent;
    if (!currentAgent.session?.did) {
      return mcpErrorResponse('Not properly authenticated.');
    }

    try {
      const did = currentAgent.session.did;
      const collection = AI_PREFS_COLLECTION;
      const rkey = AI_PREFS_RKEY;

      // First, read the existing record to preserve other categories
      let existingRaw: AiPreferencesRecordRaw = {};
      try {
        const getResponse = await currentAgent.com.atproto.repo.getRecord({
          repo: did,
          collection,
          rkey,
        });
        if (getResponse.success) {
          // @atproto/api getRecord returns { uri, cid, value: {...} }. Extract the actual record.
          existingRaw = (getResponse.data as any).value as AiPreferencesRecordRaw;
        }
      } catch {
        // No existing record — that's fine, we'll create one
      }

      // Flatten to internal format, merge the new value, then unflatten back to nested API format
      const flatExisting = flattenAiPreferences(existingRaw);
      const flatUpdated: Record<string, string> = { ...flatExisting };
      flatUpdated[category] = value;

      const nestedRecord = unflattenAiPreferences(flatUpdated as any);

      // Write back via putRecord in the nested API format
      await currentAgent.com.atproto.repo.putRecord({
        repo: did,
        collection,
        rkey,
        record: { ...nestedRecord } as any,
      });

      const label = CATEGORY_LABELS[category] ?? category;
      return mcpSuccessResponse(
        `Updated ${label} preference to "${value}".\n\nCurrent AI preferences:\n` +
          AI_PREF_CATEGORIES
            .map((c) => {
              const val = flatUpdated[c];
              return `- ${CATEGORY_LABELS[c]}: ${val ?? 'unset'}`;
            })
            .join('\n')
      );
    } catch (error) {
      return mcpErrorResponse(
        `Error setting AI preference: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
);

// Start the server
(async function() {
  try {
    // Initialize Bluesky connection
    await initializeBlueskyConnection();

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Bluesky MCP Server running on stdio");
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
})();
