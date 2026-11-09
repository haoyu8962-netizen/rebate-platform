// Static checks for .github/workflows/*.yml and ops/branch-protection.json
// (规划/11 §3.2, §4.4, §9.3 #10; ADR-0001 §2 last row).
//
// Usage: node tools/ci/check-workflows.ts [--root <repo dir>] [--json]
// Exit codes: 0 ok, 1 violations, 2 usage or internal error.
//
// The parser is line-based on purpose (no YAML dependency). It relies on the canonical layout
// the workflows are written in: block style, 2-space indentation, job ids at column 2 under a
// top-level `jobs:` line. Anything it cannot recognise is reported, not skipped.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type Problem = { file: string; line: number; code: string; message: string };

type Job = {
  id: string;
  line: number;
  /** Check context reported to GitHub: the job `name:` when present, else the job id. */
  context: string;
  hasNeeds: boolean;
  condition: string | null;
  runsOn: string | null;
  /** Raw text after `runs-on:` (trailing spaces trimmed), compared verbatim with the route. */
  runsOnRaw: string | null;
  /** 0-based indexes of the job-level `runs-on:` lines. */
  runsOnLines: number[];
  /** 0-based index range [start, end) of the job body. */
  body: [number, number];
  /** 0-based index of the job-level `permissions:` line, or null. */
  permissionsLine: number | null;
};

type Workflow = {
  file: string;
  lines: string[];
  jobs: Job[];
  triggers: string[];
};

const WORKFLOW_DIR = '.github/workflows';
const RULESET_FILE = 'ops/branch-protection.json';
const ACTIONS_INTEGRATION_ID = 15368;
const BEGIN_MARKER = '# BEGIN protected-paths.json';
const END_MARKER = '# END protected-paths.json';
const PROTECTED_KEYS = ['class1_add_only', 'class2_verify_config', 'class3_gates'] as const;
const PINNED_USES = /^[\w.-]+\/[\w.-]+(\/[^@\s]+)?@[0-9a-f]{40}$/;

// ADR-0004 §2 (CI heavy jobs routed to the LAN one-shot VM runner; D10-1196 / D10-1206,
// CT-06zzzzp). The only `runs-on` besides `ubuntu-latest`, compared character for character (no
// normalisation): repository variable SELF_HOSTED_CI = 'on' AND (a push, or a PR whose head repo
// is this repo) picks the LAN runner labels; anything else (variable unset or not 'on', fork PRs,
// workflow_dispatch, schedule) stays on ubuntu-latest, so the default is unchanged (§2.1, §2.2).
export const SELF_HOSTED_ROUTE =
  "${{ (vars.SELF_HOSTED_CI == 'on' && (github.event_name == 'push' || " +
  'github.event.pull_request.head.repo.full_name == github.repository)) && ' +
  'fromJSON(\'["self-hosted","couli-ci"]\') || \'ubuntu-latest\' }}';

// Jobs allowed to use SELF_HOSTED_ROUTE, keyed by workflow file name (ADR-0004 §2.5: heavy jobs
// only, enabled in three batches; D10-1206: batch 1 is the commit-SHA-seed property tests). A
// later batch widens this constant, nothing else. Gate checks, summary jobs, jobs with write
// permissions or secrets and pull_request_target / workflow_run workflows never qualify.
export const SELF_HOSTED_JOBS: Readonly<Record<string, readonly string[]>> = {
  'ci.yml': ['verify-props-sha-1', 'verify-props-sha-2', 'verify-props-sha-3'],
};

// The runner label. It may appear only inside SELF_HOSTED_ROUTE on a job's own `runs-on:` line;
// anywhere else, comments included, it is rejected: a comment is cheap to bend into another
// `runs-on` spelling (a flow list, a block list, a different expression) on a later edit, and
// banning the word everywhere keeps the one legitimate place trivially auditable (ADR-0004 §2.6).
const SELF_HOSTED_WORD = /self-hosted/i;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isBlankOrComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith('#');
}

