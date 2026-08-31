#!/usr/bin/env node
/**
 * final-test — orchestrator that runs all unit test suites from the compiled
 * build/ directory. Each suite is run in its own process so they don't share
 * state.
 */

import { execSync } from "node:child_process";
import path from "node:path";

// Use CWD since pnpm sets it to the project root before running this script.
const ROOT = process.cwd();

interface SuiteResult {
  name: string;
  passed: boolean;
}

function runSuite(name: string, cmd: string) {
  try {
    execSync(cmd, { stdio: "inherit" });
    return { name, passed: true };
  } catch {
    return { name, passed: false };
  }
}

async function main() {
  const suites = [
    ["register-tools", `node build/test/register-tools.test.js`],
    ["url-converter", `node build/test/url-converter/test-url-converter.js`],
    ["link-preview", `node build/test/link-preview/test-link-preview.js`],
    ["ai-preferences", `node build/test/ai-preferences.test.js`],
    ["ai-preferences-tombstone", `node build/test/ai-preferences-tombstone.test.js`],
    ["mention-store", `node build/test/mention-store.test.js`],
    ["thread-context", `node build/test/thread-context.test.js`],
  ];

  const results = [];
  let allPassed = true;

  for (const [name, cmd] of suites) {
    console.log(`\n=== Running suite: ${name} ===`);
    const result = runSuite(name, cmd);
    results.push(result);
    if (!result.passed) allPassed = false;
  }

  // Summary
  const totalSuites = results.length;
  const passedSuites = results.filter((r) => r.passed).length;
  const failedSuites = totalSuites - passedSuites;

  console.log("\n" + "=".repeat(50));
  console.log(`Test Summary: ${totalSuites} suites — ${passedSuites} passed, ${failedSuites} failed`);
  for (const r of results) {
    const icon = r.passed ? "✓" : "✗";
    console.log(`  ${icon} ${r.name}`);
  }
  console.log("=".repeat(50));

  process.exit(allPassed ? 0 : 1);
}

main();
