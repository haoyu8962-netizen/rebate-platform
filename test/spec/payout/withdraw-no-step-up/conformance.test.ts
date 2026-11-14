// B1-02zzzc / D10-1671: packages/contracts-ts/scripts/conformance.ts keeps two lists in sync with
// the contract — the four sensitive operations (提现、改收款、换号、注销; each carries
// `x-sensitive-operation: true`, nothing else does) and the three that still need step-up (x-step-up;
// POST /v1/withdrawals no longer does, D10-1665). Each case first proves the real openapi.yaml and
// the unmutated fixture pass, so only the mutation can produce the reported problem.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  at,
  openapi,
  parseYamlLite,
  root,
  testRequire,
  yaml,
  type Obj,
} from '../../contracts/hygiene/kit.ts';

const { checkConformance } = testRequire(
  '../../../../packages/contracts-ts/scripts/conformance.ts',
) as typeof import('../../../../packages/contracts-ts/scripts/conformance.ts');
const { loadEnums, loadErrorCodes } = testRequire(
  '../../../../packages/contracts-ts/scripts/catalog.ts',
) as typeof import('../../../../packages/contracts-ts/scripts/catalog.ts');

type Where = [method: string, path: string];
const SENSITIVE: Where[] = [
  ['post', '/v1/withdrawals'],
  ['put', '/v1/me/payout-account'],
  ['post', '/v1/me/phone'],
  ['post', '/v1/me/deletion'],
];
const NOT_SENSITIVE: Where[] = [
  ['post', '/v1/idempotency-keys/abandon'],
  ['get', '/v1/withdrawals/rules'],
  ['post', '/v1/auth/step-up'],
];
const BAD_VALUES: [method: string, path: string, value: boolean | string][] = SENSITIVE.flatMap(
  ([method, path]): [string, string, boolean | string][] => [
    [method, path, false],
    [method, path, 'true'],
  ],
);
const TIMEOUT = 30_000;

/**
 * The real contract with only the four sensitive operations and `extra` kept under paths
 * (components unchanged), written to a temporary openapi.yaml; returns the problems after `mutate`.
 */
function problemsAfter(extra: Where[], mutate: (doc: Obj) => void): string[] {
  const enums = loadEnums();
  const { codes } = loadErrorCodes();
  expect(checkConformance(enums, codes), '真实 openapi.yaml 必须继续通过').toEqual([]);
  const doc = openapi();
  const paths: Obj = {};
  for (const [method, path] of [...SENSITIVE, ...extra]) {
    const item = (paths[path] ?? {}) as Obj;
    item[method] = at(doc, 'paths', path, method);
    paths[path] = item;
  }
  doc['paths'] = paths;
  const parent = fileURLToPath(new URL('.tmp/b1-02zzzc-conformance/', root));
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'contract-'));
  const file = join(directory, 'openapi.yaml');
  const write = (): string => {
    const source = yaml(doc);
    expect(parseYamlLite(source), '夹具序列化不得改变文档').toEqual(doc);
    writeFileSync(file, source);
    return source;
  };
  try {
    const original = write();
    expect(checkConformance(enums, codes, file), '未变异夹具必须通过').toEqual([]);
    mutate(doc);
    expect(write(), '变异必须改变夹具').not.toBe(original);
    return checkConformance(enums, codes, file);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function reported(problems: string[], where: string, pattern: RegExp): void {
  expect(
    problems.some((problem) => problem.includes(where) && pattern.test(problem)),
    JSON.stringify(problems),
  ).toBe(true);
}

it.each(SENSITIVE)(
  '[AC-B1-02zzzc#18] %s %s 缺 x-sensitive-operation 时 conformance 报错',
  (method, path) => {
    const problems = problemsAfter([], (doc) => {
      delete at(doc, 'paths', path, method)['x-sensitive-operation'];
    });
    reported(problems, `${method.toUpperCase()} ${path}`, /x-sensitive-operation|sensitive/iu);
  },
  TIMEOUT,
);

it.each(BAD_VALUES)(
  '[AC-B1-02zzzc#19] %s %s 的 x-sensitive-operation 为 %j（不是布尔 true）时报错',
  (method, path, value) => {
    const problems = problemsAfter([], (doc) => {
      at(doc, 'paths', path, method)['x-sensitive-operation'] = value;
    });
    reported(problems, `${method.toUpperCase()} ${path}`, /x-sensitive-operation|sensitive/iu);
  },
  TIMEOUT,
);

it.each(NOT_SENSITIVE)(
  '[AC-B1-02zzzc#20] 四个敏感操作以外的 %s %s 带 x-sensitive-operation: true 时报错',
  (method, path) => {
    const problems = problemsAfter([[method, path]], (doc) => {
      at(doc, 'paths', path, method)['x-sensitive-operation'] = true;
    });
    reported(problems, `${method.toUpperCase()} ${path}`, /x-sensitive-operation|sensitive/iu);
  },
  TIMEOUT,
);

it(
  '[AC-B1-02zzzc#21] POST /v1/withdrawals 再带 x-step-up withdraw（连同 X-Step-Up-Token 与 10003）时报错：提现不再是 step-up 操作',
  () => {
    const problems = problemsAfter([], (doc) => {
      const op = at(doc, 'paths', '/v1/withdrawals', 'post');
      op['x-step-up'] = 'withdraw';
      const parameters = op['parameters'] as Obj[];
      const ref = '#/components/parameters/StepUpToken';
      if (!parameters.some((p) => p['$ref'] === ref)) parameters.push({ $ref: ref });
      const codes = op['x-error-codes'] as number[];
      if (!codes.includes(10003)) codes.push(10003);
    });
    reported(problems, 'POST /v1/withdrawals', /x-step-up/u);
  },
  TIMEOUT,
);
