// Task brief generator (`pnpm ops:brief <id>`; 规划/11 §2.3 step 2, §5.3;
// planning docs/templates/task-brief.md). The brief is the only input of the
// implementer and of the reviewers. It is written to couli-runs/<id>/brief.md
// and never committed.
//
//   node tools/ops/brief.ts <id> [--phase test|impl|handover|review] [--attempt <n>] [--out <file>]
//
// Phases (default split of 2026-10-05, ops/approvals.yaml id 19):
//   test    Codex writes the rule / acceptance tests and NotImplemented skeletons, red first;
//           it may add rule-test assets (class 1 of the protected paths), never change them
//   impl    (default) the Opus implementation subagent; the rule tests are frozen; type
//           checks, lint and tests run on the test machine, by the orchestrator (D10-2406)
//   handover  Codex implements once (规划/11 §2.5): rule tests frozen as in impl
//   review  the brief as data for a reviewer: read-only
// Locally every phase runs only prettier --check and eslint on the changed files (D10-2404 /
// D10-2406): no tsc, no full typecheck or lint, no test. Type checks, lint and every run that
// executes tests are the orchestrator's, on the test machine (verify-container.sh) or in CI.
// Nothing Codex generates (tests, skeletons, a handover implementation) runs on the host.
//
// Exit codes: 0 written, 1 refused (over the size limit, banned term, bad task), 2 usage/internal.
import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { writeFileAtomic } from '../lib/fsx.ts';
import { git } from '../lib/git.ts';
import { matchesAny } from '../lib/glob.ts';
import { repoRoot, runsDir, specRef, trustedRoot } from '../lib/paths.ts';
import type { TaskFile } from '../lib/task-file.ts';
import { assertTaskId, CheckError, runGuard, runMain, UsageError } from './cli.ts';
import { globsMayOverlap, literalDir } from './overlap.ts';
import {
  CONTRACTS_FILE,
  contractSection,
  findRule,
  isAcceptanceId,
  isRuleId,
  oneHopRefs,
  ruleTitle,
  splitTableRow,
} from './spec.ts';
import type { Rule, SpecSource } from './spec.ts';
import { isCodexFirst, loadCodexImplTasks } from '../lib/codex-impl-tasks.ts';
import { loadLegacyTasks, ruleTestScope } from '../lib/legacy-tasks.ts';
import { readState } from './state.ts';
import type { TaskState } from './state.ts';
import { CONTRACT_GENERATED, CONTRACT_SOURCE, readTask, riskOfPaths } from './task.ts';
import type { RiskReport } from './task.ts';

/** 规划/11 §5.3: a brief over 24 KB means the task has to be split. */
export const MAX_BRIEF_BYTES = 24 * 1024;
const FAILURE_TAIL_LINES = 200;
const FAILURE_TAIL_BYTES = 8 * 1024;
/** Below this much room for the previous failure the brief is refused instead of squeezed. */
const MIN_FAILURE_TAIL_BYTES = 1024;
const FAILURE_LINE_CHARS = 400;

export type ProtectedPaths = {
  class1_add_only: string[];
  class2_verify_config: string[];
  class3_gates: string[];
};

// The only commands a brief lets the agent run locally, on the changed files (D10-2404 / 2406).
const LOCAL_CHECKS = [
  'pnpm exec prettier --check <改动文件>',
  'pnpm exec eslint <改动的 .ts / .tsx 文件>',
] as const;
const LOCAL_ONLY_NOTE =
  '本机只许对改动文件跑 `pnpm exec prettier --check <改动文件>` 与 `pnpm exec eslint <改动的 .ts / .tsx 文件>`；不跑 tsc、`pnpm typecheck`、`pnpm lint`（全量）、`vitest`、`pnpm test`、`pnpm verify:fast`；类型检查、lint 与测试由编排者在测试机上跑（`tools/ops/verify-container.sh <编号> --fast`，及 `--tests` / `--related` 轻量档）。';

export const BRIEF_PHASES = ['test', 'impl', 'handover', 'review'] as const;
export type BriefPhase = (typeof BRIEF_PHASES)[number];

const PHASE_TEXT: Record<BriefPhase, string> = {
  test: '写规则 / 验收测试（Codex）：只写先红的规则测试和只抛 `NotImplemented` 的函数骨架，不写实现',
  impl: '实现：规则测试已冻结，不改不删；类型检查、lint 与测试由编排者在测试机上跑',
  handover: '换家实现（Codex，一次）：规则测试已冻结，不改不删；沙箱里只做静态检查',
  review: '评审对照（只读）：本任务书是评审的数据，不改任何文件',
};

