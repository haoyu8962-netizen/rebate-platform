// ESLint flat config (ESLint 10 + typescript-eslint 8).
// Protected path, class 2 (verify config): changing it needs owner approval (规划/11 §4.4).
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';
import { platform } from './packages/contracts-ts/src/enums.gen.ts';
import { stylePlugin, styleRules } from './lint/style/index.js';

const TS_FILES = ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'];
const TEST_FILES = ['**/*.test.ts', '**/*.test.tsx', 'test/**/*.ts'];
const FUNDS_PURE_FILES = ['packages/money/**/*.ts', 'packages/domain/**/*.ts'];

// 规划/11 §4.1: no `.skip` / `.only` (any chained form, e.g. `describe.only`, `it.skip.each`,
// `ctx.skip()`), no conditional skipping, no `.todo` placeholders.
const NO_SKIP_OR_ONLY = [
  {
    selector:
      "MemberExpression[property.type='Identifier'][property.name=/^(only|skip|skipIf|runIf|todo)$/]",
    message: 'Tests must not be skipped, focused or left as todo (规划/11 §4.1).',
  },
  {
    selector:
      "MemberExpression[computed=true][property.type='Literal'][property.value=/^(only|skip|skipIf|runIf|todo)$/]",
    message: 'Tests must not be skipped, focused or left as todo (规划/11 §4.1).',
  },
];

// 规划/11 §4.2 clock guard + AGENTS.md hard rule 1 (integer money, no floating point).
const NO_WALL_CLOCK_OR_FLOAT = [
  {
    selector: "NewExpression[callee.name='Date']",
    message: 'No `new Date(` in money/domain: time comes from the injected Clock (规划/11 §4.2).',
  },
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message: 'No `Date.now(` in money/domain: time comes from the injected Clock (规划/11 §4.2).',
  },
  {
    selector:
      "CallExpression[callee.property.name='slice'][callee.object.type='CallExpression'][callee.object.callee.property.name='toISOString']",
    message:
      'No `toISOString().slice`: derive dates with accountingDate()/settlePeriod() (规划/11 §4.2).',
  },
  {
    selector: "CallExpression[callee.name='parseFloat']",
    message: 'No floating point in money/domain: amounts are bigint fen.',
  },
  {
    selector: "MemberExpression[object.name='Number'][property.name='parseFloat']",
    message: 'No floating point in money/domain: amounts are bigint fen.',
  },
  {
    selector: "CallExpression[callee.property.name='toFixed']",
    message: 'No floating point in money/domain: amounts are bigint fen.',
  },
];

// Conventions C12 / apps/api/AGENTS.md: application code reads time only through the injected
// Clock; the clock module itself is the single place that touches the wall clock.
const NO_WALL_CLOCK_IN_APP = [
  {
    selector: "NewExpression[callee.name='Date']",
    message: 'No `new Date(` in app code: use the injected Clock (modules/platform/clock).',
  },
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message: 'No `Date.now(` in app code: use the injected Clock (modules/platform/clock).',
  },
];

// D10-254: orders keeps platform differences in domain/platform-rules, so elsewhere in orders a
// platform code is never compared directly (`===` / `!==` operand or `case` test). Names come
// from the contract enum; only direct operands and case tests match, so call arguments, log
// text and object keys stay allowed.
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const PLATFORM_NAME = `/^(${platform.map(escapeRegExp).join('|')})$/`;
const PLATFORM_LITERAL_MESSAGE =
  'No platform-name comparison in orders: put platform differences in domain/platform-rules.';
const NO_PLATFORM_LITERAL_COMPARE = [
  {
    selector: `BinaryExpression[operator=/^[!=]==$/] > Literal.left[value=${PLATFORM_NAME}]`,
    message: PLATFORM_LITERAL_MESSAGE,
  },
  {
    selector: `BinaryExpression[operator=/^[!=]==$/] > Literal.right[value=${PLATFORM_NAME}]`,
    message: PLATFORM_LITERAL_MESSAGE,
  },
  {
    selector: `SwitchCase > Literal.test[value=${PLATFORM_NAME}]`,
    message: PLATFORM_LITERAL_MESSAGE,
  },
];

// 规划/03 §10.3: front-end source never hard-codes Chinese copy; it reads dictionary keys
// (src/texts/** holds the dictionaries). CJK symbols and punctuation, CJK ideographs (incl.
// extension A and compatibility forms) and full-width forms.
const CJK = '[\\u3000-\\u303f\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef]';
const CJK_MESSAGE =
  'No hard-coded Chinese in front-end source: use a dictionary key (规划/03 §10.3).';
const NO_HARD_CODED_CHINESE = [
  { selector: `Literal[value=/${CJK}/]`, message: CJK_MESSAGE },
  { selector: `TemplateElement[value.cooked=/${CJK}/]`, message: CJK_MESSAGE },
  { selector: `JSXText[value=/${CJK}/]`, message: CJK_MESSAGE },
];
const FRONTEND_SOURCES = ['apps/h5/src/**/*.{ts,tsx}', 'apps/admin/src/**/*.{ts,tsx}'];
const FRONTEND_TEXTS = ['apps/h5/src/texts/**', 'apps/admin/src/texts/**'];

