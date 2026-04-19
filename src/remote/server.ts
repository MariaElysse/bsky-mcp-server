import express, { type Express } from "express";
import { Agent } from "@atproto/api";
import type { NodeOAuthClient } from "@atproto/oauth-client-node";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

import { registerResources } from "../resources.js";
import { registerPrompts } from "../prompts.js";
import { registerTools } from "../tools.js";
import type { Storage } from "./storage.js";
import {
  clientMetadataHandler,
  jwksHandler,
  BLUESKY_SCOPES,
} from "./oauth-bluesky.js";
import {
  BlueskyFederatedProvider,
  callbackHandler,
  loginHandler,
  DEFAULT_PROVIDER_CONFIG,
  type ProviderConfig,
} from "./oauth-mcp.js";

export interface ServerConfig {
  publicUrl: string;
  signingKeyPath: string;
  storage: Storage;
  bskyClient: NodeOAuthClient;
  providerConfig?: ProviderConfig;
}

/**
 * Build the Express app. Separated from listen() so tests can drive it
 * via supertest or an inline http.Server.
 */
export function buildApp(config: ServerConfig): Express {
  const providerConfig = config.providerConfig ?? DEFAULT_PROVIDER_CONFIG;
  const provider = new BlueskyFederatedProvider(config.storage, config.bskyClient, providerConfig);
  const publicUrl = new URL(config.publicUrl);

  const app = express();
  // We're always behind a reverse proxy on loopback (Caddy → 127.0.0.1:PORT
  // in the reference deploy). Without this, express-rate-limit inside
  // mcpAuthRouter warns loudly on every request because it sees
  // X-Forwarded-For but can't trust it. Restricting to loopback means we
  // don't trust the header on any request that *actually* originated from
  // a public IP — which shouldn't happen, but belt-and-suspenders.
  app.set("trust proxy", "loopback");
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: false }));

  // ATProto OAuth client discovery — these are fetched by the user's PDS
  // when it sees our client_id, not by Claude.
  app.get("/oauth/client-metadata.json", clientMetadataHandler(config.publicUrl));
  app.get("/oauth/jwks.json", jwksHandler(config.signingKeyPath));

  // Login page POST target + PDS redirect landing zone.
  app.post("/oauth/login", loginHandler(config.bskyClient, config.storage));
  app.get("/oauth/callback", callbackHandler(config.bskyClient, config.storage, providerConfig));

  // MCP SDK auth router. Installs:
  //   GET  /.well-known/oauth-authorization-server
  //   GET  /.well-known/oauth-protected-resource
  //   GET  /authorize   → provider.authorize() → our login HTML
  //   POST /token       → provider.exchange*()
  //   POST /register    → DCR via our clientsStore
  //   POST /revoke      → provider.revokeToken()
  app.use(mcpAuthRouter({
    provider,
    issuerUrl: publicUrl,
    scopesSupported: [...BLUESKY_SCOPES],
    resourceName: "Bluesky MCP",
  }));

  // MCP endpoint — auth-required, stateless Streamable HTTP. Each request
  // spins up a fresh McpServer bound to the DID from the bearer token.
  app.post("/mcp", requireBearerAuth({ verifier: provider }), async (req, res) => {
    const auth = req.auth as AuthInfo | undefined;
    const did = auth?.extra && typeof auth.extra === "object" ? (auth.extra as { did?: string }).did : undefined;

    let agent: Agent | null = null;
    if (did) {
      try {
        const session = await config.bskyClient.restore(did);
        agent = new Agent(session);
      } catch (err) {
        // Restore failed — most likely the PDS revoked our refresh token or
        // the session row was wiped. Leave agent null; tools will return the
        // "not connected" error and the user can re-authorize.
        console.error(`[mcp] restore failed for ${did}:`, err instanceof Error ? err.message : err);
      }
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = new McpServer({ name: "bluesky", version: "1.0.0" });
    registerResources(server);
    registerPrompts(server);
    registerTools(server, () => agent);

    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("[mcp] handleRequest error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "internal_error", message: (err as Error).message });
      }
    }
  });

  // Reject GET /mcp explicitly — Streamable HTTP in stateless mode does not
  // support server→client SSE, and we want a clear 405 instead of Claude
  // silently hanging.
  app.get("/mcp", (_req, res) => {
    res.status(405).json({ error: "method_not_allowed", message: "Use POST /mcp with a JSON-RPC body." });
  });

  return app;
}
