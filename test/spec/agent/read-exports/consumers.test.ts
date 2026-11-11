// B3-16b · BR-AI-02 ④(c) (D32; 规划/05 B3-16 第二张, D10-1226; AC-S1-150): whoever reads the two
// read-only entries uses named value imports of registered names only. Scan over apps/api/src/**
// (test files excluded; rules in ./kit.ts consumerScan): every import, re-export, require, dynamic
// or type-level import that reaches ledger/read.ts or payout/read.ts. get_my_earnings' reads live in
// the composition root's apps/api/src/agent-earnings-reads.ts (D10-1244), which imports both;
// agent/** reaches neither (as [AC-B3-16a#15]). One more reader exists on the trunk and is kept
// as it is: app.module.ts imports ledger/read.ts getWalletSummary for GET /v1/me's balance
// (B1-02zn) — a named value import, the same form ④(c) asks of the agent side.
//
// 先红：#5 的登记名取自清单，主干没有清单文件，因「清单缺失」断言失败；#6 先用内存样例自证，
// 再用 loadManifest() 登记的名字扫描真实 apps/api/src/**，同样因「清单缺失」断言失败。
import { expect, it } from 'vitest';
import {
  AGENT_DIR,
  APP_MODULE,
  COMPOSITION_READS,
  LEDGER_READ,
  PAYOUT_READ,
  apiSources,
  consumerScan,
  loadManifest,
  registeredNames,
  type SourceText,
} from './kit.ts';

/** The files that may read an entry, and which. */
const READERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [COMPOSITION_READS, new Set([LEDGER_READ, PAYOUT_READ])],
  [APP_MODULE, new Set([LEDGER_READ])],
]);

it('[AC-B3-16b#5][BR-AI-02] ④(c) apps/api/src/**（测试文件除外）里引到 ledger/read.ts、payout/read.ts 的地方只有组装根 agent-earnings-reads.ts（两入口都引）与 app.module.ts（只引 ledger/read.ts，GET /v1/me 余额）；全部是具名值导入且只导入清单登记的名字，没有命名空间 / 默认 / 副作用 / 类型导入、动态 import()、require、import = require 或转出；agent/** 一处也没有', () => {
  const registered = registeredNames(loadManifest());
  const scan = consumerScan(apiSources(), registered, READERS);
  expect(scan.problems).toEqual([]);
  expect(scan.reaches.filter((reach) => reach.file.startsWith(`${AGENT_DIR}/`))).toEqual([]);
  const composition = scan.reaches
    .filter((reach) => reach.file === COMPOSITION_READS)
    .map((reach) => `${reach.kind} ${reach.entry}`)
    .sort();
  expect(composition, 'the composition root imports each entry once').toEqual([
    `import ${LEDGER_READ}`,
    `import ${PAYOUT_READ}`,
  ]);
}, 180_000);

// ---------------------------------------------------------------- in-memory consumer samples

const SAMPLE_DIR = 'apps/api/src/__b3_16b_samples__';
const LEDGER = '../modules/ledger/read.ts';
const PAYOUT = '../modules/payout/read.ts';
/** Registered names of the samples (synthetic, not the manifest). */
const REGISTERED: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [LEDGER_READ, new Set(['getWalletSummary'])],
  [PAYOUT_READ, new Set(['listWithdrawalsForUser'])],
]);

interface ConsumerSpec {
  readonly label: string;
  readonly text: string;
  /** Why it must fail (problem tags); absent for an allowed sample. */
  readonly reason?: RegExp;
  /** Where the sample lives; default a reader file allowed for both entries. */
  readonly path?: string;
  /** How many references to an entry the scan must find in it. */
  readonly reaches: number;
}

