/**
 * ESLint config (ESLint 8.57 + @typescript-eslint 8, legacy `.eslintrc` format).
 *
 * Three rules encode a real constraint rather than a style preference:
 *   - `no-console` in `src/**`: stdout is the MCP stdio protocol stream. One
 *     stray `console.log` in the server corrupts the JSON-RPC framing and the
 *     host reports a mystifying parse error, so this is an error, not a warning.
 *     Scripts (which are run by a human in a terminal) are exempt.
 *   - `no-floating-promises`: an un-awaited write can finish after the tool
 *     handler already replied "done".
 *   - type-aware linting: most bugs in this codebase are CSDN's field names and
 *     status codes being wrong, which only types catch.
 */
module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    // Type-aware linting: the same project `npm run typecheck` uses, so a lint
    // run can never disagree with the compiler about which files exist.
    project: ['./tsconfig.json'],
    tsconfigRootDir: __dirname,
    ecmaVersion: 2022,
    sourceType: 'module'
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:@typescript-eslint/recommended-type-checked'
  ],
  // Build output and coverage must not be linted: `--ext .ts` would otherwise
  // pick up the generated `dist/**/*.d.ts`, which are not part of the TS project
  // and would fail with a parsing error.
  ignorePatterns: ['dist/', 'coverage/', 'node_modules/', '*.cjs', 'scripts/**/*.mjs'],
  rules: {
    'no-console': 'error',
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_'
      }
    ],
    // Importing a type as a value drags runtime code into the module graph for
    // nothing; `inline-type-imports` keeps the existing `{ foo, type Bar }`
    // style, which is what the codebase already uses.
    '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }]
  },
  overrides: [
    {
      // Scripts are driven by a human in a terminal — printing is their job.
      // (See scripts/live-smoke.mjs; it must show each step's raw result.)
      files: ['scripts/**/*.{ts,mts,cts,js,mjs,cjs}'],
      rules: {
        'no-console': 'off'
      }
    },
    {
      // Test doubles implement *async interfaces* (`FetchLike`, `sleep`, a
      // response's `text()`), so an `async` method with nothing to await is
      // the expected shape, not an oversight — `require-await` would flag every
      // fake in tests/helpers and every scripted fake in a spec. Casts in
      // fixtures are likewise deliberate: they force a hand-written literal
      // through a narrower interface, which is the fixture's whole job.
      files: ['tests/**/*.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-unsafe-assignment': 'off',
        '@typescript-eslint/no-unsafe-member-access': 'off',
        '@typescript-eslint/no-unsafe-argument': 'off',
        '@typescript-eslint/no-unsafe-return': 'off',
        '@typescript-eslint/require-await': 'off',
        '@typescript-eslint/no-unnecessary-type-assertion': 'off'
      }
    }
  ]
}
