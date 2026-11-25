// 单元测试（静态，不连库）：B2-18 实现必满足项 ①（编排 D10-2415 ③、D10-2567）——月结与补充路径不得以任何方式
// 读取差错单「以联盟为准」结论；r5 按编排 D10-2948 加强，堵住「先编译、再直接执行」绕过运行时探针的写法。
//
// 扫什么（写死在 SCANNED_FILES，测试自己核它完整）：
//   - 闭包：从入口 bill/job.ts（账单日任务）、bill/supplement/command.ts（补充发起）以及 bill/ 下每个非测试源文件
//     出发，沿 settlement 模块内的相对导入（含 import type 与 export … from）走出的传递闭包；
//   - bill/ 目录下全部非测试源文件（含注入的来源读口实现 bill/infra/bill-source.ts）；
//   - 装配文件：application/admin-settle-commands.ts、worker/assemble.ts、worker/ports.ts，以及 app.module.ts 的三段
//     （按文件 / 片段扫，不沿它们的导入往外走：它们还装配别的命令）。
//   「闭包 ∪ bill/ ∪ 装配文件」与 SCANNED_FILES 逐项相等，多一个、少一个都红。
//
// 判什么（violations()，对任意文本可调用的纯函数；先去掉注释，字符串与模板字面量保留）：
//   1. 禁用写法：结论读口调用、账本差错单读口、只读库句柄（dbRead / DB_READ）、recon_diffs 的查询构造，以及任何
//      「先编译、再直接执行」的写法（executeQuery、CompiledQuery、.compile(、getExecutor、RawNode）与 sql 的改名。
//   2. 原始 SQL 只许出现在 RAW_SQL_ALLOWLIST 里：每一处 sql 标签模板（按文件 + 去空白后的整句逐条比对）与
//      sql.<成员>( 调用都要落在清单里的一句之内；sql.raw( 的入参只许是本文件以字符串字面量声明的常量名，其余
//      sql.<成员>( 一律不许。sql 这个名字除导入、模板标签、sql.raw( 外不许出现（不许当值传走）。
//   3. 出 settlement 模块的导入：闭包与 bill/ 的文件只许经对方 index.ts 导入 MODULE_BOUNDARY 里列出的名字；
//      npm 包只许 PACKAGES 里的；ledger 一个名字都不许（读口、写口都不经这里，写口由装配注入）。
//   4. 装配处交给月结 / 补充的端口名字写死在 ASSEMBLY_PORTS（旁注各自为什么读不到旧结论）。
//
// 这份清单为什么够、哪里不够（照实写）：补充请求与账单日任务会执行到的 settlement 源文件，就是上面的闭包加装配处
// 注入的读口实现（来源读口 bill/infra/bill-source.ts、逐单结果写口 bill/infra/bill-validations.ts，都在 bill/ 里）。
// 别的模块内部的实现——orders 的订单键锁、commission 的快照读口 / 淘礼金读口 / 重生成用的估值刷新、ledger 的登记
// 只写登记口 registerReconDiffWriteOnly（D10-2982 ②）与快照状态读口、platform 的幂等与配置（content 的配置读口）——不在这份静态扫描里；它们
// 是否在请求内读 recon_diffs，由运行时探针 [AC-B2-18#33]（主库与只读库两个执行器都零读取）与各自模块的规则测试
// 覆盖。这份单测只保证 settlement 这一侧不自己去读、也不把读口接进来，不是「全部覆盖」。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SETTLEMENT = join(HERE, '..');
const MODULES = join(SETTLEMENT, '..');
const APP_MODULE = join(HERE, '../../../app.module.ts');

/** 两个入口：账单日任务与补充发起（后台补充入口经 admin-settle-commands 装配到后者）。 */
const ENTRIES = ['bill/job.ts', 'bill/supplement/command.ts'] as const;

/** 装配文件：整文件扫，不沿导入往外走。 */
const ASSEMBLY_FILES = [
  'application/admin-settle-commands.ts',
  'worker/assemble.ts',
  'worker/ports.ts',
] as const;

/** 写死的扫描清单（相对 settlement 模块根）。 */
const SCANNED_FILES: readonly string[] = [
  'application/admin-settle-commands.ts',
  'batch/credit-gate.ts',
  'bill/follow-union.ts',
  'bill/index.ts',
  'bill/infra/bill-source.ts',
  'bill/infra/bill-validations.ts',
  'bill/infra/order-settlements.ts',
  'bill/job.ts',
  'bill/regenerate.ts',
  'bill/settle-job.ts',
  'bill/supplement/command.ts',
  'bill/supplement/locked-recheck.ts',
  'bill/types.ts',
  'credit/credit-store.ts',
  'rebate/domain/rules.ts',
  'rebate/infra/rebate-store.ts',
  'settlements/deciding.ts',
  'settlements/index.ts',
  'settlements/records.ts',
  'specs/creditable-events.gen.ts',
  'worker/assemble.ts',
  'worker/ports.ts',
];

