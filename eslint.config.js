import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['dist/**', 'node_modules/**', 'tests/.tmp/**', 'tests/screenshots/**'] },
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: globals.browser },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'prefer-const': 'warn',
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    files: ['tools/**/*.{js,mjs,cjs}', 'tests/**/*.mjs', '*.mjs', '*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.node, ...globals.browser } },
    rules: { 'no-unused-vars': 'warn', 'no-empty': 'off' },
  },
  { files: ['**/*.cjs'], languageOptions: { sourceType: 'commonjs' } },
];
