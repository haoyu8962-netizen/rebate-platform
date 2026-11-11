// B3-16d · BR-AI-02 ③④ (D32; FU-B316B-RELAY, B3-16b spec-test r1 S2): the readers of ledger/read.ts
// and payout/read.ts (the composition root's agent-earnings-reads.ts, app.module.ts) must not hand
// the imported functions on, so no other file can take them from a reader instead of the
// registered entry. B3-16b's consumerScan only sees references with a module specifier; here a
// bare `export { x }`, `export { x as y }`, `export default x`, `export = x`, or putting x into an
// exported object / variable (or any other value use) fails; calling x(…) and `typeof x` pass.
// Rules in ./kit.ts relayScan. The check proves itself on in-memory samples (never written to
// disk) first, then runs on every real reader the B3-16b scan finds in apps/api/src/**.
import { expect, it } from 'vitest';
import {
  APP_MODULE,
  COMPOSITION_READS,
  LEDGER_READ,
  PAYOUT_READ,
  apiSources,
  consumerScan,
  loadManifest,
  registeredNames,
  type SourceText,
} from '../read-exports/kit.ts';
import { relayScan } from './kit.ts';

const SAMPLE_DIR = 'apps/api/src/__b3_16d_samples__';
const LEDGER = '../modules/ledger/read.ts';
const PAYOUT = '../modules/payout/read.ts';
const IMPORT_LEDGER = `import { getWalletSummary } from '${LEDGER}';`;
const IMPORT_PAYOUT = `import { listWithdrawalsForUser } from '${PAYOUT}';`;
/** The readers B3-16b allows (④(c)), for the cross-check against its scan. */
const READERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [COMPOSITION_READS, new Set([LEDGER_READ, PAYOUT_READ])],
  [APP_MODULE, new Set([LEDGER_READ])],
]);
/** Synthetic registered names for the samples. */
const REGISTERED: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [LEDGER_READ, new Set(['getWalletSummary'])],
  [PAYOUT_READ, new Set(['listWithdrawalsForUser'])],
]);

interface RelaySpec {
  readonly label: string;
  readonly text: string;
  /** Why it must fail; absent for an allowed sample. */
  readonly reason?: RegExp;
  /** Bindings taken from an entry the scan must find. */
  readonly bindings: number;
}

let sampleNo = 0;

function sample(spec: RelaySpec): SourceText {
  sampleNo += 1;
  return { path: `${SAMPLE_DIR}/reader-${String(sampleNo)}.ts`, text: spec.text };
}

/** B3-16b's scan sees the same entry imports in the sample, and nothing wrong with them. */
function expectCleanImports(file: SourceText, bindings: number, label: string): void {
  const readers = new Map([[file.path, new Set([LEDGER_READ, PAYOUT_READ])]]);
  const scan = consumerScan([file], REGISTERED, readers);
  expect(scan.problems, `${label}: the imports themselves pass ④(c)`).toEqual([]);
  expect(scan.reaches.length > 0, label).toBe(bindings > 0);
}