/**
 * 原始 SQL 允许清单：文件 → 去空白后的整句（模板字面量原文，含 ${…}）与用途。保存点名与锁键都来自本文件的
 * 字面量常量或绑定参数，不拼接运行时文本。
 */
const RAW_SQL_ALLOWLIST: Readonly<Record<string, readonly { sql: string; use: string }[]>> = {
  'batch/credit-gate.ts': [
    {
      sql: 'select pg_advisory_xact_lock_shared(hashtext(${gate.namespace}), hashtext(${gate.key}))',
      use: '平台结算互斥锁共享模式（批次执行器的明细事务用；本路径不执行）',
    },
    {
      sql: 'select pg_advisory_xact_lock(hashtext(${gate.namespace}), hashtext(${gate.key}))',
      use: '平台结算互斥锁排他模式（账单日任务与补充发起，B2-04re）',
    },
  ],
  'bill/follow-union.ts': [
    { sql: 'SAVEPOINT ${sql.raw(SAVEPOINT)}', use: 'follow-union 不一致路径的保存点' },
    { sql: 'ROLLBACK TO SAVEPOINT ${sql.raw(SAVEPOINT)}', use: '不一致 / 失败时回滚该保存点' },
    { sql: 'RELEASE SAVEPOINT ${sql.raw(SAVEPOINT)}', use: '释放该保存点' },
  ],
  'bill/supplement/command.ts': [
    { sql: 'SAVEPOINT ${sql.raw(GATE_SAVEPOINT)}', use: '开关复核保存点（B2-04re r2）' },
    {
      sql: 'ROLLBACK TO SAVEPOINT ${sql.raw(GATE_SAVEPOINT)}',
      use: '锁后开关已关：撤销本次发起的写入',
    },
    { sql: 'RELEASE SAVEPOINT ${sql.raw(GATE_SAVEPOINT)}', use: '释放开关复核保存点' },
    { sql: 'SAVEPOINT ${sql.raw(LOCK_SAVEPOINT)}', use: '候选分块取订单键锁的保存点（B2-04rd）' },
    {
      sql: 'ROLLBACK TO SAVEPOINT ${sql.raw(LOCK_SAVEPOINT)}',
      use: '回滚到分块保存点放掉这一块的订单键锁',
    },
    { sql: 'RELEASE SAVEPOINT ${sql.raw(LOCK_SAVEPOINT)}', use: '释放分块保存点' },
  ],
  'bill/infra/bill-source.ts': [
    {
      sql:
        "SELECT 'order' AS kind, o.order_id::text AS order_id, o.platform, o.sub_order_id, " +
        'o.rebate_status, o.settle_period, o.hold, o.rights_pending, o.commission_version, ' +
        'NULL::integer AS seq, NULL::text AS source, NULL::timestamptz AS created_at, ' +
        'NULL::timestamptz AS settled_at, NULL::bigint AS settle_commission_fen ' +
        'FROM app.orders AS o ' +
        'WHERE o.app_id = ${input.appId} AND o.platform = ${input.platform} ' +
        'UNION ALL ' +
        "SELECT 'settlement' AS kind, s.order_id::text AS order_id, k.platform, k.sub_order_id, " +
        'NULL::text, NULL::text, NULL::boolean, NULL::boolean, NULL::integer, ' +
        's.seq, s.source, s.created_at, s.settled_at, s.settle_commission_fen ' +
        'FROM app.order_settlements AS s ' +
        'INNER JOIN app.order_keys AS k ON k.app_id = s.app_id AND k.order_id = s.order_id ' +
        'WHERE s.app_id = ${input.appId} AND k.platform = ${input.platform} ' +
        'ORDER BY kind, order_id, seq',
      use: '来源读口：orders 与 order_settlements 同一条语句（FU-B204ZD-SNAPSHOT），只读这两张表与 order_keys',
    },
  ],
};

