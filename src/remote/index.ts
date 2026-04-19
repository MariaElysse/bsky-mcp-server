#!/usr/bin/env node
import path from "node:path";
import * as dotenv from "dotenv";
import { Storage } from "./storage.js";
import { createBlueskyOAuthClient } from "./oauth-bluesky.js";
import { buildApp } from "./server.js";

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.remote", override: true });
dotenv.config({ path: ".env.local", override: true });

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(2);
  }
  return v;
}

async function main() {
  const publicUrl = required("PUBLIC_URL").replace(/\/$/, "");
  const dataDir = process.env.DATA_DIR ?? "/var/lib/bsky-mcp";
  const signingKeyPath = process.env.SIGNING_KEY_PATH ?? path.join(dataDir, "signing-keys.json");
  const dbPath = process.env.DB_PATH ?? path.join(dataDir, "data.db");
  const port = Number(process.env.PORT ?? "8787");
  const host = process.env.HOST ?? "127.0.0.1";

  const storage = new Storage(dbPath);
  storage.gc();
  setInterval(() => storage.gc(), 10 * 60 * 1000).unref();

  const bskyClient = await createBlueskyOAuthClient({
    publicUrl,
    signingKeyPath,
    storage,
  });

  const app = buildApp({ publicUrl, signingKeyPath, storage, bskyClient });

  const server = app.listen(port, host, () => {
    console.log(`Bluesky MCP remote server listening on http://${host}:${port}`);
    console.log(`Public URL: ${publicUrl}`);
    console.log(`Client metadata: ${publicUrl}/oauth/client-metadata.json`);
  });

  const shutdown = (signal: string) => {
    console.log(`Received ${signal}, shutting down`);
    server.close(() => {
      storage.close();
      process.exit(0);
    });
    // Hard exit if shutdown hangs.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch(err => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