const VIOLATING: readonly RelaySpec[] = [
  {
    label: '导入后无来源 export { x }',
    text: `${IMPORT_LEDGER}\nexport { getWalletSummary };`,
    reason:
      /\[relay-export\][^\n]*getWalletSummary \(from apps\/api\/src\/modules\/ledger\/read\.ts\) exported again as getWalletSummary/u,
    bindings: 1,
  },
  {
    label: '导入后 export { x as y }',
    text: `${IMPORT_LEDGER}\nexport { getWalletSummary as gws };`,
    reason: /\[relay-export\][^\n]*exported again as gws/u,
    bindings: 1,
  },
  {
    label: '别名导入后 export { 别名 }',
    text: `import { listWithdrawalsForUser as listMine } from '${PAYOUT}';\nexport { listMine };`,
    reason: /\[relay-export\][^\n]*listMine \(from apps\/api\/src\/modules\/payout\/read\.ts\)/u,
    bindings: 1,
  },
  {
    label: 'export { x as default }',
    text: `${IMPORT_PAYOUT}\nexport { listWithdrawalsForUser as default };`,
    reason: /\[relay-export\][^\n]*exported again as default/u,
    bindings: 1,
  },
  {
    label: '与其他名字一起转出',
    text: `${IMPORT_LEDGER}\nconst version = 1;\nexport { version, getWalletSummary };`,
    reason: /\[relay-export\][^\n]*getWalletSummary/u,
    bindings: 1,
  },
  {
    label: 'export default x',
    text: `${IMPORT_LEDGER}\nexport default getWalletSummary;`,
    reason: /\[relay-default\][^\n]*getWalletSummary/u,
    bindings: 1,
  },
  {
    label: 'export default { x }',
    text: `${IMPORT_LEDGER}\nexport default { getWalletSummary };`,
    reason: /\[relay-default\][^\n]*getWalletSummary/u,
    bindings: 1,
  },
  {
    label: 'export = x',
    text: `${IMPORT_PAYOUT}\nexport = listWithdrawalsForUser;`,
    reason: /\[relay-equals\][^\n]*listWithdrawalsForUser/u,
    bindings: 1,
  },
  {
    label: 'export const api = { x }（简写属性）',
    text: `${IMPORT_LEDGER}\nexport const api = { getWalletSummary };`,
    reason: /\[relay-value\][^\n]*getWalletSummary/u,
    bindings: 1,
  },
  {
    label: 'export const api = { read: x }',
    text: `${IMPORT_PAYOUT}\nexport const api = { read: listWithdrawalsForUser };`,
    reason: /\[relay-value\][^\n]*listWithdrawalsForUser/u,
    bindings: 1,
  },
  {
    label: 'export const y = x',
    text: `${IMPORT_LEDGER}\nexport const y = getWalletSummary;`,
    reason: /\[relay-value\][^\n]*getWalletSummary/u,
    bindings: 1,
  },
  {
    label: '先赋给本地变量再 export { y }',
    text: `${IMPORT_LEDGER}\nconst y = getWalletSummary;\nexport { y };`,
    reason: /\[relay-value\][^\n]*getWalletSummary/u,
    bindings: 1,
  },
  {
    label: '放进导出的数组',
    text: `${IMPORT_PAYOUT}\nexport const reads = [listWithdrawalsForUser];`,
    reason: /\[relay-value\][^\n]*listWithdrawalsForUser/u,
    bindings: 1,
  },
  {
    label: '导出函数返回 x 本身',
    text: `${IMPORT_LEDGER}\nexport function pick() {\n  return getWalletSummary;\n}`,
    reason: /\[relay-value\][^\n]*getWalletSummary/u,
    bindings: 1,
  },
  {
    label: 'x.bind(…) 后导出',
    text: `${IMPORT_LEDGER}\nexport const bound = getWalletSummary.bind(null);`,
    reason: /\[relay-value\][^\n]*getWalletSummary/u,
    bindings: 1,
  },
  {
    label: '把 x 当参数交给别处',
    text: `${IMPORT_PAYOUT}\ndeclare function register(f: unknown): void;\nregister(listWithdrawalsForUser);`,
    reason: /\[relay-value\][^\n]*listWithdrawalsForUser/u,
    bindings: 1,
  },
];

const ALLOWED: readonly RelaySpec[] = [
  {
    label: '只导入、在函数体里调用、typeof 只作类型，不转出；其他与入口无关的导出照常',
    text: [
      "import type { DB } from '@couli/db';",
      IMPORT_LEDGER,
      `import { listWithdrawalsForUser as listMine } from '${PAYOUT}';`,
      "import { readBalancesByUser } from '../modules/ledger/infra/store.ts';",
      'export interface Deps {',
      '  readonly wallet: Parameters<typeof getWalletSummary>[2];',
      '}',
      'export type List = typeof listMine;',
      'export async function read(db: DB, deps: Deps) {',
      '  const summary = await getWalletSummary(db, { appId: 1, userId: 2 }, deps.wallet);',
      '  const records = await listMine(db, { appId: 1, userId: 2, limit: 1 }, { now: 0 });',
      '  return { summary, latest: records.items[0] ?? null };',
      '}',
      'export const version = 1;',
      'const helper = () => version;',
      'export { helper, readBalancesByUser };',
      'export default read;',
    ].join('\n'),
    bindings: 2,
  },
  {
    label: '同名的本地参数遮蔽导入，转出的是参数不是入口函数',
    text: [
      IMPORT_LEDGER,
      'export function pick(getWalletSummary: () => number) {',
      '  return getWalletSummary;',
      '}',
      'export const run = () => getWalletSummary(0, 0, 0);',
    ].join('\n'),
    bindings: 1,
  },
  {
    label: '名字相近的非入口文件的导入可转出',
    text: [
      "import { getWalletSummary } from '../modules/ledger/application/wallet-summary.ts';",
      "import { a } from '../modules/payout/read-model.ts';",
      'export { getWalletSummary, a };',
    ].join('\n'),
    bindings: 0,
  },
];

