// ESLint config for the backend. Tests run through `node --test` and exercise
// real code paths against a real database.
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { node: true, es2023: true },
  ignorePatterns: ['dist/', 'node_modules/', 'coverage/'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    'no-console': 'error',
    eqeqeq: ['error', 'always'],
  },
};