/** 闭包与 bill/ 的文件可以经对方 index.ts 导入的别的模块与名字。 */
const MODULE_BOUNDARY: Readonly<Record<string, readonly string[]>> = {
  // 订单键锁（与入账同一把）；只取锁，不读差错单。
  orders: ['lockOrderKey'],
  // 时钟类型、uuid 生成与任务载荷类型；不含只读库令牌 DB_READ。
  platform: ['Clock', 'JobPayload', 'newUuidV7'],
};

/** 闭包与 bill/ 的文件可以导入的 npm 包。 */
const PACKAGES: readonly string[] = [
  '@couli/contracts-ts',
  '@couli/db',
  '@couli/domain',
  '@couli/money',
  'kysely',
  // settlements/records.ts 用它算结算记录的摘要；不连库。
  'node:crypto',
  'pino',
];

/**
 * 装配处交给月结 / 补充的端口：调用处 → 实参对象的顶层成员（展开项写全文，去空白）。
 * - clock / config / logger：时钟、content 的配置读口、日志，不读差错单。
 * - readSource：createBillSourceReader（bill/infra/bill-source.ts，在本扫描内；结论端口只为保形传入、从不调用）。
 * - readSnapshot / readTljDeductFen：commission 的快照与淘礼金读口（只读 commission 的表）。
 * - snapshotStatus：ledger 的资产快照状态读口（只读快照状态，不读差错单）。
 * - registerDiff：ledger 的只写登记口 registerReconDiffWriteOnly（D10-2982 ②：一条 INSERT … ON CONFLICT DO NOTHING，
 *   冲突即返回 { inserted: false }、不回读已有行；调用方不用返回值）。
 * - saveValidations：逐单结果写口（bill/infra/bill-validations.ts，在本扫描内）。
 * - regenerateSnapshot：createBillSnapshotRegeneration（bill/regenerate.ts，在本扫描内）经 commission 的估值刷新写新版本。
 * - onGenerated：出账后同事务排一条正差额调整任务（只写队列）。
 */
const ASSEMBLY_PORTS: Readonly<Record<string, { file: string; call: string; members: string[] }>> =
  {
    'worker 账单日任务': {
      file: 'worker/assemble.ts',
      call: 'createBillJob(',
      members: [
        '...(refresh === undefined ? {} : { regenerateSnapshot: createBillSnapshotRegeneration({ clock, refresh }) })',
        'clock',
        'config',
        'logger',
        'onGenerated',
        'readSnapshot',
        'readSource',
        'readTljDeductFen',
        'registerDiff',
        'saveValidations',
        'snapshotStatus',
      ],
    },
    后台补充命令: {
      file: 'application/admin-settle-commands.ts',
      call: 'createSupplementCommand(',
      members: [
        '...regeneration',
        'clock',
        'config',
        'logger',
        'readSnapshot',
        'readSource',
        'readTljDeductFen',
        'registerDiff',
        'saveValidations',
      ],
    },
  };

/** app.module 两段装配里，月结 / 补充用到的端口各接到哪个实现（成员名 → 实参原文）。 */
const APP_MODULE_PORTS: Readonly<Record<string, string>> = {
  // commission 的快照读口。
  readSnapshot: 'readCommissionSnapshot',
  // commission 的淘礼金读口（简写成员）。
  readTljDeductFen: 'readTljDeductFen',
  // ledger 的只写登记口（B2-18d，D10-2982 ②；不再是冲突后回读整行的 registerReconDiff）。
  registerDiff: 'registerReconDiffWriteOnly',
  // ledger 的资产快照状态读口。
  snapshotStatus: 'getAssetSnapshotStatus',
  // ledger 的结论读口：只为保形传入，来源读口从不调用（D10-2415 ③）；调用由禁用写法拦。
  readUnionAuthoritative: 'readUnionAuthoritativeOrderKeys',
  // commission 的估值刷新，供重生成端口写新版本。
  regenerationRefresh: 'commissionRefresh',
};

// ---------------------------------------------------------------------------
// 纯函数：去注释、找模板、判定。

/**
 * 去掉块注释与行注释，保留字符串、模板字面量与正则字面量原文（启发式：/ 前一个有效字符是运算符或开括号时按
 * 正则字面量处理）。注释换成一个空格，换行保留。
 */
