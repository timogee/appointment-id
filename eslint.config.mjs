import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import next from 'eslint-config-next/core-web-vitals';

export default [
  { ignores: ['node_modules/**', '.next/**', 'next-env.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...next,
  {
    // Config files are anonymous default exports by convention.
    files: ['*.mjs', '*.ts'],
    rules: { 'import/no-anonymous-default-export': 'off' },
  },
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // Deliberate: `x!` after a query we have already proven returns a row is
      // clearer than an if-throw on every line. The DB constraints are the guard.
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
];
