// Flat config (ESLint 9+/10). Replaces the legacy .eslintrc.cjs. The project lints with a
// single rule (no-unused-vars); there is no no-undef rule, so no globals/env is required.
// caughtErrors:'none' preserves the pre-v9 behavior of not flagging intentionally-empty
// catch clauses (catch(e){} / catch(_){}), which this codebase uses throughout.
export default [
  {
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    rules: { 'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }] },
  },
];
