// B3-16b · BR-AI-02 ④(a)(b) (D32; 规划/05 B3-16 第二张, D10-1226; AC-S1-150): the two read-only
// entries ledger/read.ts and payout/read.ts export exactly what specs/agent-read-exports.yaml
// registers, each only as `export { 原名 } from '<登记声明文件>'`, checked with the TypeScript
// compiler API (rules and manifest contract in ./kit.ts). The checks prove themselves first on
// in-memory samples (never written to disk), then run on the code.
//
// 先红：主干没有清单文件，#1、#2 因「清单缺失」断言失败；#3、#4 先用内存样例自证，再用
// loadManifest() 读真实清单查真实仓库，同样因「清单缺失」断言失败。
import { expect, it } from 'vitest';
import {
  LEDGER_READ,
  PAYOUT_READ,
  READ_ENTRIES,
  entryProblems,
  exportProgram,
  loadManifest,
  parseManifest,
  renderManifest,
  type ExportItem,
  type SourceText,
} from './kit.ts';

let real: ReturnType<typeof exportProgram> | undefined;

/** One program over the two real entries (and what they import), built inside a test. */
function realProgram(): ReturnType<typeof exportProgram> {
  real ??= exportProgram(READ_ENTRIES);
  return real;
}

function namesOf(items: readonly ExportItem[], entry: string): string[] {
  return items
    .filter((item) => item.entry === entry)
    .map((item) => item.name)
    .sort();
}

it("[AC-B3-16b#1][BR-AI-02] ④(a)(b) 登记清单 specs/agent-read-exports.yaml 存在且按 kit 契约严格解析，只列 ledger/read.ts、payout/read.ts 两个入口：前者恰登记 getWalletSummary（GET /v1/wallet/summary 背后的函数）、后者恰登记 listWithdrawalsForUser（GET /v1/withdrawals 背后的函数）；两入口经编译器得出的导出集合恰等于清单，每个导出只用 export { 原名 } from '<登记声明文件>'，经编译器解析落到登记声明文件里的同名值声明", () => {
  const items = loadManifest();
  expect(namesOf(items, LEDGER_READ)).toEqual(['getWalletSummary']);
  expect(namesOf(items, PAYOUT_READ)).toEqual(['listWithdrawalsForUser']);
  expect(entryProblems(realProgram(), READ_ENTRIES, items)).toEqual([]);
}, 180_000);

it('[AC-B3-16b#2][BR-AI-02] ④(a) 以真实清单为底，多列一项（任一入口多登记一个它不导出的名字）或少列一项（删去任一登记项）时，对真实入口的检查都失败', () => {
  const items = loadManifest();
  const program = realProgram();
  for (const entry of READ_ENTRIES) {
    const base = items.find((item) => item.entry === entry);
    expect(base, `${entry} is registered`).toBeDefined();
    if (base === undefined) continue;
    const extra: ExportItem = {
      entry,
      name: 'createWithdrawal',
      declaredIn: base.declaredIn,
      original: 'createWithdrawal',
    };
    const more = [...items, extra];
    // The manifest itself stays well-formed: only the entry check can catch the extra item.
    expect(parseManifest(renderManifest(more)).problems).toEqual([]);
    expect(entryProblems(program, READ_ENTRIES, more).join('\n')).toMatch(/\[export-set\]/u);
  }
  items.forEach((dropped, index) => {
    const fewer = items.filter((_, other) => other !== index);
    const problems = entryProblems(program, READ_ENTRIES, fewer).join('\n');
    expect(problems, `without ${dropped.name}`).toMatch(/\[unregistered\]|\[export-set\]/u);
  });
}, 180_000);

// ---------------------------------------------------------------- in-memory entry samples

const DIR = 'apps/api/src/modules/payout/__b3_16b_samples__';
const SERVICE = `${DIR}/service.ts`;
const RELAY = `${DIR}/relay.ts`;
const READ = 'listWithdrawalsForUser';
const COUNT = 'countWithdrawalsForUser';