export type BriefInput = {
  task: TaskFile;
  /**
   * The ledger is on tools/guard/legacy-tasks.json (written before the switch was merged): it
   * keeps the old flow — no test_paths needed, and with impl: codex the implementation brief is
   * the old one for Codex (verify:fast in its sandbox).
   */
  legacy?: boolean;
  /**
   * The task is on tools/guard/codex-impl-tasks.json (owner 2026-10-06, ops/approvals.yaml
   * id 23): with impl: codex and tester: claude, Claude writes the rule tests and Codex implements.
   */
  codexImpl?: boolean;
  /** Default `impl`. */
  phase?: BriefPhase;
  risk: RiskReport['risk'];
  attempt: number;
  specRef: string;
  state: TaskState | null;
  /** Where gate files (AGENTS.md, protected paths) are read from. */
  rulesRoot: string;
  /** Repository whose history contains `spec_commit`. */
  gitRoot: string;
  spec?: SpecSource;
  /** Byte budget of the previous failure output in section 7 (default 8 KB). */
  failureTailBytes?: number;
  /**
   * CT-06o: list the one-hop references of section 2 by id, title and status only. generateBrief
   * sets it when the full brief (without the previous failure output) is over MAX_BRIEF_BYTES.
   */
  compactHops?: boolean;
};

export function readProtectedPaths(root: string): ProtectedPaths {
  const file = join(root, 'tools', 'guard', 'protected-paths.json');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<ProtectedPaths>;
  for (const key of ['class1_add_only', 'class2_verify_config', 'class3_gates'] as const) {
    const list = raw[key];
    if (!Array.isArray(list) || !list.every((g) => typeof g === 'string')) {
      throw new Error(`${file}: ${key} must be a list of globs`);
    }
  }
  return raw as ProtectedPaths;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.turbo', '.tmp', 'coverage']);

function agentsBelow(root: string, dir: string, depth: number, out: Set<string>): void {
  if (depth > 6) return;
  const abs = dir === '' ? root : join(root, dir);
  if (!existsSync(abs)) return;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
    const child = dir === '' ? entry.name : `${dir}/${entry.name}`;
    if (existsSync(join(root, child, 'AGENTS.md'))) out.add(`${child}/AGENTS.md`);
    agentsBelow(root, child, depth + 1, out);
  }
}

/**
 * The nested AGENTS.md files that govern the task's paths: the chain below the
 * repository root down to the directory each glob starts in, plus the ones below
 * it (a glob such as `apps/api/src/modules/**` reaches into every module). The
 * root file is left out: codex-run.sh always runs Codex with `-C <worktree root>`
 * and Codex injects the root AGENTS.md by itself (规划/11 §2.4; seen on the
 * validation day), while nested files under `paths` are never injected and must
 * be embedded. Sorted shallowest first.
 */
