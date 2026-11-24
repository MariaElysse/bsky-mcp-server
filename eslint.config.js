// ESLint flat config — the guard the CI `lint` job runs (`pnpm run lint`).
//
// Scope: this repo had never been linted, so the config keeps the rules that
// catch real defects (unused code, unreachable branches, swallowed errors,
// misuse of `Promise`) and turns off the ones that would only add churn to a
// codebase that is already consistent by hand — see the rule comments.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // `build/` holds generated JS + .d.ts; `tmp/` and `.qwen/` are scratch
    // space that is git-ignored and never compiled; `.pnpm-store/` is pnpm's.
    ignores: ['build/**', 'node_modules/**', '.pnpm-store/**', 'tmp/**', '.qwen/**', '**/*.d.ts'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    rules: {
      // TypeScript resolves identifiers and their types, so the base rule only
      // misreports Node globals (`process`, `console`, `Buffer`).
      'no-undef': 'off',

      // The formatter walks untyped AT Protocol thread views, and the residual
      // `any` on `validateUri()` / `getDidsFromThread()` is documented in
      // AGENTS.md. Banning `any` here would mean a rename-only sweep with no
      // behavioural payoff.
      '@typescript-eslint/no-explicit-any': 'off',

      // Genuine dead code is worth failing on; unused function parameters are
      // often required by a callback signature, hence the `^_` escape hatch.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],

      // `catch {}` blocks that only document why a failure is tolerated are
      // intentional around store/lock cleanup.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
);
