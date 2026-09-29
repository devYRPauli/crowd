import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

const platformMath = {
  'no-restricted-properties': [
    'error',
    ...[
      'sin',
      'cos',
      'tan',
      'asin',
      'acos',
      'atan',
      'atan2',
      'sinh',
      'cosh',
      'tanh',
      'asinh',
      'acosh',
      'atanh',
      'exp',
      'expm1',
      'log',
      'log1p',
      'log2',
      'log10',
      'pow',
      'cbrt',
      'hypot',
    ].map((property) => ({
      object: 'Math',
      property,
      message: 'Rounds differently by platform. Use src/core/math/libm.',
    })),
  ],
  'no-restricted-syntax': [
    'error',
    {
      selector: "BinaryExpression[operator='**']:not([right.value=2])",
      message: 'Rounds differently by platform. Use src/core/math/libm.',
    },
    {
      selector: "AssignmentExpression[operator='**=']",
      message: 'Rounds differently by platform. Use src/core/math/libm.',
    },
  ],
}

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'coverage', 'out'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.worker },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
    },
  },
  {
    // What the simulation computes has to be the same bits on every machine,
    // and these are not: see src/core/math/libm.ts. The validation harness is
    // held to it too, because its figures are published.
    files: ['src/core/**/*.ts', 'src/sim/**/*.ts', 'src/library/**/*.ts'],
    ignores: ['**/*.test.ts', 'src/core/math/libm.ts'],
    rules: platformMath,
  },
  {
    files: ['src/sim/validation/**/*.test.ts'],
    rules: platformMath,
  },
  {
    files: ['**/*.test.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // Build and smoke scripts run under Node and drive a real browser.
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { 'no-console': 'off' },
  },
)