function stripComments(text: string): string {
  let out = '';
  let i = 0;
  let last = '';
  const templateDepth: number[] = [];
  let braceDepth = 0;
  const significant = (ch: string) => {
    if (!/\s/.test(ch)) last = ch;
  };
  while (i < text.length) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += ' ';
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, '') || ' ';
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== ch && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      last = ch;
      continue;
    }
    if (ch === '`' || (ch === '}' && templateDepth.at(-1) === braceDepth)) {
      if (ch === '}') templateDepth.pop();
      let j = i + 1;
      while (j < text.length && text[j] !== '`' && !(text[j] === '$' && text[j + 1] === '{')) {
        j += text[j] === '\\' ? 2 : 1;
      }
      if (text[j] === '$') {
        templateDepth.push(braceDepth);
        out += text.slice(i, j + 2);
        i = j + 2;
        last = '{';
      } else {
        out += text.slice(i, j + 1);
        i = j + 1;
        last = '`';
      }
      continue;
    }
    if (ch === '/' && (last === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(last))) {
      let j = i + 1;
      let inClass = false;
      while (j < text.length && text[j] !== '\n') {
        const c = text[j];
        if (c === '/' && !inClass) break;
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        j += c === '\\' ? 2 : 1;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
      last = 'a';
      continue;
    }
    if (ch === '{') braceDepth += 1;
    if (ch === '}') braceDepth -= 1;
    out += ch;
    significant(ch);
    i += 1;
  }
  return out;
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** 从 open 处（某个开括号）到与它配对的闭括号（含），不认字符串里的括号以外的情况足够本文件用。 */
function balancedFrom(text: string, from: number, open: string, close: string): number {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === open) depth += 1;
    else if (text[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 模板字面量 text[start] === '`' 的结束位置（闭合反引号下标），${…} 内按花括号配对。 */
function templateEnd(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === '\\') i += 2;
    else if (text[i] === '`') return i;
    else if (text[i] === '$' && text[i + 1] === '{') {
      const end = balancedFrom(text, i + 1, '{', '}');
      if (end < 0) return -1;
      i = end + 1;
    } else i += 1;
  }
  return -1;
}