const DECLARATIONS: SourceText[] = [
  {
    path: SERVICE,
    text: [
      `export function ${READ}(userId: string): readonly string[] {`,
      '  void userId;',
      '  return [];',
      '}',
      `export function ${COUNT}(userId: string): number {`,
      '  void userId;',
      '  return 0;',
      '}',
      'export function createWithdrawal(userId: string, amountFen: bigint): void {',
      '  void userId;',
      '  void amountFen;',
      '}',
      'export default function defaultRead(): readonly string[] {',
      '  return [];',
      '}',
    ].join('\n'),
  },
  { path: RELAY, text: `export { ${READ} } from './service.ts';` },
];

interface SampleSpec {
  readonly label: string;
  readonly text: string;
  /** Why it must fail (problem tags); absent for an allowed sample. */
  readonly reason?: RegExp;
  /** [name, declared file] registered for the sample entry; default [[READ, SERVICE]]. */
  readonly registered?: readonly (readonly [string, string])[];
}

interface EntrySample {
  readonly label: string;
  readonly file: SourceText;
  readonly items: readonly ExportItem[];
  readonly reason: RegExp | null;
}

let sampleNo = 0;

function entrySample(spec: SampleSpec): EntrySample {
  sampleNo += 1;
  const path = `${DIR}/entry-${String(sampleNo)}.ts`;
  const registered = spec.registered ?? [[READ, SERVICE]];
  return {
    label: spec.label,
    file: { path, text: spec.text },
    items: registered.map(([name, declaredIn]) => ({
      entry: path,
      name,
      declaredIn,
      original: name,
    })),
    reason: spec.reason ?? null,
  };
}

const BOTH: readonly (readonly [string, string])[] = [
  [READ, SERVICE],
  [COUNT, SERVICE],
];

const VIOLATING_SPECS: readonly SampleSpec[] = [
  {
    label: '入口多导出一个写命令（同一行）',
    text: `export { ${READ}, createWithdrawal } from './service.ts';`,
    reason: /\[unregistered\][\s\S]*\[export-set\]/u,
  },
  {
    label: '入口多导出一个写命令（另起一行）',
    text: `export { ${READ} } from './service.ts';\nexport { createWithdrawal } from './service.ts';`,
    reason: /\[unregistered\][\s\S]*\[export-set\]/u,
  },
  {
    label: '改名伪装 export { createWithdrawal as listWithdrawalsForUser }',
    text: `export { createWithdrawal as ${READ} } from './service.ts';`,
    reason: /\[rename\][\s\S]*\[resolution\]/u,
  },
  {
    label: '改名伪装 export { default as listWithdrawalsForUser }',
    text: `export { default as ${READ} } from './service.ts';`,
    reason: /\[rename\]/u,
  },
  {
    label: 'import * as svc 后再导出',
    text: `import * as svc from './service.ts';\nexport { svc };`,
    reason: /\[statement\][\s\S]*\[local-export\]/u,
  },
  {
    label: 'import * as svc 后以常量再导出',
    text: `import * as svc from './service.ts';\nexport const ${READ} = svc.${READ};`,
    reason: /\[statement\]/u,
  },
  {
    label: 'export * from',
    text: `export * from './service.ts';`,
    reason: /\[export-star\]/u,
  },
  {
    label: 'export * as',
    text: `export * as svc from './service.ts';`,
    reason: /\[namespace-export\]/u,
  },
  {
    label: '本地包装函数',
    text: [
      `import { ${READ} as inner } from './service.ts';`,
      `export function ${READ}(userId: string): readonly string[] {`,
      '  return inner(userId);',
      '}',
    ].join('\n'),
    reason: /\[statement\]/u,
  },
  {
    label: '本地定义',
    text: `export function ${READ}(userId: string): readonly string[] {\n  return [userId];\n}`,
    reason: /\[statement\]/u,
  },
  {
    label: '先 import 再 export { 名 }（本地绑定转出）',
    text: `import { ${READ} } from './service.ts';\nexport { ${READ} };`,
    reason: /\[statement\][\s\S]*\[local-export\]/u,
  },
  {
    label: '多一个默认导出',
    text: `export { ${READ} } from './service.ts';\nexport default function extra(): void {}`,
    reason: /\[statement\][\s\S]*\[export-set\]/u,
  },
  {
    label: 'export { default } from',
    text: `export { ${READ} } from './service.ts';\nexport { default } from './service.ts';`,
    reason: /\[unregistered\]/u,
  },
  {
    label: '经中转文件导出（登记的是真实声明文件）',
    text: `export { ${READ} } from './relay.ts';`,
    reason: /\[declaration-file\]/u,
  },
  {
    label: '经中转文件导出（清单把中转文件登记为声明文件）',
    text: `export { ${READ} } from './relay.ts';`,
    reason: /\[resolution\]/u,
    registered: [[READ, RELAY]],
  },
  {
    label: 'export type { … } from',
    text: `export type { ${READ} } from './service.ts';`,
    reason: /\[type-only\]/u,
  },
  {
    label: 'export { type … } from',
    text: `export { type ${READ} } from './service.ts';`,
    reason: /\[type-only\]/u,
  },
  {
    label: '入口另有 import',
    text: `import './service.ts';\nexport { ${READ} } from './service.ts';`,
    reason: /\[statement\]/u,
  },
  {
    label: '入口少导出登记项',
    text: '// nothing exported\n',
    reason: /\[export-set\]/u,
  },
  {
    label: '清单多列一项',
    text: `export { ${READ} } from './service.ts';`,
    reason: /\[export-set\]/u,
    registered: BOTH,
  },
  {
    label: '清单少列一项',
    text: `export { ${READ}, ${COUNT} } from './service.ts';`,
    reason: /\[unregistered\][\s\S]*\[export-set\]/u,
  },
];

