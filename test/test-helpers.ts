export type TestCase = [name: string, run: () => Promise<void> | void];

/**
 * Run a suite using the repository-wide test output format.
 *
 * Each test emits exactly one TAP-style result line and every suite emits the
 * same pass/fail totals, whether it succeeds or fails.
 */
export async function runTests(tests: readonly TestCase[]): Promise<void> {
  let passed = 0;

  for (const [name, run] of tests) {
    try {
      await run();
      passed += 1;
      console.log(`ok - ${name}`);
    } catch (error) {
      console.error(`not ok - ${name}`);
      console.error(error);
    }
  }

  const failed = tests.length - passed;
  console.log(`\n${passed} / ${tests.length} test(s) passed`);
  if (failed > 0) {
    console.error(`${failed} / ${tests.length} test(s) failed`);
    process.exitCode = 1;
  }
}