export function agentsFilesFor(paths: readonly string[], root: string): string[] {
  const found = new Set<string>();
  for (const glob of paths) {
    const dir = literalDir(glob);
    const parts = dir === '' ? [] : dir.split('/');
    for (let i = 1; i <= parts.length; i += 1) {
      const file = `${parts.slice(0, i).join('/')}/AGENTS.md`;
      if (existsSync(join(root, file))) found.add(file);
    }
    if (/[*?{[]/.test(glob)) agentsBelow(root, dir, 0, found);
  }
  return [...found].sort((a, b) => {
    const da = a.split('/').length;
    const db = b.split('/').length;
    return da - db || a.localeCompare(b);
  });
}

/**
 * Where a task branch forks from main: `origin/main` first, the local `main` only when there is no
 * remote-tracking ref (D10-222: the lane clones keep their local main untouched and detach at
 * origin/main, so a stale local main would list every rule test merged since as this task's).
 */
const MAIN_REFS = ['origin/main', 'main'] as const;

/** Files of protected class 1 that the rule-test commits added or changed. */
export function ruleTestFiles(
  specCommit: string,
  gitRoot: string,
  class1: readonly string[],
): string[] {
  let base = '';
  for (const ref of MAIN_REFS) {
    try {
      base = git(['merge-base', ref, specCommit], { cwd: gitRoot });
      break;
    } catch {
      // This ref does not exist here, or shares no history with the spec commit.
    }
  }
  // No main at all, or unrelated histories: fall back to the commit itself.
  if (base === '') base = `${specCommit}^`;
  const out = git(
    [
      '-c',
      'core.quotepath=false',
      'diff',
      '--name-only',
      '-z',
      '--no-renames',
      base,
      specCommit,
      '--',
    ],
    { cwd: gitRoot },
  );
  return out
    .split('\0')
    .filter((p) => p !== '' && matchesAny(p, class1))
    .sort();
}

function threeColumnRow(rule: Rule): string {
  return rule.rowText.trim();
}

const HOP_TITLE_CHARS = 40;

/**
 * Title of a one-hop reference in the compact table (CT-06o): the bold lead of the 规则 cell; with
 * no bold lead, its first sentence (up to the first `<br>` or `。`), whitespace collapsed and cut
 * to HOP_TITLE_CHARS characters followed by `…`.
 */
export function hopTitle(rule: Rule): string {
  const cell = ((splitTableRow(rule.rowText) ?? [])[1] ?? '').trim();
  const bold = /^\*\*(.+?)\*\*/.exec(cell);
  if (bold?.[1]) return bold[1].trim();
  const first = (cell.split(/<br\s*\/?>|。/).find((s) => s.trim() !== '') ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...first];
  return chars.length > HOP_TITLE_CHARS ? `${chars.slice(0, HOP_TITLE_CHARS).join('')}…` : first;
}

/** The line above the compact one-hop table. */
export const COMPACT_HOPS_NOTE = '任务书超过 24KB，一跳引用只列标题；原文见 SPEC_REF 版本的规划/08';

function ruleSection(rule: Rule): string[] {
  const out: string[] = [];
  const status = rule.status === '' ? '' : `（状态：${rule.status}）`;
  out.push(`### ${rule.id}${status}`, '');
  if (isRuleId(rule.id)) {
    out.push('| 编号 | 规则 | 状态 |', '| --- | --- | --- |', threeColumnRow(rule), '');
    if (rule.detailText !== '') out.push(rule.detailText, '');
  } else {
    // Acceptance cases: the row as written in 规划/10 or 规划/01.
    const cells = splitTableRow(rule.rowText) ?? [];
    out.push(`来源：${rule.file}`, '', `|${cells.map(() => ' ').join('|')}|`);
    out.push(`|${cells.map(() => ' --- ').join('|')}|`, rule.rowText.trim(), '');
  }
  return out;
}

function failureTail(file: string, maxBytes: number): string[] {
  if (!existsSync(file)) return [`（上一轮失败输出文件不存在：${file}）`];
  const lines = readFileSync(file, 'utf8').replace(/\n+$/, '').split('\n');
  const tail = lines
    .slice(-FAILURE_TAIL_LINES)
    // The output is untrusted text produced by the code under test: keep it
    // inside the fence and keep single lines from flooding the brief.
    .map((l) => l.replace(/`{3,}/g, "'''").slice(0, FAILURE_LINE_CHARS));
  let bytes = 0;
  let from = tail.length;
  while (from > 0) {
    const size = Buffer.byteLength(tail[from - 1] ?? '', 'utf8') + 1;
    if (bytes + size > maxBytes) break;
    bytes += size;
    from -= 1;
  }
  const kept = tail.slice(from);
  if (from > 0) kept.unshift(`（更早的 ${from} 行已截去）`);
  return kept;
}

function isCommand(entry: string): boolean {
  return /^(pnpm|node|npx|bash|sh)\s/.test(entry);
}

/**
 * Section 2 of an ordinary brief: the full text of each ref and its one-hop references (their
 * table rows; with `compact`, id, title and status only).
 */
function ruleTexts(task: TaskFile, spec: SpecSource | undefined, compact: boolean): string[] {
  const out: string[] = [];
  out.push('## 2. 规则原文（来自 08，版本同 SPEC_REF）', '');
  const rules = task.refs.map((ref) => findRule(ref, spec));
  for (const rule of rules) out.push(...ruleSection(rule));
  out.push('### 一跳引用', '');
  const hopIds: string[] = [];
  for (const rule of rules) {
    for (const id of oneHopRefs(rule)) {
      if (!task.refs.includes(id) && !hopIds.includes(id)) hopIds.push(id);
    }
  }
  const hopRows: string[] = [];
  for (const id of hopIds) {
    try {
      const hop = findRule(id, spec);
      hopRows.push(
        compact ? `| ${hop.id} | ${hopTitle(hop)} | ${hop.status} |` : threeColumnRow(hop),
      );
    } catch {
      // A mention that is not a rule at SPEC_REF (prose, retired id): nothing to quote.
    }
  }
  if (hopRows.length === 0) out.push('（无）', '');
  else if (compact) {
    out.push(
      COMPACT_HOPS_NOTE,
      '',
      '| 编号 | 标题 | 状态 |',
      '| --- | --- | --- |',
      ...hopRows,
      '',
    );
  } else out.push('| 编号 | 规则 | 状态 |', '| --- | --- | --- |', ...hopRows, '');
  out.push(
    '列名、错误码、枚举值以 `contracts/` 与 `db/schema.sql` 为准；技术实现以 ADR-0001 为准。规则原文与它们冲突时不要自行取舍，在输出的 `blocked_reason` 里写明。',
    '',
  );
  return out;
}

/**
 * Section 2 of a contract task brief (owner decision 2026-10-02, ops/approvals.yaml id 17): the
 * 规划/04 sections named in `contract_sections`, verbatim, and the refs as id + title only
 * (no BR text, no one-hop references), so that contract briefs stay under the size limit.
 */
function contractRules(task: TaskFile, spec: SpecSource | undefined): string[] {
  const out: string[] = ['## 2. 契约依据（04 相关节原文；BR 只列编号与标题，版本同 SPEC_REF）', ''];
  out.push('### 涉及的业务规则（只列编号与标题，原文在 08）', '');
  if (task.refs.length === 0) out.push('（无）', '');
  else {
    for (const ref of task.refs) {
      const rule = findRule(ref, spec);
      out.push(`- ${rule.id}：${isRuleId(rule.id) ? ruleTitle(rule) : rule.file}`);
    }
    out.push('');
  }
  out.push(`### 04 相关节（${CONTRACTS_FILE}）`, '');
  if (task.contract_sections.length === 0) {
    out.push('（台账没有点名 04 的章节：按任务标题与第 6 节验收命令判断。）', '');
  }
  for (const section of task.contract_sections) {
    out.push(`<!-- 04 §${section} 全文开始 -->`, '');
    out.push(contractSection(section, spec), '');
    out.push(`<!-- 04 §${section} 全文结束 -->`, '');
  }
  out.push(
    '技术实现以 ADR-0001 为准。04 与 08 原文冲突时不要自行取舍，在输出的 `blocked_reason` 里写明。',
    '',
  );
  return out;
}

/** Renders the brief; pure apart from reading rule text and AGENTS.md files. */
export function renderBrief(input: BriefInput): string {
  const { task, state } = input;
  const phase = input.phase ?? 'impl';
  // The old flow's Codex implementation (a legacy ledger with impl: codex).
  const oldCodexImpl = input.legacy === true && task.impl === 'codex' && phase === 'impl';
  // A Codex-first implementation (ops/approvals.yaml id 23): like a handover, the sandbox only
  // runs static checks and the orchestrator runs the tests in the isolated container or CI.
  const codexFirstImpl =
    !oldCodexImpl &&
    input.codexImpl === true &&
    task.impl === 'codex' &&
    task.tester === 'claude' &&
    phase === 'impl';
  const phaseText =
    phase === 'test' && task.tester === 'claude'
      ? PHASE_TEXT.test.replace('（Codex）', '（Claude 子代理）')
      : phase === 'test' && task.tester === 'claude-independent'
        ? PHASE_TEXT.test.replace(
            '（Codex）',
            '（独立 Claude 上下文，ops/approvals.yaml 第 36 条）',
          )
        : PHASE_TEXT[phase];
  const out: string[] = [];
  out.push(`# 任务 ${task.id}：${task.title}`, '');
  out.push(`- 仓库：${task.repo}；分支：\`task/${task.id}\`；第 ${input.attempt} 次尝试`);
  out.push(`- 规格版本：\`SPEC_REF=${input.specRef}\``);
  out.push(`- 风险级：${input.risk}；实现：${task.impl}；规则测试作者：${task.tester}`);
  out.push(
    `- 本轮阶段：${phase}（${
      oldCodexImpl
        ? '实现（旧分工，台账 impl: codex）：规则测试已冻结，不改不删'
        : codexFirstImpl
          ? '实现（Codex 首发，规划/11 §1.1 例外，台账 impl: codex）：规则测试是 Claude 写的，已冻结，不改不删；沙箱里只做静态检查'
          : phaseText
    }）`,
  );
  out.push(`- 依赖任务：${task.deps.length === 0 ? '无' : task.deps.join('、')}`, '');

  out.push('## 1. 目标', '');
  const acIds = task.refs.filter((r) => isAcceptanceId(r));
  out.push(
    `${task.title}。关联验收编号：${acIds.length === 0 ? '无（按第 6 节的验收命令与规则测试判定）' : acIds.join('、')}。`,
    '',
  );

  if (task.type === 'contract') out.push(...contractRules(task, input.spec));
  else out.push(...ruleTexts(task, input.spec, input.compactHops === true));

  const prot = readProtectedPaths(input.rulesRoot);
  const code = (globs: readonly string[]): string => globs.map((g) => `\`${g}\``).join('、');
  out.push('## 3. 可以改的路径', '');
  if (phase === 'test') {
    // The rule-test author's three kinds of paths (规划/11 §2.3 step 3; path-guard --author).
    // CR-06: the task's own test_paths, not every rule-test asset of the repository.
    if (task.test_paths.length === 0 && input.legacy !== true) {
      throw new Error(`task ${task.id} has no test_paths: the test phase needs them in the ledger`);
    }
    // The shared scope (CR3-01): test_paths, or every rule-test asset for a legacy ledger.
    const scope = ruleTestScope(
      task,
      new Set(input.legacy === true ? [task.id] : []),
      prot.class1_add_only.map((g) => g.replace(/#.*$/, '')),
    );
    out.push(
      `- 本任务的规则测试（台账 \`test_paths\`；只新增文件，已有的不改不删）：${code(scope)}`,
      "- 任务路径内只放 `NotImplemented` 骨架，逐条顶层语句检查：只许 import、export 列表与转出、type、interface、函数声明和类；函数与方法体只能是 `void <参数>;` 再加最后一句 `throw new Error('NotImplemented: <名字>')`（派生类构造函数第一句可以是只含普通值的 `super(…)`）；类字段不带初始值。`const` / `let` / `var`（含常量）、顶层调用、箭头函数、参数默认值、分支一律不行；要用的常量放进规则测试或写成类型：",
    );
  }
  for (const p of task.paths) out.push(`- \`${p}\``);
  if (matchesAny(CONTRACT_SOURCE, task.paths)) {
    // CT-06n: the route tables list planned operations too, so adding or removing one changes them.
    out.push(
      '',
      `本任务可以改 \`${CONTRACT_SOURCE}\`：新增或删除操作（含 planned）后要重跑 \`pnpm codegen\`（\`packages/contracts-ts/src/openapi.gen.ts\`）与 apps/api 下的 generate-auth-routes / generate-signing-routes / generate-min-version-routes / generate-route-schemas 脚本（\`apps/api/src/modules/platform/http/scripts/\`、\`platform/validation/scripts/\`、\`risk/application/scripts/\`），生成物 ${CONTRACT_GENERATED.map((f) => `\`${f}\``).join('、')} 与 \`apps/api/src/modules/platform/validation/route-schemas.gen.ts\` 随之变化；生成物不在上面的清单里时不要手改，在输出的 \`blocked_reason\` 里写明缺哪份。`,
    );
  }
  out.push('');

  out.push('## 4. 不能改的', '');
  const all = [...prot.class1_add_only, ...prot.class2_verify_config, ...prot.class3_gates];
  // "Relevant" (template §4) = what the implementer could mistake for fair game: protected
  // globs that reach into the allowed paths, and the add-only areas that hold the rule tests
  // named in `accept`. Everything else is outside `paths` and refused by the path guard anyway.
  const inside = all.filter((g) =>
    task.paths.some((p) => globsMayOverlap(p, g.replace(/#.*$/, ''))),
  );
  const testIds = task.accept.filter((a) => !isCommand(a));
  const testAreas = prot.class1_add_only.filter(
    (g) => !inside.includes(g) && testIds.some((t) => globsMayOverlap(t, g)),
  );
  out.push(
    `- 保护路径（落在你的允许路径之内、仍然不能动的）：${inside.length === 0 ? '无' : code(inside)}`,
  );
  if (phase === 'test') {
    out.push(
      '- 第一类保护路径（规则测试资产）里已有的文件：不能改、不能删；`test_paths` 以外的规则测试资产不能碰。',
    );
  } else if (testAreas.length > 0) {
    out.push(
      `- 保护路径（验收用的规则测试所在，不能改、不能删，也不要为了变绿去动它们）：${code(testAreas)}`,
    );
  }
  out.push(
    '- 其余保护路径都在允许路径之外，同样不能碰；完整清单见 `tools/guard/protected-paths.json`。',
  );
  if (state?.spec_commit) {
    const files = ruleTestFiles(state.spec_commit, input.gitRoot, prot.class1_add_only);
    out.push(
      `- 已有规则测试（\`spec_commit=${state.spec_commit}\` 之后不得改动）：${files.length === 0 ? '无' : files.map((f) => `\`${f}\``).join('、')}`,
    );
  } else {
    out.push('- 已有规则测试：本任务还没有规则测试提交（没有 `spec_commit`）。');
  }
  out.push('- `ops/`、`docs/` 下任何文件；结果只写进 JSON 输出。', '');

  out.push('## 5. 必须遵守的仓库规则', '');
  out.push(
    '根 AGENTS.md 由 Codex 与 Claude Code 自动读取，这里不再内嵌；下面是允许路径上各级子目录的 AGENTS.md 全文。',
    '',
  );
  const agents = agentsFilesFor(task.paths, input.rulesRoot);
  if (agents.length === 0) out.push('（允许路径上没有子目录的 AGENTS.md）', '');
  for (const file of agents) {
    out.push(`<!-- ${file} 全文开始 -->`, '');
    out.push(readFileSync(join(input.rulesRoot, file), 'utf8').trim(), '');
    out.push(`<!-- ${file} 全文结束 -->`, '');
  }

  out.push('## 6. 验收命令', '');
  const commands = task.accept.filter(
    (a) => isCommand(a) && a !== 'pnpm verify' && a !== 'pnpm verify:fast',
  );
  const codexSandbox = phase === 'test' || phase === 'handover' || codexFirstImpl;
  if (codexSandbox) {
    // The Codex sandbox runs no test (RO2-01/04); locally only the changed files are checked,
    // never the whole workspace (D10-2406).
    out.push('```', ...LOCAL_CHECKS, '```', '');
  } else {
    out.push('```', 'pnpm verify:fast', ...commands, '```', '');
  }
  const tests = testIds.length === 0 ? '无' : testIds.map((t) => `\`${t}\``).join('、');
  const sandboxNote =
    'Codex 沙箱里只做不执行测试的静态检查（上面两条，只对改动文件）；任何运行测试的命令（含 `pnpm verify:fast`、`pnpm test`）都由编排者在隔离容器或 CI 里跑，你写的东西不在宿主上运行。沙箱里没有网络，连不上数据库和 Docker，也不能监听端口；需要沙箱外的命令写进 `outside_needed`。';
  const claudeTesterNote =
    '你是 Claude 子代理，在任务 worktree 里工作：只做不执行测试的静态检查（上面两条，只对改动文件）；不要在宿主上运行测试（含 `pnpm verify:fast`、`pnpm test`、`vitest`），先红由编排者在隔离容器里跑。不联网、不连库、不起容器、不监听端口；需要沙箱外的命令写进结果的 `outside_needed`。';
  if (phase === 'test') {
    out.push(
      `本轮要的是「先红」：改动文件的 prettier 与 eslint 通过；新写的规则测试在骨架上全部为红，红的原因只能是断言失败、fast-check 反例或骨架抛出的 \`NotImplemented\`，找不到模块、\`TypeError\`、语法错误的红不算（编排者用 \`tools/ops/verify-container.sh ${task.id} --red\` 在隔离容器里只跑本任务新写的规则测试，\`tools/guard/red-check.ts\` 逐个文件对账；没跑到的文件也算不合格）。规则测试放在：${tests}。${task.tester === 'claude' ? claudeTesterNote : sandboxNote}`,
      '',
    );
  } else if (phase === 'handover' || codexFirstImpl) {
    out.push(
      `必须变绿的规则测试：${tests}（由编排者在隔离容器里验证，验收命令：${commands.length === 0 ? '无' : commands.map((c) => `\`${c}\``).join('、')}）。${sandboxNote}`,
      '',
    );
  } else if (oldCodexImpl) {
    out.push(
      `必须变绿的规则测试：${tests}。完整验证由编排者在沙箱外跑。沙箱里没有网络，连不上数据库和 Docker，也不能监听端口：不要跑集成测试、迁移和类型生成，需要时写进 \`outside_needed\`。`,
      '',
    );
  } else {
    out.push(
      `必须变绿的规则测试：${tests}。上面的验收命令由编排者在测试机上跑，完整验证由编排者在沙箱外跑。不连库、不监听端口，不跑集成测试、迁移和类型生成，需要时写进 \`outside_needed\`。`,
      '',
    );
  }

  // Every phase that writes code, but the legacy Codex flow: no heavy command on this machine
  // (D10-2404 / 2406). Review briefs are read-only data and carry no local-command rule.
  if (!oldCodexImpl && phase !== 'review') out.push(LOCAL_ONLY_NOTE, '');

  out.push('## 7. 上一轮失败输出（第 2 次起才有）', '');
  if (input.attempt >= 2) {
    const tail = state?.last_error
      ? failureTail(state.last_error, input.failureTailBytes ?? FAILURE_TAIL_BYTES)
      : ['（在途状态里没有记录上一轮的失败输出）'];
    out.push('```', ...tail, '```', '');
  } else {
    out.push('（第 1 次尝试，没有上一轮。）', '');
  }

  out.push('## 8. 输出', '');
  out.push('按给定的 JSON 结构返回，字段全部必填：', '');
  out.push('| 字段 | 含义 |', '| --- | --- |');
  out.push('| `task_done` | 是否认为完成 |');
  out.push('| `files_changed` | 改动文件列表 |');
  out.push('| `commands` | 跑过的命令与退出码 |');
  out.push(
    phase === 'test'
      ? '| `tests_passed` | 改动文件的 prettier 与 eslint 通过时填 true（类型检查与测试由编排者在测试机上跑，先红由它核对） |'
      : oldCodexImpl || phase === 'review'
        ? '| `tests_passed` | 验收命令是否通过 |'
        : '| `tests_passed` | 改动文件的 prettier 与 eslint 通过时填 true（类型检查与测试由编排者在测试机上跑） |',
  );
  out.push('| `deps_needed` | 需要新装的依赖：名称、版本、理由；没有填空数组 |');
  out.push(
    '| `outside_needed` | 需要编排者在沙箱外跑的命令（迁移、类型生成等）：命令、理由；没有填空数组 |',
  );
  out.push('| `blocked_reason` | 没做完或发现规格冲突时写原因；没有填空串 |');
  out.push('| `notes` | 需要评审方注意的地方，三句以内 |', '');
  // RO-04 / D10-2406: no phase runs tests, tsc or a full lint on this machine; the orchestrator
  // runs them on the test machine. No tail offers a Docker or container entry of its own.
  const tail: Record<BriefPhase, string> = {
    test: 'Do not commit. Do not install dependencies. Do not modify any file under `ops/` or `docs/`. 只写规则 / 验收测试与 `NotImplemented` 骨架，不写实现。只做静态检查，不运行测试，不跑 tsc / pnpm typecheck / pnpm lint 全量；不要运行需要网络、Docker、数据库或监听端口的命令。',
    handover:
      'Do not commit. Do not install dependencies. Do not modify any file under `ops/` or `docs/`. 规则测试已冻结，不改不删。只做静态检查，不运行测试，不跑 tsc / pnpm typecheck / pnpm lint 全量；不要运行需要网络、Docker、数据库或监听端口的命令。',
    impl: 'Do not commit. Do not install dependencies. Do not modify any file under `ops/` or `docs/`. 规则测试已冻结，不改不删；它们是 Codex 写的，只在容器里运行，不在宿主上跑。不在本机跑 tsc / pnpm typecheck / pnpm lint / vitest / verify:fast；不要运行需要网络、Docker、数据库或监听端口的命令。',
    review:
      '评审只读：不改任何文件，不提交，不安装依赖。不要运行需要网络、Docker、数据库或监听端口的命令。',
  };
  out.push(
    oldCodexImpl
      ? 'Do not commit. Do not install dependencies. Do not modify any file under `ops/` or `docs/`. 规则测试已冻结，不改不删。不要运行需要网络、Docker、数据库或监听端口的命令。'
      : codexFirstImpl
        ? tail.handover
        : tail[phase],
  );
  return `${out.join('\n')}\n`;
}

/** Bytes per numbered `## ` section of a brief (the header is section 0), to see what to split. */
export function sectionSizes(text: string): { title: string; bytes: number }[] {
  const sizes: { title: string; bytes: number }[] = [{ title: '0. 文件头', bytes: 0 }];
  let inFence = false;
  let inEmbed = false;
  for (const line of text.split('\n')) {
    // Quoted material carries its own headings: the failure log sits in a fence, embedded
    // AGENTS.md files between the 全文开始 / 全文结束 markers.
    if (/^(```|~~~)/.test(line)) inFence = !inFence;
    if (/^<!-- .+ 全文开始 -->$/.test(line)) inEmbed = true;
    if (/^<!-- .+ 全文结束 -->$/.test(line)) inEmbed = false;
    const heading = inFence || inEmbed ? null : /^## ([1-8]\. .+)$/.exec(line);
    if (heading?.[1] && heading[1].startsWith(`${sizes.length}. `)) {
      sizes.push({ title: heading[1], bytes: 0 });
    }
    const last = sizes[sizes.length - 1];
    if (last) last.bytes += Buffer.byteLength(line, 'utf8') + 1;
  }
  return sizes;
}

export type GenerateOptions = {
  phase?: BriefPhase;
  attempt?: number;
  out?: string;
  root?: string;
  spec?: SpecSource;
  risk?: (paths: readonly string[]) => RiskReport;
  /** Tests replace the banned-terms guard; the default runs it from the trusted root. */
  bannedTerms?: (file: string) => { ok: boolean; detail: string };
};

function runBannedTerms(file: string): { ok: boolean; detail: string } {
  const res = runGuard('banned-terms.ts', ['--file', file]);
  if (res.status === 0) return { ok: true, detail: '' };
  if (res.status === 1) return { ok: false, detail: `${res.stdout}${res.stderr}`.trim() };
  throw new Error(`banned-terms.ts exited ${res.status}: ${res.stderr.trim()}`);
}

/** Generates the brief for a task and returns the path it was written to. */
export function generateBrief(id: string, opts: GenerateOptions = {}): string {
  const root = opts.root ?? repoRoot();
  const task = readTask(id, root);
  const state = readState(id);
  const phase = opts.phase ?? 'impl';
  const legacy = loadLegacyTasks(opts.root ?? trustedRoot()).has(id);
  const codexImpl = isCodexFirst(task, loadCodexImplTasks(opts.root ?? trustedRoot()));
  if (phase === 'test' && task.test_paths.length === 0 && !legacy) {
    throw new CheckError(
      `任务 ${id} 的台账没有 test_paths：测试阶段不派工，先在 ops/tasks/${id}.yaml 补上本任务规则测试的路径（第一类保护路径之内）`,
    );
  }
  // Each phase counts its own rounds (tools/ops/state.ts): Codex writing tests is `test`; the
  // implementation is the Opus attempts plus a handover; a review brief is a single round.
  const used =
    phase === 'test'
      ? (state?.attempts.test ?? 0)
      : phase === 'impl' || phase === 'handover'
        ? (state?.attempts.impl ?? 0) + (state?.attempts.handover ?? 0)
        : 1;
  const attempt = opts.attempt ?? Math.max(1, used);
  const report = (opts.risk ?? riskOfPaths)(task.paths);
  const render = (failureTailBytes: number, compactHops: boolean): string =>
    renderBrief({
      task,
      legacy,
      codexImpl,
      phase,
      risk: report.risk,
      attempt,
      specRef: specRef(),
      state,
      rulesRoot: opts.root ?? trustedRoot(),
      gitRoot: root,
      failureTailBytes,
      compactHops,
      ...(opts.spec ? { spec: opts.spec } : {}),
    });
  // CT-06o: the format is chosen on the brief without the previous failure output, so a long
  // failure log never switches to the compact one-hop table; a brief that fits keeps the full one.
  const compact =
    task.type !== 'contract' && Buffer.byteLength(render(0, false), 'utf8') > MAX_BRIEF_BYTES;
  let text = render(FAILURE_TAIL_BYTES, compact);
  if (attempt >= 2 && Buffer.byteLength(text, 'utf8') > MAX_BRIEF_BYTES) {
    // A retry must not fail on the size of the failure it reports: the previous output gets
    // whatever room the rest of the brief (in the chosen format) leaves, newest lines first.
    const room = MAX_BRIEF_BYTES - Buffer.byteLength(render(0, compact), 'utf8');
    if (room >= MIN_FAILURE_TAIL_BYTES) text = render(room, compact);
  }

  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_BRIEF_BYTES) {
    throw new CheckError(
      `任务书 ${bytes} 字节，超过上限 ${MAX_BRIEF_BYTES} 字节（24KB）：任务 ${id} 该拆小（规划/11 §5.3），没有写出文件${compact ? '（第 2 节一跳引用已改用精简表，只列编号、标题与状态，仍然超限）' : ''}\n` +
        `各节字节数：${sectionSizes(text)
          .map((s) => `${s.title} ${s.bytes}`)
          .join('；')}`,
    );
  }

  const out = opts.out ?? join(runsDir(), id, 'brief.md');
  // Check the candidate before it can be picked up under its final name.
  const candidate = `${out}.candidate`;
  writeFileAtomic(candidate, text);
  try {
    const verdict = (opts.bannedTerms ?? runBannedTerms)(candidate);
    if (!verdict.ok) {
      throw new CheckError(
        `任务书命中禁用词，没有写出文件；先开同步任务修正规划原文（规划/11 §5.5）：\n${verdict.detail}`,
      );
    }
    renameSync(candidate, out);
  } finally {
    rmSync(candidate, { force: true });
  }
  return out;
}

function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { attempt: { type: 'string' }, out: { type: 'string' }, phase: { type: 'string' } },
    allowPositionals: true,
  });
  if (positionals.length !== 1)
    throw new UsageError(
      'brief.ts <id> [--phase test|impl|handover|review] [--attempt <n>] [--out <file>]',
    );
  const id = assertTaskId(positionals[0]);
  const opts: GenerateOptions = {};
  if (values.phase !== undefined) {
    if (!(BRIEF_PHASES as readonly string[]).includes(values.phase)) {
      throw new UsageError(`--phase must be one of ${BRIEF_PHASES.join(', ')}`);
    }
    opts.phase = values.phase as BriefPhase;
  }
  if (values.attempt !== undefined) {
    if (!/^[1-9][0-9]?$/.test(values.attempt)) throw new UsageError('--attempt must be 1..99');
    opts.attempt = Number.parseInt(values.attempt, 10);
  }
  if (values.out !== undefined) opts.out = values.out;
  const out = generateBrief(id, opts);
  console.error(`任务书已生成（${readFileSync(out).length} 字节）`);
  console.log(out);
  return 0;
}

if (import.meta.main) runMain(main);
