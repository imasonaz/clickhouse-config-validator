// ESLint flat config: `npm run lint`. Browser code in js/, Node code in bin/, tools/ and test/.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['vendor/**', 'data/**', 'node_modules/**'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.browser } },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'prefer-const': 'error',
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
    },
  },
  { files: ['bin/**', 'tools/**', 'test/**', '*.config.js'], languageOptions: { globals: { ...globals.node } } },
];