const VIOLATING: readonly ConsumerSpec[] = [
  {
    label: '取数方 import * as L',
    text: `import * as L from '${LEDGER}';\nexport const read = L.getWalletSummary;`,
    reason: /\[namespace-import\]/u,
    reaches: 1,
  },
  {
    label: 'import * as（.js 后缀写法）',
    text: `import * as L from '../modules/ledger/read.js';\nexport const read = L;`,
    reason: /\[namespace-import\]/u,
    reaches: 1,
  },
  {
    label: '默认导入',
    text: `import L from '${LEDGER}';\nexport const read = L;`,
    reason: /\[default-import\]/u,
    reaches: 1,
  },
  {
    label: '默认导入与具名导入并用',
    text: `import L, { getWalletSummary } from '${LEDGER}';\nexport const read = [L, getWalletSummary];`,
    reason: /\[default-import\]/u,
    reaches: 1,
  },
  {
    label: '动态 import()',
    text: `export async function read() {\n  return (await import('${PAYOUT}')).listWithdrawalsForUser;\n}`,
    reason: /\[dynamic-import\]/u,
    reaches: 1,
  },
  {
    label: '动态 import()（无后缀写法）',
    text: `export async function read() {\n  return import('../modules/payout/read');\n}`,
    reason: /\[dynamic-import\]/u,
    reaches: 1,
  },
  {
    label: 'require()',
    text: `export function read() {\n  return require('${PAYOUT}');\n}`,
    reason: /\[require\]/u,
    reaches: 1,
  },
  {
    label: 'import = require',
    text: `import P = require('${PAYOUT}');\nexport const read = P;`,
    reason: /\[import-equals\]/u,
    reaches: 1,
  },
  {
    label: '具名转出',
    text: `export { getWalletSummary } from '${LEDGER}';`,
    reason: /\[re-export\]/u,
    reaches: 1,
  },
  {
    label: 'export * 转出',
    text: `export * from '${PAYOUT}';`,
    reason: /\[re-export\]/u,
    reaches: 1,
  },
  {
    label: 'import type',
    text: `import type { getWalletSummary } from '${LEDGER}';\nexport type Read = typeof getWalletSummary;`,
    reason: /\[type-import\]/u,
    reaches: 1,
  },
  {
    label: 'import { type … }',
    text: `import { type listWithdrawalsForUser } from '${PAYOUT}';\nexport type R = typeof listWithdrawalsForUser;`,
    reason: /\[type-import\]/u,
    reaches: 1,
  },
  {
    label: '类型层 import()',
    text: `export type Entry = typeof import('${LEDGER}');`,
    reason: /\[type-import\]/u,
    reaches: 1,
  },
  {
    label: '副作用导入',
    text: `import '${LEDGER}';`,
    reason: /\[side-effect-import\]/u,
    reaches: 1,
  },
  {
    label: '空的具名导入',
    text: `import {} from '${LEDGER}';`,
    reason: /\[side-effect-import\]/u,
    reaches: 1,
  },
  {
    label: '导入未登记的名字（写命令）',
    text: `import { createWithdrawal } from '${PAYOUT}';\nexport const write = createWithdrawal;`,
    reason: /\[unregistered\]/u,
    reaches: 1,
  },
  {
    label: 'agent/** 里的具名导入',
    path: `${AGENT_DIR}/tools/earnings/__b3_16b_sample__.ts`,
    text: `import { getWalletSummary } from '../../../ledger/read.ts';\nexport const read = getWalletSummary;`,
    reason: /\[consumer\][\s\S]*\[agent\]/u,
    reaches: 1,
  },
  {
    label: '不在读者名单里的文件',
    path: 'apps/api/src/modules/orders/__b3_16b_sample__.ts',
    text: `import { listWithdrawalsForUser } from '../payout/read.ts';\nexport const read = listWithdrawalsForUser;`,
    reason: /\[consumer\]/u,
    reaches: 1,
  },
];

const ALLOWED: readonly ConsumerSpec[] = [
  {
    label: '具名值导入（可起别名），旁边的其他导入不算',
    text: [
      "import type { DB } from '@couli/db';",
      `import { getWalletSummary } from '${LEDGER}';`,
      `import { listWithdrawalsForUser as listMine } from '${PAYOUT}';`,
      "import { readBalancesByUser } from '../modules/ledger/infra/store.ts';",
      'export const reads = [getWalletSummary, listMine, readBalancesByUser];',
      'export type Db = DB;',
    ].join('\n'),
    reaches: 2,
  },
  {
    label: '名字相近的文件不算入口',
    text: [
      "import { a } from '../modules/ledger/application/read.ts';",
      "import { b } from '../modules/payout/read-model.ts';",
      "import * as c from '../modules/payout/index.ts';",
      'export const values = [a, b, c];',
    ].join('\n'),
    reaches: 0,
  },
];

let sampleNo = 0;

function sampleFile(spec: ConsumerSpec): SourceText {
  sampleNo += 1;
  return { path: spec.path ?? `${SAMPLE_DIR}/consumer-${String(sampleNo)}.ts`, text: spec.text };
}

it('[AC-B3-16b#6][BR-AI-02] ④(c) 取数方扫描先用内存样例自证（AC-S1-150）：import * as L（含 .js 写法）、默认导入、动态 import()（含无后缀写法）、require、import = require、转出、类型导入、副作用或空导入、导入未登记名字、agent/** 或名单外文件的导入全部判失败且原因对；读者名单内的具名值导入（含别名）判通过，名字相近的非入口文件不算引到入口；自证后再查真实仓库：用真实清单登记的名字扫描 apps/api/src/**（测试文件除外）无问题', () => {
  const violating = VIOLATING.map((spec) => ({ spec, file: sampleFile(spec) }));
  const allowed = ALLOWED.map((spec) => ({ spec, file: sampleFile(spec) }));
  // Every sample in the default directory is a reader allowed for both entries.
  const readers = new Map<string, ReadonlySet<string>>();
  for (const { file } of [...violating, ...allowed]) {
    if (file.path.startsWith(`${SAMPLE_DIR}/`)) {
      readers.set(file.path, new Set([LEDGER_READ, PAYOUT_READ]));
    }
  }
  for (const { spec, file } of violating) {
    const scan = consumerScan([file], REGISTERED, readers);
    expect(scan.reaches.length, `${spec.label}\n${file.text}`).toBe(spec.reaches);
    expect(scan.problems.length, `${spec.label}\n${file.text}`).toBeGreaterThan(0);
    expect(spec.reason, spec.label).toBeDefined();
    if (spec.reason !== undefined) {
      expect(scan.problems.join('\n'), spec.label).toMatch(spec.reason);
    }
  }
  for (const { spec, file } of allowed) {
    const scan = consumerScan([file], REGISTERED, readers);
    expect(scan.reaches.length, spec.label).toBe(spec.reaches);
    expect(scan.problems, spec.label).toEqual([]);
  }
  // Then the same scan on the real repo, with the names the real manifest registers.
  const real = consumerScan(apiSources(), registeredNames(loadManifest()), READERS);
  expect(real.problems).toEqual([]);
}, 180_000);
