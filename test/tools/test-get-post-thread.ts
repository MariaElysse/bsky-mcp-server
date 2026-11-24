/**
 * Live smoke test for the thread formatter.
 *
 * This is the only suite that talks to the network, so it skips when the
 * account credentials are absent — which is the case in CI. Run it locally
 * with `pnpm run test:get-thread`, or let `node --test build/test/` include it
 * whenever `.env` supplies an identifier and app password.
 */
import fs from "fs";
import path from "path";
import { dirname } from "path";
import { fileURLToPath } from "url";
import { test } from "node:test";
import { AtpAgent } from "@atproto/api";
import * as dotenv from "dotenv";
import { formatPostThread } from "../../src/llm-preprocessor.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });

// A public post with replies, quoted by the format spec's examples.
const TEST_POST_URI = "at://did:plc:fpruhuo22xkm5o7ttr2ktxdo/app.bsky.feed.post/3lmmuyulsoc2n";

const hasCredentials = Boolean(process.env.BLUESKY_IDENTIFIER && process.env.BLUESKY_APP_PASSWORD);

async function fetchThread(): Promise<unknown> {
  const agent = new AtpAgent({
    service: process.env.BLUESKY_SERVICE_URL || "https://bsky.social",
  });
  const result = await agent.login({
    identifier: process.env.BLUESKY_IDENTIFIER as string,
    password: process.env.BLUESKY_APP_PASSWORD as string,
  });
  if (!result.success) {
    throw new Error("Bluesky login failed");
  }

  const response = await agent.app.bsky.feed.getPostThread({
    uri: TEST_POST_URI,
    depth: 3,
  });
  if (!response.success) {
    throw new Error("Bluesky thread request failed");
  }
  return response.data.thread;
}

test(
  "live thread renders as the format spec describes",
  { skip: hasCredentials ? false : "set BLUESKY_IDENTIFIER and BLUESKY_APP_PASSWORD to run this suite" },
  async () => {
    const thread = await fetchThread();
    const formatted = formatPostThread(thread);

    if (!formatted.startsWith("<posts>\n")) {
      throw new Error(`thread output does not open with the <posts> container: ${formatted.slice(0, 60)}`);
    }
    if (!formatted.trimEnd().endsWith("</posts>")) {
      throw new Error("thread output does not close the <posts> container");
    }
    if (!formatted.includes(`uri="${TEST_POST_URI}"`)) {
      throw new Error("requested post is missing from the formatted thread");
    }
    if (!formatted.includes("requested=\"true\"")) {
      throw new Error("the requested post is not marked with requested=\"true\"");
    }
    if (!formatted.includes("<content>")) {
      throw new Error("no <content> element in the formatted thread");
    }

    // Kept as a human-readable artifact for eyeballing format changes.
    const outputDir = path.join(__dirname, "../../test/output");
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, "formatted_thread.xml"), formatted);
  }
);
