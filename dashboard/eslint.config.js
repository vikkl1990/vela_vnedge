import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'test-results', 'playwright-report']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
  },
  {
    files: ['src/pages/**/*.tsx', 'src/components/**/*.tsx'],
    rules: { 'no-restricted-syntax': [ 'error', { selector: "VariableDeclarator[id.name=/^(money|usd|pct|fmtR|fmtUsd)$/][init.type='ArrowFunctionExpression']", message: 'Import the shared formatter from lib/format instead of defining a local copy.' }, { selector: "FunctionDeclaration[id.name=/^(money|usd|pct|fmtR|fmtUsd)$/]", message: 'Use lib/format for consistent financial formatting.' } ] },
  },
  {
    // Provider modules intentionally export a component plus its hook.
    files: ['src/lib/**/*.tsx', 'src/sse/**/*.tsx'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
])
