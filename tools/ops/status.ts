// Status board (`pnpm ops:status`, 规划/11 §2.1, §5.2, §7.2).
// Nothing here is stored: every run recomputes the board from the ledger, the
// state files and run directories, git and the usage ledger (token accounting only).
//
//   node tools/ops/status.ts [--json [--all]]
//
// `--json` prints only the rows that are not done (rows_scope "open"); `--all`
// adds the done rows back (rows_scope "all"). Every other field is the same
// either way: counts, ready, warnings and the rest are computed from the whole
// ledger before the rows are cut (FU-STATUS-JSON-SIZE, CT-06zzzn).
import { parseArgs } from 'node:util';
import { git } from '../lib/git.ts';
import { repoRoot, specRef } from '../lib/paths.ts';
import { listTaskIds } from '../lib/task-file.ts';
import type { TaskFile } from '../lib/task-file.ts';
import { formatBeijing, runMain, UsageError } from './cli.ts';
import { orchestratorLockStatus } from './lock.ts';
import type { LockStatus } from './lock.ts';
import { pathSetsMayOverlap } from './overlap.ts';
import {
  emptyAttempts,
  ENGINES,
  listStates,
  MAX_CALLS_PER_TASK,
  MAX_CONSECUTIVE_NO_OUTPUT,
  taskCalls,
} from './state.ts';
import type { BreakerReason, TaskState } from './state.ts';
import { archivedTaskIds, batchRisk, readTask, riskSources } from './task.ts';
import type { RiskLevel, RiskReport } from './task.ts';
import { currentSummary } from './usage.ts';
import type { Summary } from './usage.ts';

/** Rows printed before the table is cut short (keeps the board inside the §5.2 budget). */
const MAX_ROWS = 30;
const HOUR_MS = 3600_000;

export type BoardRow = {
  id: string;
  repo: string;
  title: string;
  risk: RiskLevel | 'unknown';
  impl: string;
  tester: string;
  deps: { id: string; done: boolean }[];
  status: 'todo' | 'done' | 'void';
  state: string | null;
  attempts: TaskState['attempts'];
  pr: number | null;
};

export type AskItem = {
  id: string;
  created_at: string;
  age_hours: number;
  level: 'ok' | '24h' | '72h';
};

export type Board = {
  at: string;
  spec_ref: string;
  lock: LockStatus;
  /** Token accounting only: the Codex quota is unlimited (规划/11 §1.3). */
  usage: Summary;
  /** Open failure breakers of in-flight tasks (规划/11 §2.5); each stops only its own task. */
  breakers: BreakerReason[];
  remote: string | null;
  rows: BoardRow[];
  done_count: number;
  /** Cancelled tasks (status void, D10-190): not dispatched, not counted as done. */
  void_count: number;
  ready: string[];
  asks: AskItem[];
  stall: string | null;
  warnings: string[];
};

export type BoardOptions = {
  root?: string;
  now?: Date;
  risk?: (paths: readonly string[]) => RiskReport;
  /** Injected by tests: many sets at once (see task.ts riskSources). */
  riskSets?: (sets: readonly (readonly string[])[]) => RiskReport[];
};

