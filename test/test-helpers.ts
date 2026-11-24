import { test } from "node:test";

export type TestCase = [name: string, run: () => Promise<void> | void];

/**
 * Register a suite's cases with Node's built-in test runner.
 *
 * `node --test build/test/` loads every compiled file under `build/test/` and
 * runs the cases registered here. The runner owns per-test reporting, the
 * summary, and the process exit code, so a throwing case still fails the build
 * instead of being printed and ignored — which is what the previous
 * hand-rolled loop did.
 */
export async function runTests(tests: readonly TestCase[]): Promise<void> {
  const started = tests.map(([name, run]) => test(name, run));
  // Suite files create temporary state above the `runTests()` call and delete
  // it right below it, so the call must stay pending until the registered
  // cases have actually finished.
  await Promise.all(started);
}
