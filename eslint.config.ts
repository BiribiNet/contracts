import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import perfectionist from 'eslint-plugin-perfectionist';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  tseslint.configs.eslintRecommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  { ignores: ['artifacts', 'cache', 'coverage', '*.js', '*.mjs', '*.cjs'] },
  {
    rules: {
      'object-shorthand': ['warn', 'always'],
      '@typescript-eslint/array-type': ['error', { default: 'array' }],
      '@typescript-eslint/consistent-type-exports': ['error', { fixMixedExportsWithInlineTypeSpecifier: true }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { vars: 'all', args: 'all', argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },
  },
  {
    plugins: { perfectionist },
    rules: {
      'perfectionist/sort-named-imports': ['error', { groupKind: 'values-first' }],
      'perfectionist/sort-exports': ['error', { groupKind: 'values-first' }],
      'perfectionist/sort-named-exports': ['error', { groupKind: 'values-first' }],
      'perfectionist/sort-imports': [
        'error',
        {
          groups: [
            'builtin',
            'hardhat',
            'external',
            'side-effect',
            'internal',
            'parent',
            ['index', 'sibling'],
            'style',
          ],
          customGroups: { value: { hardhat: ['hardhat', 'hardhat*', 'hardhat/**'] } },
        },
      ],
    },
    settings: {
      perfectionist: {
        type: 'natural',
        order: 'asc',
        ignoreCase: false,
        specialCharacters: 'keep',
        partitionByComment: false,
        partitionByNewLine: true,
      },
    },
  },
);