it('[AC-B3-16d#1][BR-AI-02] ③④ 读者文件里由只读入口导入的绑定（含别名）再被转出一律判失败且原因对（内存样例自证）：无来源 export { x }、export { x as y }、别名导入后 export { 别名 }、export { x as default }、与其他名字一起转出、export default x / { x }、export = x、放进导出的对象（含简写属性）/ 变量 / 数组、先赋本地变量再转出、导出函数返回 x 本身、x.bind、把 x 当参数交给别处；这些样例的导入本身都过得了 B3-16b 的 ④(c) 扫描', () => {
  for (const spec of VIOLATING) {
    const file = sample(spec);
    const label = `${spec.label}\n${file.text}`;
    expectCleanImports(file, spec.bindings, label);
    const scan = relayScan([file]);
    expect(scan.bindings.length, label).toBe(spec.bindings);
    expect(scan.problems.length, label).toBeGreaterThan(0);
    expect(spec.reason, label).toBeDefined();
    if (spec.reason !== undefined) expect(scan.problems.join('\n'), label).toMatch(spec.reason);
  }
});

it('[AC-B3-16d#2][BR-AI-02] ③④ 正常写法判通过（内存样例自证）：只导入（含别名）、在函数体里调用、typeof 只作类型、与入口无关的导出（本地常量 / 函数、非入口文件的导入、export default 本地函数）照常；同名本地参数遮蔽导入时转出的不是入口函数；名字相近的非入口文件不算入口', () => {
  for (const spec of ALLOWED) {
    const file = sample(spec);
    const label = `${spec.label}\n${file.text}`;
    expectCleanImports(file, spec.bindings, label);
    const scan = relayScan([file]);
    expect(scan.bindings.length, label).toBe(spec.bindings);
    expect(scan.problems, label).toEqual([]);
  }
});

it('[AC-B3-16d#3][BR-AI-02] ③④ 真实仓库：清单登记的两入口在 apps/api/src/**（测试文件除外）里的全部读者（经 B3-16b 扫描找出，含组装根 agent-earnings-reads.ts）逐个查，由入口导入的绑定一个也没被转出或当值交出；先以组装根真实文本末尾追加 export { getWalletSummary } / export { getWalletSummary as gws } 自证判失败', () => {
  const sources = apiSources();
  const scan = consumerScan(sources, registeredNames(loadManifest()), READERS);
  const readerPaths = [...new Set(scan.reaches.map((reach) => reach.file))].sort();
  expect(readerPaths).toContain(COMPOSITION_READS);
  const readers = sources.filter((file) => readerPaths.includes(file.path));
  expect(readers.map((file) => file.path).sort()).toEqual(readerPaths);
  const composition = readers.find((file) => file.path === COMPOSITION_READS);
  expect(composition, COMPOSITION_READS).toBeDefined();
  if (composition !== undefined) {
    for (const [tail, exported] of [
      ['export { getWalletSummary };', 'getWalletSummary'],
      ['export { getWalletSummary as gws };', 'gws'],
    ] as const) {
      const mutated = { path: composition.path, text: `${composition.text}\n${tail}\n` };
      expect(relayScan([mutated]).problems.join('\n'), tail).toMatch(
        new RegExp(`\\[relay-export\\][^\\n]*exported again as ${exported}`, 'u'),
      );
    }
  }
  const real = relayScan(readers);
  // Every entry import B3-16b sees in the readers is a binding followed here.
  const imports = scan.reaches.filter((reach) => reach.kind === 'import').length;
  expect(real.bindings.length).toBeGreaterThanOrEqual(imports);
  expect(real.bindings.map((binding) => binding.file)).toContain(COMPOSITION_READS);
  expect(real.problems).toEqual([]);
}, 180_000);