const ALLOWED_SPECS: readonly SampleSpec[] = [
  {
    label: '正常写法（带注释）',
    text: `// BR-AI-02 ④: the read-only entry.\nexport { ${READ} } from './service.ts';`,
  },
  {
    label: '同一声明文件的两个登记名',
    text: `export { ${READ}, ${COUNT} } from './service.ts';`,
    registered: BOTH,
  },
  {
    label: '两个登记名分两行',
    text: `export { ${READ} } from './service.ts';\nexport { ${COUNT} } from './service.ts';`,
    registered: BOTH,
  },
];

const VIOLATING = VIOLATING_SPECS.map((spec) => entrySample(spec));
const ALLOWED = ALLOWED_SPECS.map((spec) => entrySample(spec));

it("[AC-B3-16b#3][BR-AI-02] ④(a)(b) 检查函数先用内存样例自证（AC-S1-150）：入口多导出写命令、as 改名伪装、import * as 后再导出、export *、export * as、本地包装或定义、本地绑定转出、默认导出、经中转文件、export type、另有 import、少导出、清单多列 / 少列一项全部判失败且原因对；正常 export { 原名 } from '<登记声明文件>' 判通过；自证后再查真实仓库：真实清单对真实两入口的同一检查判通过", () => {
  const samples = [...VIOLATING, ...ALLOWED];
  const program = exportProgram(
    [...samples.map((sample) => sample.file.path), SERVICE, RELAY],
    [...DECLARATIONS, ...samples.map((sample) => sample.file)],
  );
  for (const sample of VIOLATING) {
    const problems = entryProblems(program, [sample.file.path], sample.items);
    expect(problems.length, `${sample.label}\n${sample.file.text}`).toBeGreaterThan(0);
    expect(sample.reason, sample.label).not.toBeNull();
    if (sample.reason !== null) expect(problems.join('\n'), sample.label).toMatch(sample.reason);
  }
  for (const sample of ALLOWED) {
    expect(entryProblems(program, [sample.file.path], sample.items), sample.label).toEqual([]);
  }
  // An item registered for an entry outside the checked ones is a problem too.
  const [first] = ALLOWED;
  expect(first).toBeDefined();
  if (first !== undefined) {
    const stray: ExportItem = { entry: RELAY, name: READ, declaredIn: SERVICE, original: READ };
    const problems = entryProblems(program, [first.file.path], [...first.items, stray]);
    expect(problems.join('\n')).toMatch(/\[entry\]/u);
  }
  // Then the same check on the real repo: the real manifest over the two real entries.
  expect(entryProblems(realProgram(), READ_ENTRIES, loadManifest())).toEqual([]);
}, 180_000);

