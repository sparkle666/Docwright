export default [
  {
    files: ['src/**/*.js', 'tests/**/*.js'],
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
      'prefer-const': 'error',
      'no-var': 'error',
      'eqeqeq': ['error', 'always'],
      'no-throw-literal': 'error',
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setImmediate: 'readonly',
        AbortSignal: 'readonly',
        fetch: 'readonly',
        Buffer: 'readonly',
        Promise: 'readonly',
      },
    },
  },
];
