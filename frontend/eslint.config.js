import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // Effects here deliberately reset fetch lifecycle state (loading/status)
      // before kicking off a request (e.g. PuzzlePage on date change, AI solve
      // in Game). This is an intentional data-fetch pattern, not an accidental
      // cascading render, so disable the new react-hooks v7 heuristic.
      'react-hooks/set-state-in-effect': 'off',
    },
  },
])