// ---------------------------------------------------------------- manifest contract samples

const LEDGER_DECL = 'apps/api/src/modules/ledger/application/wallet-summary.ts';
const PAYOUT_DECL = 'apps/api/src/modules/payout/application/withdrawal-reads.ts';
const PAYOUT_DIR = 'apps/api/src/modules/payout';

type Row = Readonly<Record<string, string>>;

const LEDGER_ROW: Row = {
  entry: LEDGER_READ,
  name: 'getWalletSummary',
  declared_in: LEDGER_DECL,
  original: 'getWalletSummary',
};
const PAYOUT_ROW: Row = {
  entry: PAYOUT_READ,
  name: READ,
  declared_in: PAYOUT_DECL,
  original: READ,
};

/** Rows as written (plain scalars, keys in the given order). */
function rows(list: readonly Row[]): string {
  const lines = ['exports:'];
  for (const row of list) {
    Object.entries(row).forEach(([key, value], index) => {
      lines.push(`${index === 0 ? '  - ' : '    '}${key}: ${value}`);
    });
  }
  return `${lines.join('\n')}\n`;
}

/** The two rows with the payout row changed. */
function payout(change: Row): string {
  return rows([LEDGER_ROW, { ...PAYOUT_ROW, ...change }]);
}

interface BadManifest {
  readonly label: string;
  readonly text: string;
  readonly reason: RegExp;
}

const BAD_MANIFESTS: readonly BadManifest[] = [
  { label: '空文件', text: '', reason: /\[shape\]/u },
  { label: '只有注释', text: '# nothing\n', reason: /\[shape\]/u },
  { label: '顶层是列表', text: `- ${LEDGER_READ}\n`, reason: /\[shape\]/u },
  {
    label: '顶层多一个键',
    text: `version: 1\n${rows([LEDGER_ROW, PAYOUT_ROW])}`,
    reason: /\[shape\]/u,
  },
  { label: 'exports 为空', text: 'exports: []\n', reason: /\[shape\]/u },
  {
    label: 'flow 映射（yaml-lite 不收）',
    text: `exports:\n  - {entry: ${LEDGER_READ}}\n`,
    reason: /\[yaml\]/u,
  },
  {
    label: '锚点（yaml-lite 不收）',
    text: `exports:\n  - &a\n    entry: ${LEDGER_READ}\n`,
    reason: /\[yaml\]/u,
  },
  {
    label: '少 original 键',
    text: rows([{ entry: LEDGER_READ, name: 'getWalletSummary', declared_in: LEDGER_DECL }]),
    reason: /\[shape\]/u,
  },
  { label: '多一个键', text: payout({ note: 'x' }), reason: /\[shape\]/u },
  { label: '值是整数', text: payout({ name: '1' }), reason: /\[shape\]/u },
  { label: '值带首尾空格', text: payout({ name: `' ${READ}'` }), reason: /\[shape\]/u },
  {
    label: '入口是 ledger/index.ts',
    text: rows([{ ...LEDGER_ROW, entry: 'apps/api/src/modules/ledger/index.ts' }, PAYOUT_ROW]),
    reason: /\[entry\]/u,
  },
  {
    label: '入口带 ./ 前缀',
    text: rows([{ ...LEDGER_ROW, entry: `./${LEDGER_READ}` }, PAYOUT_ROW]),
    reason: /\[entry\]/u,
  },
  {
    label: '入口是别的模块',
    text: rows([
      LEDGER_ROW,
      PAYOUT_ROW,
      { ...PAYOUT_ROW, entry: 'apps/api/src/modules/settlement/read.ts' },
    ]),
    reason: /\[entry\]/u,
  },
  {
    label: '导出名与原名不同（改名）',
    text: payout({ original: 'createWithdrawal' }),
    reason: /\[name\]/u,
  },
  {
    label: '导出名是 default',
    text: payout({ name: 'default', original: 'default' }),
    reason: /\[name\]/u,
  },
  {
    label: '导出名不是标识符',
    text: payout({ name: 'list-withdrawals', original: 'list-withdrawals' }),
    reason: /\[name\]/u,
  },
  {
    label: '声明文件在别的模块',
    text: payout({ declared_in: LEDGER_DECL }),
    reason: /\[declared_in\]/u,
  },
  {
    label: '声明文件路径含 ..',
    text: payout({ declared_in: `${PAYOUT_DIR}/../ledger/application/x.ts` }),
    reason: /\[declared_in\]/u,
  },
  {
    label: '声明文件是入口本身',
    text: payout({ declared_in: PAYOUT_READ }),
    reason: /\[declared_in\]/u,
  },
  {
    label: '声明文件是模块 index.ts',
    text: payout({ declared_in: `${PAYOUT_DIR}/index.ts` }),
    reason: /\[declared_in\]/u,
  },
  {
    label: '声明文件是 .d.ts',
    text: payout({ declared_in: `${PAYOUT_DIR}/application/x.d.ts` }),
    reason: /\[declared_in\]/u,
  },
  {
    label: '声明文件是测试文件',
    text: payout({ declared_in: `${PAYOUT_DIR}/application/x.test.ts` }),
    reason: /\[declared_in\]/u,
  },
  {
    label: '同一项列两次',
    text: rows([LEDGER_ROW, PAYOUT_ROW, PAYOUT_ROW]),
    reason: /\[duplicate\]/u,
  },
  { label: '只列一个入口', text: rows([LEDGER_ROW]), reason: /\[missing-entry\]/u },
];