/** States that hold a task's paths: everything except "queued". */
function inFlight(state: TaskState | undefined): boolean {
  return state !== undefined && state.state !== 'ready';
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Hours between two instants that fall on Monday to Friday in +08:00. */
export function workingHoursBetween(from: Date, to: Date): number {
  let hours = 0;
  for (let t = from.getTime(); t + HOUR_MS <= to.getTime(); t += HOUR_MS) {
    const day = new Date(t + 8 * HOUR_MS).getUTCDay();
    if (day !== 0 && day !== 6) hours += 1;
  }
  return hours;
}

type GitFacts = { remote: string | null; taskBranches: string[]; worktreeBranches: string[] };

function gitFacts(root: string, warnings: string[]): GitFacts {
  const facts: GitFacts = { remote: null, taskBranches: [], worktreeBranches: [] };
  try {
    const remotes = git(['remote'], { cwd: root })
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    facts.remote = remotes[0] ?? null;
    facts.taskBranches = git(['branch', '--list', 'task/*', '--format=%(refname:short)'], {
      cwd: root,
    })
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    for (const line of git(['worktree', 'list', '--porcelain'], { cwd: root }).split('\n')) {
      const m = /^branch refs\/heads\/(task\/.+)$/.exec(line.trim());
      if (m?.[1]) facts.worktreeBranches.push(m[1]);
    }
  } catch (err) {
    const first = (err instanceof Error ? err.message : String(err)).split('\n')[0];
    warnings.push(`git 不可用，分支与 worktree 未核对：${first}`);
  }
  return facts;
}

export function collectBoard(opts: BoardOptions = {}): Board {
  const root = opts.root ?? repoRoot();
  const now = opts.now ?? new Date();
  const warnings: string[] = [];

  const tasks = new Map<string, TaskFile>();
  for (const id of listTaskIds(root)) {
    try {
      tasks.set(id, readTask(id, root));
    } catch (err) {
      const first = (err instanceof Error ? err.message : String(err)).split('\n')[0];
      warnings.push(`台账文件 ${id}.yaml 无法解析（运行 pnpm ops:task:check）：${first}`);
    }
  }

  // One guard call for every open task instead of one per task (batchRisk).
  const riskFn = batchRisk(
    [...tasks.values()].filter((t) => t.status === 'todo').map((t) => t.paths),
    riskSources({
      ...opts,
      onRiskFallback: (reason) =>
        warnings.push(`风险级未能合并计算，已逐个任务计算：${reason.split('\n')[0]}`),
    }),
  );

  const states = new Map<string, TaskState>();
  try {
    for (const s of listStates()) states.set(s.id, s);
  } catch (err) {
    warnings.push(`在途状态文件损坏：${err instanceof Error ? err.message : String(err)}`);
  }

  // Archived tasks are done by definition (规划/11 §2.1).
  const archived = new Set(archivedTaskIds(root));
  const rows: BoardRow[] = [];
  for (const task of tasks.values()) {
    const state = states.get(task.id);
    let risk: BoardRow['risk'] = 'unknown';
    if (task.status === 'todo') {
      try {
        risk = riskFn(task.paths).risk;
      } catch (err) {
        const first = (err instanceof Error ? err.message : String(err)).split('\n')[0];
        warnings.push(`${task.id} 风险级算不出：${first}`);
      }
    }
    rows.push({
      id: task.id,
      repo: task.repo,
      title: task.title,
      risk,
      impl: task.impl,
      tester: task.tester,
      deps: task.deps.map((d) => ({
        id: d,
        done: tasks.get(d)?.status === 'done' || archived.has(d),
      })),
      status: task.status,
      state: state?.state ?? null,
      attempts: state?.attempts ?? emptyAttempts(),
      pr: task.pr,
    });
  }

  const busy = rows.filter((r) => r.status === 'todo' && inFlight(states.get(r.id)));
  const ready: string[] = [];
  for (const row of rows) {
    if (row.status !== 'todo' || inFlight(states.get(row.id))) continue;
    if (!row.deps.every((d) => d.done)) continue;
    const paths = tasks.get(row.id)?.paths ?? [];
    const clash = busy.find((b) => pathSetsMayOverlap(paths, tasks.get(b.id)?.paths ?? []));
    if (!clash) ready.push(row.id);
  }

  const asks: AskItem[] = [];
  for (const s of states.values()) {
    if (s.state !== 'ask') continue;
    const created = s.ask_created_at ?? s.updated_at;
    const age = (now.getTime() - Date.parse(created)) / HOUR_MS;
    asks.push({
      id: s.id,
      created_at: created,
      age_hours: Math.round(age * 10) / 10,
      level: age >= 72 ? '72h' : age >= 24 ? '24h' : 'ok',
    });
  }
  asks.sort((a, b) => b.age_hours - a.age_hours);

  // 规划/11 §7.2: no ready task while pull requests wait, for one working day.
  // Without the GitHub side the state `pr` stands in for "unmerged PR".
  let stall: string | null = null;
  const waiting = [...states.values()].filter((s) => s.state === 'pr');
  if (ready.length === 0 && waiting.length > 0) {
    const oldest = waiting.reduce((a, b) => (a.updated_at < b.updated_at ? a : b));
    if (workingHoursBetween(new Date(oldest.updated_at), now) >= 24) {
      stall = `就绪任务为 0，且 ${waiting.map((s) => s.id).join('、')} 停在 pr 状态已满 1 个工作日：通知负责人（规划/11 §7.2）`;
    }
  }

  // A void task never completes (D10-190): a todo task that still depends on one is stuck.
  for (const task of tasks.values()) {
    if (task.status !== 'todo') continue;
    for (const d of task.deps) {
      if (tasks.get(d)?.status === 'void')
        warnings.push(`${task.id} 依赖的 ${d} 已作废（void），改依赖或作废本任务`);
    }
  }

  for (const s of states.values()) {
    const task = tasks.get(s.id);
    if (!task) warnings.push(`${s.id} 有在途状态文件，但台账里没有这个任务`);
    else if (task.status === 'done' && s.state !== 'ready') {
      warnings.push(`${s.id} 台账已 done，在途状态仍是 ${s.state}`);
    }
    if (s.pid !== null && !pidAlive(s.pid)) {
      warnings.push(`${s.id} 记录的后台进程 ${s.pid} 已不在：按孤儿回收（规划/11 §2.5）`);
    }
    if (s.lease_until !== null && Date.parse(s.lease_until) < now.getTime()) {
      warnings.push(`${s.id} 的租约已过期（持有者 ${s.owner_session ?? '未知'}），其他会话可接手`);
    }
  }

  const facts = gitFacts(root, warnings);
  for (const branch of new Set([...facts.taskBranches, ...facts.worktreeBranches])) {
    const id = branch.slice('task/'.length);
    if (!states.has(id)) warnings.push(`分支 ${branch} 存在，但没有在途状态文件`);
  }

  const usage = currentSummary(now);
  const breakers: BreakerReason[] = [];
  // Each engine has its own failure breakers (ops/approvals.yaml id 36).
  for (const s of states.values()) {
    for (const engine of ENGINES) breakers.push(...taskCalls(s.id, engine).reasons);
  }

  return {
    at: now.toISOString(),
    spec_ref: specRef(),
    lock: orchestratorLockStatus(now),
    usage,
    breakers,
    remote: facts.remote,
    rows,
    done_count: rows.filter((r) => r.status === 'done').length,
    void_count: rows.filter((r) => r.status === 'void').length,
    ready,
    asks,
    stall,
    warnings,
  };
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function rowLine(r: BoardRow): string {
  const deps =
    r.deps.length === 0
      ? '—'
      : r.deps.map((d) => `${d.id}（${d.done ? 'done' : 'todo'}）`).join('、');
  const reviews: string[] = [];
  // Codex writing the rule tests and a handover implementation are not implementation rounds
  // of the Opus subagent (ops/approvals.yaml id 19).
  if (r.attempts.test > 0) reviews.push(`写测试 ${r.attempts.test}`);
  if (r.attempts.handover > 0) reviews.push(`换家实现 ${r.attempts.handover}`);
  if (r.attempts['spec-test'] > 0) reviews.push(`规则测试评审 ${r.attempts['spec-test']}`);
  if (r.attempts.code > 0) reviews.push(`代码评审 ${r.attempts.code}`);
  const attempts =
    reviews.length > 0 ? `${r.attempts.impl}（${reviews.join('，')}）` : String(r.attempts.impl);
  return `| ${[
    r.id,
    r.repo,
    cell(r.title),
    r.risk,
    `${r.impl} / ${r.tester}`,
    deps,
    r.state ?? '—',
    attempts,
    r.pr === null ? '—' : `#${r.pr}`,
  ].join(' | ')} |`;
}

export function renderBoard(b: Board): string {
  const out: string[] = [];
  out.push(`# 看板 ${formatBeijing(new Date(b.at))}（北京时间）`);
  out.push('');
  out.push(`- SPEC_REF：\`${b.spec_ref.slice(0, 12)}\``);
  if (!b.lock.held) {
    out.push('- 编排锁：无人持有');
  } else {
    const who = b.lock.holder ? `${b.lock.holder.session}（pid ${b.lock.holder.pid}）` : '未知';
    out.push(
      `- 编排锁：由 ${who} 持有，心跳 ${formatBeijing(new Date(b.lock.heartbeat_at))}` +
        (b.lock.stale
          ? '，已超过 20 分钟，可接管'
          : '；持锁期间不要在本仓库提交，要做的事写进 couli-runs/inbox/'),
    );
  }
  out.push(
    `- Codex 调用：今日 ${b.usage.calls_today} 次，${b.usage.tokens_today} token（只记账；额度不设限制）`,
  );
  const limits = `每任务 ${MAX_CALLS_PER_TASK} 次调用、连续 ${MAX_CONSECUTIVE_NO_OUTPUT} 次无产出`;
  if (b.breakers.length > 0) {
    out.push(`- 失败熔断（${limits}）：已停的任务不再派工，报告负责人`);
    for (const r of b.breakers) out.push(`  - ${r.message}`);
  } else {
    out.push(`- 失败熔断（${limits}）：未触发`);
  }
  out.push(
    b.remote === null
      ? '- PR/CI: 未接入（没有 GitHub 远端） — TODO(规划/11 §2.1): 接入 gh 查询未合并 PR 与 CI 状态 — blocked on GitHub remote'
      : `- PR/CI: 未接入（已有远端 ${b.remote}，gh 查询尚未实现） — TODO(规划/11 §2.1): 接入 gh 查询未合并 PR 与 CI 状态`,
  );
  out.push('');

  const open = b.rows.filter((r) => r.status === 'todo');
  // In-flight tasks first, then ready ones, then the rest of the backlog.
  const rank = (r: BoardRow): number =>
    r.state !== null && r.state !== 'ready' ? 0 : b.ready.includes(r.id) ? 1 : 2;
  open.sort((x, y) => rank(x) - rank(y) || x.id.localeCompare(y.id));
  out.push('| 编号 | 仓库 | 标题 | 风险级 | 实现 / 测试 | 依赖 | 在途状态 | 尝试 | PR |');
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of open.slice(0, MAX_ROWS)) out.push(rowLine(r));
  if (open.length > MAX_ROWS)
    out.push(`| … | | 另有 ${open.length - MAX_ROWS} 个未开始的任务未列出 | | | | | | |`);
  if (open.length === 0) out.push('| — | | 没有未完成的任务 | | | | | | |');
  out.push('');
  out.push(`已完成 ${b.done_count} 个（不列出）。`);
  if (b.void_count > 0) out.push(`已作废 ${b.void_count} 个（不列出、不派工）。`);
  out.push(
    `就绪任务（依赖已完成、路径不与在途任务相交）：${b.ready.length === 0 ? '无' : b.ready.join('、')}`,
  );

  if (b.asks.length > 0) {
    out.push('');
    out.push('等负责人答复（ask）：');
    for (const a of b.asks) {
      const flag =
        a.level === '72h'
          ? '【红】超过 72 小时，计入周报'
          : a.level === '24h'
            ? '超过 24 小时：下一次对话第一句置顶并推送一次'
            : '24 小时内';
      out.push(`- ${a.id}：提出于 ${formatBeijing(new Date(a.created_at))}，${flag}`);
    }
  }
  if (b.stall !== null) {
    out.push('');
    out.push(`停滞告警：${b.stall}`);
  }
  if (b.warnings.length > 0) {
    out.push('');
    out.push('需要处理：');
    for (const w of b.warnings) out.push(`- ${w}`);
  }
  return `${out.join('\n')}\n`;
}

/** Which rows `--json` prints: "open" leaves out done rows, "all" keeps every row. */
export type RowsScope = 'open' | 'all';

export type BoardJson = Board & { rows_scope: RowsScope };

/**
 * The `--json` output. Only `rows` depends on the scope; every other field is
 * the board as computed from the whole ledger (done_count, ready, warnings, …).
 * The done rows are left out by default because they make up most of the output
 * and only grow (FU-STATUS-JSON-SIZE).
 */
export function boardJson(board: Board, scope: RowsScope): BoardJson {
  const rows = scope === 'all' ? board.rows : board.rows.filter((r) => r.status !== 'done');
  return { ...board, rows_scope: scope, rows };
}

function main(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
    },
  });
  if (values.all && !values.json) {
    throw new UsageError(
      '--all only applies to --json (the Markdown board never lists done tasks)',
    );
  }
  const board = collectBoard();
  if (values.json)
    console.log(JSON.stringify(boardJson(board, values.all ? 'all' : 'open'), null, 2));
  else process.stdout.write(renderBoard(board));
  return 0;
}

if (import.meta.main) runMain(main);