const FORBIDDEN: readonly [string, RegExp][] = [
  ['conclusion read port call', /\breadUnionAuthoritative\w*\s*\(/],
  ['conclusion store query', /\bselectUnionConclusions\b/],
  ['ledger generic recon diff read', /\bgetReconDiffs\b/],
  ['recon diff read / lock call', /\b(?:find|select|read|lock|count|page)\w*ReconDiff\w*\s*\(/],
  ['credit postcheck open read', /\breadCreditPostcheckOpen\b/],
  ['read-only database handle', /\b(?:dbRead|DB_READ)\b/],
  // B2-18d：登记端口的返回类型放宽为 Promise<unknown> 后，代码里不再有 DB['recon_diffs'] 这一处类型提及，例外一并去掉。
  ['recon_diffs query', /\brecon_diffs\b/],
  // D10-2948：先编译、再直接执行（Kysely 对它不跑插件的 transformQuery，能绕过运行时探针）。
  ['direct execution of a compiled query', /\bexecuteQuery\b/],
  ['compiled query', /\bCompiledQuery\b/],
  ['query compilation', /\.\s*compile\s*\(/],
  ['executor access', /\bgetExecutor\b/],
  ['raw operation node', /\bRawNode\b/],
  ['sql tag renamed', /\bsql\s+as\s+\w+|\bas\s+sql\b/],
  ['dynamic import / require', /\bimport\s*\(|\brequire\s*\(/],
];

/**
 * 一个文件（或片段）的全部违规；file 用来查原始 SQL 允许清单（清单里没有这个文件 = 不许有任何原始 SQL）。
 * text 是源文件原文（本函数自己去注释）。
 */
function violations(file: string, source: string): string[] {
  const text = stripComments(source);
  const out: string[] = [];
  for (const [label, pattern] of FORBIDDEN) {
    if (pattern.test(text)) out.push(`${file}: ${label}`);
  }

  const allowed = new Set((RAW_SQL_ALLOWLIST[file] ?? []).map((e) => e.sql));
  const allowedSpans: [number, number][] = [];
  // import 语句里的 sql（import { sql, … } from 'kysely'）不算使用。
  const importSpans: [number, number][] = [];
  for (const m of text.matchAll(/\bimport\s[^;]*?\sfrom\s*'[^']*'/g)) {
    importSpans.push([m.index, m.index + m[0].length]);
  }
  const inside = (spans: [number, number][], at: number) =>
    spans.some(([a, b]) => at >= a && at < b);

  const uses = [...text.matchAll(/(?<![\w$.])sql(?![\w$])/g)].map((m) => m.index);
  for (const at of uses) {
    if (inside(importSpans, at)) continue;
    let j = at + 3;
    while (/\s/.test(text[j] ?? '')) j += 1;
    if (text[j] === '<') {
      j = balancedFrom(text, j, '<', '>') + 1;
      if (j === 0) {
        out.push(`${file}: unbalanced sql type argument`);
        continue;
      }
      while (/\s/.test(text[j] ?? '')) j += 1;
    }
    if (text[j] === '`') {
      const end = templateEnd(text, j);
      const body = end < 0 ? '' : squash(text.slice(j + 1, end));
      if (end < 0 || !allowed.has(body)) {
        out.push(`${file}: raw SQL not in the allowlist: ${body.slice(0, 120)}`);
      } else {
        allowedSpans.push([j, end + 1]);
      }
      continue;
    }
    if (text[j] === '.') continue; // sql.<成员>( 在下面单独判。
    out.push(`${file}: sql used as a value`);
  }

  for (const m of text.matchAll(/(?<![\w$.])sql\s*\.\s*(\w+)\s*\(/g)) {
    const member = m[1]!;
    if (!inside(allowedSpans, m.index)) {
      out.push(`${file}: sql.${member}( outside an allowlisted statement`);
    }
    if (member !== 'raw') {
      out.push(`${file}: sql.${member}( is not allowed`);
      continue;
    }
    const close = balancedFrom(text, m.index + m[0].length - 1, '(', ')');
    const arg = close < 0 ? '' : text.slice(m.index + m[0].length, close).trim();
    const declared =
      /^[A-Z][A-Z0-9_]*$/.test(arg) &&
      new RegExp(`\\bconst\\s+${arg}\\s*=\\s*'[A-Za-z0-9_]+'\\s*;`).test(text);
    if (!declared) out.push(`${file}: sql.raw( argument is not a literal constant: ${arg}`);
  }

  for (const entry of RAW_SQL_ALLOWLIST[file] ?? []) {
    // 清单里的每一句都还在（清单不陈旧）；片段扫描（app.module）没有清单项。
    if (!allowedSpans.some(([a, b]) => squash(text.slice(a + 1, b - 1)) === entry.sql)) {
      out.push(`${file}: allowlisted statement not found: ${entry.sql.slice(0, 60)}`);
    }
  }
  return out;
}

interface ImportSpec {
  readonly specifier: string;
  /** 导入的原名（as 之前）；默认导入记 'default'，命名空间 / export * 记 '*'；纯副作用导入为空。 */
  readonly names: readonly string[];
}

/** 一个文件的全部 import / export … from（去注释后）。 */
function importsOf(source: string): ImportSpec[] {
  const text = stripComments(source);
  const out: ImportSpec[] = [];
  const re = /(?:^|[;\n}])\s*(import|export)\s+(?:type\s+)?([^;'"]*?)\s*from\s*'([^']+)'/g;
  for (const m of text.matchAll(re)) {
    const clause = m[2]!.trim();
    const names: string[] = [];
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces !== null) {
      for (const part of braces[1]!.split(',')) {
        const name = part
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)[0]!
          .trim();
        if (name !== '') names.push(name);
      }
    }
    const outside = clause
      .replace(/\{[^}]*\}/, '')
      .replace(/,/g, ' ')
      .trim();
    if (/\*/.test(outside)) names.push('*');
    else if (outside !== '' && outside !== 'type') names.push('default');
    out.push({ specifier: m[3]!, names });
  }
  for (const m of text.matchAll(/(?:^|[;\n])\s*import\s*'([^']+)'/g)) {
    out.push({ specifier: m[1]!, names: [] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 读文件、走闭包。

const read = (rel: string) => readFileSync(join(SETTLEMENT, rel), 'utf8');
const toRel = (abs: string) => relative(SETTLEMENT, abs).split(sep).join('/');

/** 目录下全部非测试 .ts 源文件（递归），相对 settlement 根。 */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(toRel(path));
  }
  return out.sort();
}

/** 从 roots 出发、沿 settlement 内相对导入走出的传递闭包；越出 settlement 的导入另行返回。 */
function closure(roots: readonly string[]): {
  files: string[];
  outside: { from: string; spec: ImportSpec }[];
  unresolved: string[];
} {
  const seen = new Set<string>();
  const outside: { from: string; spec: ImportSpec }[] = [];
  const unresolved: string[] = [];
  const stack = [...roots];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of importsOf(read(file))) {
      if (!spec.specifier.startsWith('.')) {
        outside.push({ from: file, spec });
        continue;
      }
      const abs = normalize(join(SETTLEMENT, dirname(file), spec.specifier));
      const rel = toRel(abs);
      if (rel.startsWith('../')) {
        outside.push({ from: file, spec });
        continue;
      }
      if (!existsSync(abs)) unresolved.push(`${file} -> ${spec.specifier}`);
      else stack.push(rel);
    }
  }
  return { files: [...seen].sort(), outside, unresolved };
}

/** app.module 里为月结 / 补充装配的三段：worker 的 settlement 端口、后台 forAdmin 端口、commission refresh。 */
function appModuleSlices(): Record<string, string> {
  const text = stripComments(readFileSync(APP_MODULE, 'utf8'));
  const slice = (marker: string, open: string, close: string) => {
    const start = text.indexOf(marker);
    if (start < 0) return '';
    const from = text.indexOf(open, start);
    const end = balancedFrom(text, from, open, close);
    return end < 0 ? '' : text.slice(start, end + 1);
  };
  return {
    'app.module.ts settlementWorkerModule': slice('function settlementWorkerModule', '{', '}'),
    'app.module.ts SettlementAdminModule.forAdmin': slice(
      'SettlementAdminModule.forAdmin(',
      '(',
      ')',
    ),
    'app.module.ts commissionRefresh': slice('function commissionRefresh', '{', '}'),
  };
}

/** 扫描面：写死清单里的文件（原文）加 app.module 的三段（已去注释）。 */
function scanned(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of SCANNED_FILES) out[file] = read(file);
  return { ...out, ...appModuleSlices() };
}

/** 调用 call( 的实参对象的顶层成员：简写 / 键名取名字，展开项取去空白的全文。 */
function topLevelMembers(text: string, call: string): string[] | null {
  const at = text.indexOf(call);
  if (at < 0) return null;
  const open = text.indexOf('{', at);
  const close = balancedFrom(text, open, '{', '}');
  if (open < 0 || close < 0) return null;
  const body = text.slice(open + 1, close);
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if ('({['.includes(ch)) depth += 1;
    if (')}]'.includes(ch)) depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  parts.push(current);
  return parts
    .map(squash)
    .filter((p) => p !== '')
    .map((p) => (p.startsWith('...') ? p : /^(?:async\s+)?([\w$]+)/.exec(p)![1]!))
    .sort();
}

// ---------------------------------------------------------------------------

it('[AC-B2-18-UNIT#8] 必满足项 ①：账单日任务、补充发起、后台补充入口及其装配的源文件里没有结论读口与差错单读口的调用、没有只读库连接、没有 recon_diffs 的查询构造（registerDiff 写入口除外），也没有「先编译、再直接执行」的写法（executeQuery / CompiledQuery / .compile( 等）', () => {
  const files = scanned();
  // 扫描面确实覆盖到了这些文件（片段为空说明定位失败，判定无效）。
  for (const name of Object.keys(files)) {
    expect(stripComments(files[name]!).trim().length, name).toBeGreaterThan(0);
  }
  for (const name of [
    'bill/job.ts',
    'bill/follow-union.ts',
    'bill/regenerate.ts',
    'bill/supplement/command.ts',
    'bill/supplement/locked-recheck.ts',
    'bill/infra/bill-source.ts',
    'batch/credit-gate.ts',
    'application/admin-settle-commands.ts',
    'worker/assemble.ts',
    'app.module.ts settlementWorkerModule',
    'app.module.ts SettlementAdminModule.forAdmin',
    'app.module.ts commissionRefresh',
  ]) {
    expect(files[name]?.length ?? 0, name).toBeGreaterThan(100);
  }
  const hits: string[] = [];
  for (const [name, text] of Object.entries(files)) {
    const forbiddenOnly = violations(name, text).filter(
      (v) => !/raw SQL|sql\.|sql used|allowlisted statement/.test(v),
    );
    hits.push(...forbiddenOnly);
  }
  expect(hits).toEqual([]);
  // 登记写入口仍在（union_mismatch 照旧登记），说明扫描的是真实源文件而不是空文本。
  expect(stripComments(files['bill/job.ts']!)).toMatch(/deps\.registerDiff\(/);
  expect(stripComments(files['bill/supplement/command.ts']!)).toMatch(/deps\.registerDiff\(/);
  // 月结与补充都经 follow-union 比金额、经平台排他锁取锁（扫到的是重接后的代码）。
  expect(stripComments(files['bill/job.ts']!)).toMatch(/followUnion\.check\(/);
  expect(stripComments(files['bill/supplement/command.ts']!)).toMatch(/followUnion\.check\(/);
  expect(stripComments(files['bill/supplement/command.ts']!)).toMatch(/lockCreditGateExclusive\(/);
});

it('[AC-B2-18-UNIT#9] §9.2 第 11 条：worker 的出账处理器与后台补充命令两处生产装配都注入了重生成端口——app.module 两段都给 regenerationRefresh，assemble 与后台命令都由它建 createBillSnapshotRegeneration 交给账单任务 / 补充命令', () => {
  const files = scanned();
  expect(files['app.module.ts settlementWorkerModule']).toMatch(
    /regenerationRefresh:\s*commissionRefresh/,
  );
  expect(files['app.module.ts SettlementAdminModule.forAdmin']).toMatch(
    /regenerationRefresh:\s*commissionRefresh/,
  );
  expect(files['app.module.ts commissionRefresh']).toMatch(/createCommissionEstimates\(/);
  for (const name of ['worker/assemble.ts', 'application/admin-settle-commands.ts']) {
    expect(files[name], name).toMatch(/ports\.regenerationRefresh\?\.\(clock\)/);
    expect(files[name], name).toMatch(/regenerateSnapshot:\s*createBillSnapshotRegeneration\(/);
  }
});

it('[AC-B2-18-UNIT#14] D10-2948 ②：扫描面里每一处 sql 标签模板与 sql.<成员>( 都落在写死的允许清单里（按文件 + 整句），sql.raw( 的入参都是本文件字面量声明的常量；清单里的每一句都还在', () => {
  const files = scanned();
  const hits: string[] = [];
  for (const [name, text] of Object.entries(files)) hits.push(...violations(name, text));
  expect(hits).toEqual([]);
  // 清单只列扫描面里的文件。
  for (const file of Object.keys(RAW_SQL_ALLOWLIST)) expect(SCANNED_FILES).toContain(file);
});

it('[AC-B2-18-UNIT#15] D10-2948 ③：写死的扫描清单 = 从两个入口与 bill/ 各源文件沿 settlement 内相对导入走出的闭包 ∪ bill/ 全部非测试源文件 ∪ 装配文件，逐项相等', () => {
  for (const entry of ENTRIES) expect(existsSync(join(SETTLEMENT, entry)), entry).toBe(true);
  const billFiles = sources(join(SETTLEMENT, 'bill'));
  const walked = closure([...ENTRIES, ...billFiles]);
  expect(walked.unresolved).toEqual([]);
  const actual = [...new Set([...walked.files, ...billFiles, ...ASSEMBLY_FILES])].sort();
  expect(actual).toEqual([...SCANNED_FILES].sort());
  // 两个入口自己的闭包也都在清单里（入口没有被 bill/ 的目录扫描「顺带」掩盖）。
  for (const file of closure(ENTRIES).files) expect(SCANNED_FILES).toContain(file);
});

it('[AC-B2-18-UNIT#16] D10-2948 ④：闭包与 bill/ 的文件出 settlement 只经对方 index.ts 导入清单里的名字（orders / platform），不从 ledger 导入任何东西、不导入只读库令牌；npm 包只限清单；两处装配交给月结 / 补充的端口名字与 app.module 接的实现都与清单一致', () => {
  const billFiles = sources(join(SETTLEMENT, 'bill'));
  const walked = closure([...ENTRIES, ...billFiles]);
  const hits: string[] = [];
  const seenModules = new Set<string>();
  for (const { from, spec } of walked.outside) {
    if (!spec.specifier.startsWith('.')) {
      if (!PACKAGES.includes(spec.specifier)) hits.push(`${from}: package ${spec.specifier}`);
      continue;
    }
    const target = relative(MODULES, normalize(join(SETTLEMENT, dirname(from), spec.specifier)))
      .split(sep)
      .join('/');
    const [module, ...rest] = target.split('/');
    const allowedNames = MODULE_BOUNDARY[module!];
    if (allowedNames === undefined || rest.join('/') !== 'index.ts') {
      hits.push(`${from}: imports ${target}`);
      continue;
    }
    seenModules.add(module!);
    for (const name of spec.names) {
      if (!allowedNames.includes(name)) hits.push(`${from}: ${module}.${name}`);
    }
  }
  expect(hits).toEqual([]);
  expect([...seenModules].sort()).toEqual(Object.keys(MODULE_BOUNDARY).sort());
  expect(Object.keys(MODULE_BOUNDARY)).not.toContain('ledger');

  for (const [label, { file, call, members }] of Object.entries(ASSEMBLY_PORTS)) {
    expect(topLevelMembers(stripComments(read(file)), call), label).toEqual([...members].sort());
  }
  const slices = appModuleSlices();
  for (const name of [
    'app.module.ts settlementWorkerModule',
    'app.module.ts SettlementAdminModule.forAdmin',
  ]) {
    for (const [member, impl] of Object.entries(APP_MODULE_PORTS)) {
      const wired =
        member === impl
          ? new RegExp(`[{,]\\s*${member}\\s*,`)
          : new RegExp(`\\b${member}:\\s*${impl}\\s*,`);
      expect(slices[name], `${name} ${member}`).toMatch(wired);
    }
  }
});

it('[AC-B2-18-UNIT#17] 自证：同一判定函数对「先编译、再直接执行」的样例、清单外的原始 SQL 样例、非常量的 sql.raw( 与改名的 sql 都判违规；对允许清单里的原句不判；注释里的禁用写法不算', () => {
  const compiled = [
    "import { CompiledQuery } from 'kysely';",
    'export async function probe(trx) {',
    "  return trx.executeQuery(CompiledQuery.raw('select expected_fen from app.recon_diffs'));",
    '}',
  ].join('\n');
  const compiledHits = violations('bill/job.ts', compiled);
  expect(compiledHits).toContain('bill/job.ts: direct execution of a compiled query');
  expect(compiledHits).toContain('bill/job.ts: compiled query');

  const viaCompile = 'const q = trx.selectFrom("x").selectAll().compile();';
  expect(violations('bill/job.ts', viaCompile)).toContain('bill/job.ts: query compilation');

  const unlisted =
    "import { sql } from 'kysely';\nawait sql`select 1 from app.orders`.execute(trx);";
  expect(violations('bill/supplement/command.ts', unlisted).join('\n')).toMatch(
    /raw SQL not in the allowlist: select 1 from app\.orders/,
  );
  // 同一句放在没有清单的文件里也红；带类型参数的标签同样认出来。
  expect(violations('bill/types.ts', 'await sql<{ a: number }>`select 1`.execute(trx);')).toEqual(
    expect.arrayContaining([expect.stringMatching(/raw SQL not in the allowlist/)]),
  );

  const dynamicRaw = 'const name = pick();\nawait sql`SAVEPOINT ${sql.raw(name)}`.execute(trx);';
  expect(violations('bill/follow-union.ts', dynamicRaw).join('\n')).toMatch(
    /sql\.raw\( argument is not a literal constant: name/,
  );
  expect(violations('bill/job.ts', 'const s = sql.lit(1);').join('\n')).toMatch(
    /sql\.lit\( is not allowed/,
  );
  expect(violations('bill/job.ts', 'const run = sql;').join('\n')).toMatch(/sql used as a value/);
  expect(violations('bill/job.ts', "import { sql as q } from 'kysely';").join('\n')).toMatch(
    /sql tag renamed/,
  );

  // 允许清单里的原句（常量是字面量）不判；注释里的禁用写法去掉注释后不算。
  const fine = [
    "import { sql } from 'kysely';",
    "const SAVEPOINT = 'settle_bill_follow_union';",
    '// executeQuery(CompiledQuery.raw(...)) 只出现在注释里',
    '/* recon_diffs */',
    'await sql`SAVEPOINT ${sql.raw(SAVEPOINT)}`.execute(trx);',
    'await sql`ROLLBACK TO SAVEPOINT ${sql.raw(SAVEPOINT)}`.execute(trx);',
    'await sql`RELEASE SAVEPOINT ${sql.raw(SAVEPOINT)}`.execute(trx);',
  ].join('\n');
  expect(violations('bill/follow-union.ts', fine)).toEqual([]);

  // 去注释保留字符串与模板：字符串里的 // 不被当成注释吃掉。
  expect(stripComments("const a = 'x // y'; // tail")).toContain("'x // y'");
  expect(stripComments('const r = /^[0-9]+$/.test(v); // tail')).toContain('/^[0-9]+$/');

  // 导入解析：type / as / export … from / 命名空间都认得出原名。
  expect(
    importsOf(
      [
        "import { a, type B, c as d } from '../x/index.ts';",
        "import type { E } from '../y/index.ts';",
        "export { f } from './f.ts';",
        "import * as ns from 'z';",
      ].join('\n'),
    ),
  ).toEqual([
    { specifier: '../x/index.ts', names: ['a', 'B', 'c'] },
    { specifier: '../y/index.ts', names: ['E'] },
    { specifier: './f.ts', names: ['f'] },
    { specifier: 'z', names: ['*'] },
  ]);
});