it('[AC-B3-16b#4][BR-AI-02] ④(a) 清单按 kit 契约严格解析：合规清单（含注释、plain 或引号值）解析出逐项登记；空文件、顶层形状不对、yaml-lite 不收的写法、少键多键、非字符串或带空格的值、两个入口以外的入口、导出名与原名不同或非标识符或 default、声明文件不在入口所在模块或是入口本身 / index.ts / .d.ts / 测试文件、重复项、漏列入口一律判失败且原因对；自证后再查真实仓库：真实 specs/agent-read-exports.yaml 按契约严格解析成功，恰为两项、两入口各一项', () => {
  const expected: ExportItem[] = [
    {
      entry: LEDGER_READ,
      name: 'getWalletSummary',
      declaredIn: LEDGER_DECL,
      original: 'getWalletSummary',
    },
    { entry: PAYOUT_READ, name: READ, declaredIn: PAYOUT_DECL, original: READ },
  ];
  const plain = parseManifest(`# BR-AI-02 ④\n${rows([LEDGER_ROW, PAYOUT_ROW])}`);
  expect(plain.problems).toEqual([]);
  expect(plain.items).toEqual(expected);
  const rendered = parseManifest(renderManifest(expected));
  expect(rendered.problems).toEqual([]);
  expect(rendered.items).toEqual(expected);

  for (const { label, text, reason } of BAD_MANIFESTS) {
    const result = parseManifest(text);
    expect(result.problems.length, `${label}\n${text}`).toBeGreaterThan(0);
    expect(result.problems.join('\n'), label).toMatch(reason);
    expect(result.items, label).toEqual([]);
  }
  // Then the real manifest: strictly parsed (loadManifest), exactly one item per entry.
  const manifest = loadManifest();
  expect(manifest.length).toBe(2);
  expect(namesOf(manifest, LEDGER_READ)).toHaveLength(1);
  expect(namesOf(manifest, PAYOUT_READ)).toHaveLength(1);
});