// TECH-28: the untyped bridge `invoke` is for the conformance page only.
const CONFORMANCE_SUBPATH = '@couli/bridge-sdk/conformance';
const CONFORMANCE_MESSAGE =
  'The untyped bridge invoke is for entries/conformance only: use @couli/bridge-sdk (TECH-28).';
const H5_CONFORMANCE_ENTRY = 'apps/h5/src/entries/conformance/**';
const NO_DYNAMIC_CONFORMANCE_IMPORT = [
  {
    selector: `ImportExpression[source.value='${CONFORMANCE_SUBPATH}']`,
    message: CONFORMANCE_MESSAGE,
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.tmp/**',
      '**/.turbo/**',
      '**/*.gen.ts',
      '**/coverage/**',
      '**/reports/**',
    ],
  },
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  {
    files: TS_FILES,
    extends: [tseslint.configs.recommended],
  },
  {
    // Type-aware rules only where promises matter at runtime: app and library sources.
    files: [
      'apps/*/src/**/*.ts',
      'apps/*/src/**/*.tsx',
      'packages/*/src/**/*.ts',
      'packages/*/src/**/*.tsx',
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    // React front ends (规划/03 §8, §9): rules of hooks plus the React Compiler checks.
    files: ['apps/h5/**/*.{ts,tsx}', 'apps/admin/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
  },
  {
    files: ['apps/h5/src/**/*.{ts,tsx}'],
    ignores: [H5_CONFORMANCE_ENTRY],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: CONFORMANCE_SUBPATH, message: CONFORMANCE_MESSAGE }],
          patterns: [
            {
              group: [`${CONFORMANCE_SUBPATH}/*`, '**/packages/bridge-sdk/**'],
              message: CONFORMANCE_MESSAGE,
            },
          ],
        },
      ],
    },
  },
  {
    // Application code logs through pino only; CLIs under tools/ and scripts/ may print.
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts', '**/*.js', '**/*.mjs', '**/*.cjs'],
    ignores: ['tools/**', '**/scripts/**'],
    rules: { 'no-console': 'error' },
  },
  {
    files: TEST_FILES,
    ignores: FUNDS_PURE_FILES,
    rules: { 'no-restricted-syntax': ['error', ...NO_SKIP_OR_ONLY] },
  },
  {
    files: FUNDS_PURE_FILES,
    ignores: TEST_FILES,
    rules: { 'no-restricted-syntax': ['error', ...NO_WALL_CLOCK_OR_FLOAT] },
  },
  {
    files: ['apps/api/**/*.ts'],
    ignores: ['apps/api/src/modules/platform/clock/**', 'apps/api/scripts/**', ...TEST_FILES],
    rules: { 'no-restricted-syntax': ['error', ...NO_WALL_CLOCK_IN_APP] },
  },
  {
    // Replaces the apps/api entry above for these files, so it repeats NO_WALL_CLOCK_IN_APP.
    files: ['apps/api/src/modules/orders/**/*.ts'],
    ignores: ['apps/api/src/modules/orders/domain/platform-rules/**', ...TEST_FILES],
    rules: {
      'no-restricted-syntax': ['error', ...NO_WALL_CLOCK_IN_APP, ...NO_PLATFORM_LITERAL_COMPARE],
    },
  },
  {
    // A later `no-restricted-syntax` entry replaces an earlier one, so money/domain tests get
    // both lists in a single entry.
    files: ['packages/money/**/*.test.ts', 'packages/domain/**/*.test.ts'],
    rules: { 'no-restricted-syntax': ['error', ...NO_SKIP_OR_ONLY, ...NO_WALL_CLOCK_OR_FLOAT] },
  },
  {
    // Front-end sources (tests and dictionaries excluded). No earlier `no-restricted-syntax`
    // entry matches these files, so nothing is replaced.
    files: FRONTEND_SOURCES,
    ignores: [...TEST_FILES, ...FRONTEND_TEXTS],
    rules: { 'no-restricted-syntax': ['error', ...NO_HARD_CODED_CHINESE] },
  },
  {
    // apps/h5 outside the conformance entry: the entry above plus the dynamic-import ban, in one
    // entry because it replaces the previous one for these files.
    files: ['apps/h5/src/**/*.{ts,tsx}'],
    ignores: [...TEST_FILES, ...FRONTEND_TEXTS, H5_CONFORMANCE_ENTRY],
    rules: {
      'no-restricted-syntax': ['error', ...NO_HARD_CODED_CHINESE, ...NO_DYNAMIC_CONFORMANCE_IMPORT],
    },
  },
  {
    // LINT-STYLE-web (规划/05 §3.11.3): no hard-coded styles in H5 / admin source; the existing
    // violations are tolerated up to lint/style/baseline.json, which only shrinks.
    files: FRONTEND_SOURCES,
    ignores: TEST_FILES,
    plugins: { 'couli-style': stylePlugin },
    processor: 'couli-style/baseline',
    rules: styleRules,
  },
);