/** Removes a trailing ` # comment` and surrounding quotes from a scalar value. */
function scalar(value: string): string {
  const withoutComment = value.replace(/\s+#.*$/, '').trim();
  const quoted = /^(['"])(.*)\1$/.exec(withoutComment);
  return quoted ? (quoted[2] ?? '') : withoutComment;
}

/** Index range [start, end) of the block that belongs to the key on `lines[keyIndex]`. */
function blockRange(lines: string[], keyIndex: number): [number, number] {
  const keyIndent = indentOf(lines[keyIndex] ?? '');
  let end = keyIndex + 1;
  while (end < lines.length) {
    const line = lines[end] ?? '';
    if (!isBlankOrComment(line) && indentOf(line) <= keyIndent) break;
    end++;
  }
  return [keyIndex + 1, end];
}

function parseWorkflow(file: string, text: string, problems: Problem[]): Workflow {
  const lines = text.split('\n');
  const workflow: Workflow = { file, lines, jobs: [], triggers: [] };
  const add = (line: number, code: string, message: string): void => {
    problems.push({ file, line, code, message });
  };

  if (text.includes('\t')) add(1, 'tab', 'tabs are not allowed in workflow files');

  const topLevel = (key: string): number[] =>
    lines.flatMap((line, i) => (new RegExp(`^${key}:`).test(line) ? [i] : []));

  // --- on: triggers and workflow-level path filters ---
  const onLines = topLevel('on');
  if (onLines.length !== 1) {
    add(1, 'on-block', 'expected exactly one top-level `on:` block');
  } else {
    const onIndex = onLines[0] ?? 0;
    if ((lines[onIndex] ?? '').trim() !== 'on:') {
      add(onIndex + 1, 'on-block', '`on:` must be a block mapping (one trigger per line)');
    }
    const [start, end] = blockRange(lines, onIndex);
    for (let i = start; i < end; i++) {
      const line = lines[i] ?? '';
      if (isBlankOrComment(line)) continue;
      const trigger = /^ {2}([A-Za-z_]+):/.exec(line);
      if (trigger) workflow.triggers.push(trigger[1] ?? '');
      if (/^\s+['"]?paths(-ignore)?['"]?\s*:/.test(line)) {
        add(
          i + 1,
          'workflow-paths',
          'workflow-level `paths` / `paths-ignore` filters are forbidden: a skipped required ' +
            'check stays pending forever; use a job-level `if` plus an `if: always()` summary job',
        );
      }
    }
    if (workflow.triggers.length === 0)
      add(onIndex + 1, 'on-block', 'no trigger found under `on:`');
  }

  // --- permissions: least privilege, declared at workflow level ---
  const permissionLines = topLevel('permissions');
  if (permissionLines.length !== 1) {
    add(1, 'permissions', 'expected exactly one top-level `permissions:` block');
  }
  lines.forEach((line, i) => {
    if (/^\s*permissions:\s*\S/.test(line) && !/^\s*permissions:\s*(#.*)?$/.test(line)) {
      add(
        i + 1,
        'permissions',
        '`permissions` must list scopes explicitly (no write-all/read-all)',
      );
    }
    if (/^\s+[a-z-]+:\s*write\s*(#.*)?$/.test(line) && isInsidePermissions(lines, i)) {
      add(i + 1, 'permissions', 'no workflow in this repo may request a write permission');
    }
  });

  // --- jobs ---
  const jobsLines = topLevel('jobs');
  if (jobsLines.length !== 1 || (lines[jobsLines[0] ?? 0] ?? '').trim() !== 'jobs:') {
    add(1, 'jobs-block', 'expected exactly one top-level `jobs:` block mapping');
    return workflow;
  }
  const [jobsStart, jobsEnd] = blockRange(lines, jobsLines[0] ?? 0);
  for (let i = jobsStart; i < jobsEnd; i++) {
    const line = lines[i] ?? '';
    if (isBlankOrComment(line)) continue;
    if (indentOf(line) !== 2) continue;
    const idMatch = /^ {2}([A-Za-z_][A-Za-z0-9_-]*):\s*(#.*)?$/.exec(line);
    if (!idMatch) {
      add(i + 1, 'jobs-block', 'cannot parse this line as a job id');
      continue;
    }
    const id = idMatch[1] ?? '';
    const job: Job = {
      id,
      line: i + 1,
      context: id,
      hasNeeds: false,
      condition: null,
      runsOn: null,
      runsOnRaw: null,
      runsOnLines: [],
      body: [i + 1, i + 1],
      permissionsLine: null,
    };
    const [bodyStart, bodyEnd] = blockRange(lines, i);
    job.body = [bodyStart, bodyEnd];
    for (let j = bodyStart; j < bodyEnd; j++) {
      const bodyLine = lines[j] ?? '';
      if (indentOf(bodyLine) !== 4) continue;
      const key = /^ {4}([a-z-]+):\s*(.*)$/.exec(bodyLine);
      if (!key) continue;
      const value = scalar(key[2] ?? '');
      if (key[1] === 'name') job.context = value;
      if (key[1] === 'needs') job.hasNeeds = true;
      if (key[1] === 'if') job.condition = value;
      if (key[1] === 'runs-on') {
        job.runsOn = value;
        job.runsOnRaw = (key[2] ?? '').trimEnd();
        job.runsOnLines.push(j);
      }
      if (key[1] === 'permissions') job.permissionsLine = j;
    }
    const routed = job.runsOnRaw === SELF_HOSTED_ROUTE;
    if (job.runsOnLines.length > 1) {
      add(job.line, 'runs-on', `job \`${id}\` has more than one \`runs-on:\` line`);
    } else if (job.runsOn !== 'ubuntu-latest' && !routed) {
      add(
        job.line,
        'runs-on',
        `job \`${id}\` must use \`runs-on: ubuntu-latest\` (never ubuntu-slim; ADR-0001 §2), ` +
          'or, if listed in SELF_HOSTED_JOBS, exactly the fixed ADR-0004 routing expression',
      );
    }
    workflow.jobs.push(job);
  }
  if (workflow.jobs.length === 0) add(jobsLines[0] ?? 1, 'jobs-block', 'workflow has no jobs');

  checkSelfHostedRouting(workflow, [jobsLines[0] ?? 0, jobsEnd], problems);

  // --- uses: every action pinned to a full commit SHA with a version comment ---
  lines.forEach((line, i) => {
    const uses = /^\s*(?:-\s+)?uses:\s*(.+)$/.exec(line);
    if (!uses) return;
    const raw = (uses[1] ?? '').trim();
    const ref = scalar(raw);
    if (!PINNED_USES.test(ref)) {
      add(i + 1, 'unpinned-action', `\`uses: ${ref}\` is not pinned to a 40-hex commit SHA`);
    } else if (!/\s#\s*v\d+(\.\d+)*\s*$/.test(raw)) {
      add(i + 1, 'unpinned-action', `\`uses: ${ref}\` needs a trailing version comment (# vX.Y.Z)`);
    }
  });

  // --- pull_request_target: never touches PR code ---
  if (workflow.triggers.includes('pull_request_target')) {
    lines.forEach((line, i) => {
      if (isBlankOrComment(line)) return;
      if (/^\s*(?:-\s+)?uses:/.test(line)) {
        add(
          i + 1,
          'prt-uses',
          'a pull_request_target workflow must not use any action (no checkout, no artifact ' +
            'download, never executes PR code; 规划/11 §4.4)',
        );
      }
      if (/actions\/checkout|download-artifact|\bgit\s+(clone|fetch|checkout)\b/.test(line)) {
        add(
          i + 1,
          'prt-checkout',
          'a pull_request_target workflow must not check out or download PR content',
        );
      }
    });
  }

  return workflow;
}

/** ADR-0004 §2.5 / §2.6: who may use the self-hosted route, and on what terms. */
/** `jobs` is the 0-based range [the `jobs:` line, end of its block). */
function checkSelfHostedRouting(
  workflow: Workflow,
  jobs: [number, number],
  problems: Problem[],
): void {
  const { file, lines } = workflow;
  const add = (line: number, code: string, message: string): void => {
    problems.push({ file, line, code, message });
  };
  const name = file.slice(file.lastIndexOf('/') + 1);
  const allowed = SELF_HOSTED_JOBS[name] ?? [];
  const routed = workflow.jobs.filter((job) => job.runsOnRaw === SELF_HOSTED_ROUTE);

  // ③ the runner label only inside the fixed expression on a job's single `runs-on:` line.
  const routeLines = new Set(
    routed.filter((job) => job.runsOnLines.length === 1).flatMap((job) => job.runsOnLines),
  );
  lines.forEach((line, i) => {
    if (routeLines.has(i) || !SELF_HOSTED_WORD.test(line)) return;
    add(
      i + 1,
      'self-hosted-text',
      '`self-hosted` may appear only inside the fixed ADR-0004 routing expression on a job ' +
        '`runs-on:` line (comments included)',
    );
  });

  // ⑤ never in a workflow that runs with base-repo privileges on outside input.
  const privileged = workflow.triggers.filter(
    (t) => t === 'pull_request_target' || t === 'workflow_run',
  );
  if (privileged.length > 0) {
    lines.forEach((line, i) => {
      if (!line.includes(SELF_HOSTED_ROUTE)) return;
      add(
        i + 1,
        'self-hosted-trigger',
        `a ${privileged.join(' / ')} workflow must never be routed to the self-hosted runner ` +
          '(ADR-0004 §2.5)',
      );
    });
  }

  if (routed.length === 0) return;
  const topPermissions = lines.findIndex((line) => /^permissions:/.test(line));
  for (const job of routed) {
    // ② only the allowlisted jobs.
    if (!allowed.includes(job.id)) {
      add(
        job.line,
        'self-hosted-job',
        `job \`${job.id}\` is not in SELF_HOSTED_JOBS for ${name}; it must use ` +
          '`runs-on: ubuntu-latest` (ADR-0004 §2.5, D10-1206)',
      );
    }
    // ④ read-only permissions: the job's own block, else the workflow-level block.
    const permIndex = job.permissionsLine ?? (topPermissions >= 0 ? topPermissions : null);
    if (permIndex === null) {
      add(job.line, 'self-hosted-permissions', `routed job \`${job.id}\` has no permissions block`);
    } else {
      const [start, end] = blockRange(lines, permIndex);
      for (let i = permIndex; i < end; i++) {
        const line = lines[i] ?? '';
        if (i >= start && isBlankOrComment(line)) continue;
        if (/write/i.test(line.replace(/\s+#.*$/, ''))) {
          add(
            i + 1,
            'self-hosted-permissions',
            `routed job \`${job.id}\` must be read-only: no \`write\` in its effective ` +
              'permissions (ADR-0004 §2.5)',
          );
        }
      }
    }
    // ④ no secrets: the job body, plus every top-level line outside the `jobs:` block, before
    // or after it (workflow-level env and defaults are inherited by every job). Any `secrets` word counts: `secrets.X`,
    // `secrets['X']`, `toJSON(secrets)`; expression contexts are case-insensitive. Whole-line
    // comments are skipped: they cannot read a secret.
    const [bodyStart, bodyEnd] = job.body;
    const scope = [
      ...lines.flatMap((_, k) => (k < jobs[0] || k >= jobs[1] ? [k] : [])),
      ...Array.from({ length: bodyEnd - bodyStart }, (_, k) => bodyStart + k),
    ];
    for (const i of scope) {
      const line = lines[i] ?? '';
      if (line.trim().startsWith('#') || !/\bsecrets\b/i.test(line)) continue;
      add(
        i + 1,
        'self-hosted-secrets',
        `routed job \`${job.id}\` must not reference secrets (ADR-0004 §2.4, §2.5)`,
      );
    }
  }
}

function isInsidePermissions(lines: string[], index: number): boolean {
  const indent = indentOf(lines[index] ?? '');
  for (let i = index - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    if (isBlankOrComment(line)) continue;
    if (indentOf(line) < indent) return /^\s*permissions:\s*(#.*)?$/.test(line);
  }
  return false;
}

/** Text between the marker lines of the embedded protected-paths list, or null. */
export function extractEmbeddedProtectedPaths(text: string): string | null {
  const lines = text.split('\n');
  const begins = lines.flatMap((line, i) => (line.trim() === BEGIN_MARKER ? [i] : []));
  const ends = lines.flatMap((line, i) => (line.trim() === END_MARKER ? [i] : []));
  if (begins.length !== 1 || ends.length !== 1) return null;
  const begin = begins[0] ?? 0;
  const end = ends[0] ?? 0;
  if (end <= begin) return null;
  return lines.slice(begin + 1, end).join('\n');
}

function checkEmbeddedProtectedPaths(workflows: Workflow[], problems: Problem[]): void {
  const holders = workflows.filter((w) => w.lines.some((line) => line.includes(BEGIN_MARKER)));
  const targets = workflows.filter((w) => w.triggers.includes('pull_request_target'));
  if (targets.length !== 1) {
    problems.push({
      file: WORKFLOW_DIR,
      line: 1,
      code: 'prt-count',
      message: `expected exactly one pull_request_target workflow, found ${targets.length}`,
    });
  }
  if (holders.length !== 1 || holders[0] !== targets[0]) {
    problems.push({
      file: WORKFLOW_DIR,
      line: 1,
      code: 'protected-json',
      message:
        'the protected-paths list must be embedded once, in the pull_request_target workflow',
    });
    return;
  }
  const holder = holders[0];
  if (!holder) return;
  const add = (message: string): void => {
    problems.push({ file: holder.file, line: 1, code: 'protected-json', message });
  };
  const embedded = extractEmbeddedProtectedPaths(holder.lines.join('\n'));
  if (embedded === null) {
    add(`expected exactly one \`${BEGIN_MARKER}\` line followed by one \`${END_MARKER}\` line`);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(embedded);
  } catch (error) {
    add(`embedded protected-paths JSON does not parse: ${(error as Error).message}`);
    return;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    add('embedded protected-paths JSON must be an object');
    return;
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(',');
  if (keys !== [...PROTECTED_KEYS].sort().join(',')) {
    add(`embedded protected-paths JSON must have exactly the keys ${PROTECTED_KEYS.join(', ')}`);
  }
  for (const key of PROTECTED_KEYS) {
    const list = record[key];
    const ok =
      Array.isArray(list) &&
      list.length > 0 &&
      list.every((g) => typeof g === 'string' && g !== '');
    if (!ok) add(`embedded protected-paths JSON: \`${key}\` must be a non-empty string array`);
  }
}

function checkRuleset(root: string, workflows: Workflow[], problems: Problem[]): void {
  const add = (message: string, code = 'ruleset'): void => {
    problems.push({ file: RULESET_FILE, line: 1, code, message });
  };
  const path = join(root, RULESET_FILE);
  if (!existsSync(path)) {
    add('file is missing');
    return;
  }
  let ruleset: Record<string, unknown>;
  try {
    ruleset = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    add(`does not parse: ${(error as Error).message}`);
    return;
  }
  if (ruleset['enforcement'] !== 'active') add('`enforcement` must be "active"');
  const bypass = ruleset['bypass_actors'];
  if (!Array.isArray(bypass) || bypass.length !== 0) {
    add('`bypass_actors` must be an empty array (the ruleset applies to admins too)');
  }
  const rules = Array.isArray(ruleset['rules']) ? (ruleset['rules'] as unknown[]) : [];
  const ruleOf = (type: string): Record<string, unknown> | undefined =>
    rules.find(
      (rule): rule is Record<string, unknown> =>
        rule !== null && typeof rule === 'object' && (rule as { type?: unknown }).type === type,
    );
  for (const type of ['deletion', 'non_fast_forward', 'pull_request', 'required_status_checks']) {
    if (!ruleOf(type)) add(`rule \`${type}\` is missing`);
  }
  const prParams = ruleOf('pull_request')?.['parameters'] as Record<string, unknown> | undefined;
  if (prParams && prParams['required_approving_review_count'] !== 0) {
    add('`required_approving_review_count` must be 0 (a single account cannot approve itself)');
  }
  const checkParams = ruleOf('required_status_checks')?.['parameters'] as
    Record<string, unknown> | undefined;
  const checks = Array.isArray(checkParams?.['required_status_checks'])
    ? (checkParams['required_status_checks'] as unknown[])
    : [];
  if (checks.length === 0) add('no required status checks listed');

  const jobsByContext = new Map<string, { workflow: Workflow; job: Job }[]>();
  for (const workflow of workflows) {
    for (const job of workflow.jobs) {
      const list = jobsByContext.get(job.context) ?? [];
      list.push({ workflow, job });
      jobsByContext.set(job.context, list);
    }
  }
  for (const entry of checks) {
    const check = (entry ?? {}) as Record<string, unknown>;
    const context = typeof check['context'] === 'string' ? check['context'] : '';
    if (context === '') {
      add('a required status check has no `context`');
      continue;
    }
    if (check['integration_id'] !== ACTIONS_INTEGRATION_ID) {
      add(
        `required check \`${context}\` must be pinned to integration_id ${ACTIONS_INTEGRATION_ID}`,
      );
    }
    const owners = jobsByContext.get(context) ?? [];
    if (owners.length !== 1) {
      add(
        `required check \`${context}\` must be the name of exactly one job across all workflows, ` +
          `found ${owners.length}`,
        'required-context',
      );
      continue;
    }
    const owner = owners[0];
    if (!owner) continue;
    const { job, workflow } = owner;
    // A job skipped by `needs` or by its own `if` reports "skipped", which GitHub counts as
    // passing. A required job therefore either has no condition and no needs, or is an
    // `if: always()` summary job.
    const condition = job.condition;
    const ok = job.hasNeeds
      ? condition === 'always()'
      : condition === null || condition === 'always()';
    if (!ok) {
      problems.push({
        file: workflow.file,
        line: job.line,
        code: 'required-job-condition',
        message:
          `required job \`${job.id}\` can be skipped (needs or a conditional \`if\`); a skipped ` +
          'job counts as passing: make it an `if: always()` summary job',
      });
    }
  }
}

export function checkWorkflows(root: string): Problem[] {
  const problems: Problem[] = [];
  const dir = join(root, WORKFLOW_DIR);
  const names = existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => /\.ya?ml$/.test(name))
        .sort()
    : [];
  if (names.length === 0) {
    problems.push({
      file: WORKFLOW_DIR,
      line: 1,
      code: 'no-workflows',
      message: 'no workflow files',
    });
    return problems;
  }
  const workflows = names.map((name) =>
    parseWorkflow(`${WORKFLOW_DIR}/${name}`, readFileSync(join(dir, name), 'utf8'), problems),
  );

  // Job ids and check contexts are unique across all workflows.
  const seen = new Map<string, string>();
  for (const workflow of workflows) {
    for (const job of workflow.jobs) {
      for (const label of new Set([job.id, job.context])) {
        const first = seen.get(label);
        if (first !== undefined) {
          problems.push({
            file: workflow.file,
            line: job.line,
            code: 'duplicate-job',
            message: `job name \`${label}\` is already used in ${first}`,
          });
        } else {
          seen.set(label, workflow.file);
        }
      }
    }
  }

  checkEmbeddedProtectedPaths(workflows, problems);
  checkRuleset(root, workflows, problems);
  return problems;
}

function main(argv: string[]): number {
  let root = resolve(import.meta.dirname, '../..');
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--root' && argv[i + 1] !== undefined) {
      root = resolve(argv[++i] ?? '.');
    } else {
      console.error('usage: node tools/ci/check-workflows.ts [--root <repo dir>] [--json]');
      return 2;
    }
  }
  const problems = checkWorkflows(root);
  if (json) console.log(JSON.stringify({ ok: problems.length === 0, problems }, null, 2));
  for (const p of problems) console.error(`${p.file}:${p.line} [${p.code}] ${p.message}`);
  console.error(
    problems.length === 0
      ? 'check-workflows: ok'
      : `check-workflows: ${problems.length} problem(s)`,
  );
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`check-workflows: internal error: ${(error as Error).stack ?? String(error)}`);
    process.exitCode = 2;
  }
}
