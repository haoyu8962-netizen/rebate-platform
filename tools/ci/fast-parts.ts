// CT-06zzzzzzzb (FU-VERIFY-FAST-PROFILE, D10-2503 / D10-2504): `pnpm run verify:fast` cut into the
// parts CI runs it as, read from .github/workflows/ci.yml and the root package.json themselves (the
// run: steps of those jobs are only checked against the trusted list below), for
// tools/ops/verify-container.sh --fast-part / --fast and tools/ops/verify-sharded-summary.ts.
//
//   node tools/ci/fast-parts.ts [--workflow <path>] [--package-json <path>]
//     (defaults: .github/workflows/ci.yml and package.json of this checkout)
//     one JSON line { n, parts: [{ id, commands }] }: "base" = the steps of verify:fast with the
//     one step `pnpm run test` replaced by the turbo test command of the job verify-unit, then
//     "spec-1" … "spec-N" = the one `--shard=<i>/<N>` command of the job verify-spec-<i>. Exit 0;
//     2 when a file cannot be read or the shape is not that one (stderr names why).
//   node tools/ci/fast-parts.ts --steps [--package-json <path>]
//     one JSON line { steps: [...] }: the steps of verify:fast (verifyFastSteps).
//
// Set equality (D10-2504): base + spec-1 … spec-N run exactly the tests of verify:fast. That holds
// only when (1) verify:fast has exactly one step `pnpm run test`; (2) the root `test` script is
// `turbo run test` over the whole workspace (at most `--env-mode=<mode>`, no filter) and the
// verify-unit command is `pnpm exec <root test script>` plus one `--filter='!<P>'` and nothing
// else; (3) every spec command is `pnpm --filter <P> run test --shard=<i>/<N>` with that same <P>,
// one per i in 1..N, one N, the job named after its i; (4) every `run:` step of verify-unit and
// verify-spec-<i> is, as written, one of the trusted list below (TESTED_BLOCK, INSTALL_RUN,
// UNIT_RUNS verbatim; the two test templates whole, holes <P> / <i> / <N> only of their strict
// shapes, r6): any other block scalar, a continued line, a backslash, `;`, `&&`,
// an env prefix or any step not in the list throws, naming the job and the step (D10-2548). Anything
// else throws too (exit 2 on the command line).
//
// WHEN THE run: STEPS OF verify-unit OR verify-spec-<i> IN ci.yml CHANGE, CHANGE THE TRUSTED LIST
// HERE IN THE SAME COMMIT. Until then fast-parts exits 2 (and --fast-part / --fast refuse to run):
// that is on purpose, the list is the gate, not a copy of ci.yml.
//
// Node built-in modules only; the line-based YAML reading is that of tools/ci/int-shards.ts.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type FastPart = { id: string; commands: string[] };
export type FastParts = { n: number; parts: FastPart[] };

const ROOT_TEST_STEP = 'pnpm run test';
/** The root `test` script: every package of the workspace, no filter or other package selection. */
const ROOT_TEST_SCRIPT = /^turbo run test(?: --env-mode=(?:loose|strict|infer))?$/;
/** One word of a plain verify:fast step: no quotes, no shell syntax of any kind. */
const PLAIN_STEP = /^[A-Za-z0-9@%:/._=,+-]+(?: +[A-Za-z0-9@%:/._=,+-]+)*$/;
const UNIT_FILTER = /^--filter=(['"]?)!([A-Za-z0-9@/._-]+)\1$/;
const SPEC_COMMAND = /^pnpm --filter ([A-Za-z0-9@/._-]+) run test --shard=(\d+)\/(\d+)$/;
const SPEC_JOB = /^verify-spec-(\d+)$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function scriptsOf(packageJsonText: string): Record<string, unknown> {
  let pkg: unknown;
  try {
    pkg = JSON.parse(packageJsonText);
  } catch {
    throw new Error('package.json is not valid JSON');
  }
  const scripts = isRecord(pkg) ? pkg['scripts'] : undefined;
  if (!isRecord(scripts)) throw new Error('package.json has no `scripts`');
  return scripts;
}

/**
 * The steps of the root `verify:fast` script, split on `&&`, surrounding blanks removed. Throws
 * when the script is missing or any step is not a plain command (`;`, `|`, `||`, `$`, backticks,
 * redirections, quotes, a newline or any other shell syntax).
 */
export function verifyFastSteps(packageJsonText: string): string[] {
  const fast = scriptsOf(packageJsonText)['verify:fast'];
  if (typeof fast !== 'string' || fast.trim() === '') {
    throw new Error('package.json has no `verify:fast` script');
  }
  const steps = fast.split('&&').map((step) => step.trim());
  for (const step of steps) {
    if (!PLAIN_STEP.test(step)) {
      throw new Error(
        `verify:fast has a step that is not a plain command: ${JSON.stringify(step)}`,
      );
    }
  }
  return steps;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isBlankOrComment(line: string): boolean {
  const t = line.trim();
  return t === '' || t.startsWith('#');
}

type Job = { id: string; lines: string[] };

const JOB_HEAD = /^ {2}(?:"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)'|([A-Za-z0-9_-]+))\s*:\s*(#.*)?$/;

/**
 * The jobs under `jobs:`, in file order (a repeated id stays repeated). A job keeps every line
 * after its head, blank and comment lines included (they may belong to a block scalar). A line at
 * job level that is not a plain `<id>:` head throws.
 */
function jobsOf(text: string): Job[] {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => /^jobs:\s*(#.*)?$/.test(l));
  if (at < 0) throw new Error('the workflow has no top-level `jobs:`');
  const jobs: Job[] = [];
  let current: Job | null = null;
  for (const line of lines.slice(at + 1)) {
    if (isBlankOrComment(line)) {
      current?.lines.push(line);
      continue;
    }
    if (indentOf(line) === 0) break;
    if (indentOf(line) <= 2) {
      const head = JOB_HEAD.exec(line);
      if (!head) throw new Error(`a line at job level is not a job head: ${line.trim()}`);
      current = { id: head[1] ?? head[2] ?? head[3] ?? '', lines: [] };
      jobs.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return jobs;
}

/**
 * One `run:` step as written: `header` is the text after `run:` with surrounding blanks removed
 * (nothing else: quotes, comments and backslashes stay); `body` is, for a value that goes on over
 * further lines (a block scalar or a continued scalar), those lines with their common indentation
 * removed, joined by newlines (trailing empty lines dropped), else null.
 */
type RunStep = { header: string; body: string | null };

/** `key: value` with a plain or quoted key, after optional `- ` sequence entries. */
const KEYED = /^(\s*(?:-\s+)*)(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_<-]+))\s*:(?:\s+(.*))?$/;

/**
 * The `run:` steps of a job (any `run` key that is not inside another key's multi-line value).
 * Syntax this line reading could misplace a step under throws instead: flow mappings, anchors,
 * aliases, merge and explicit keys, tags, and a quoted value not closed on its line.
 */
function runSteps(job: Job): RunStep[] {
  const out: RunStep[] = [];
  let open: { column: number; block: boolean; lines: string[]; step: RunStep | null } | null = null;
  const close = () => {
    const lines = [...(open?.lines ?? [])];
    while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '') lines.pop();
    if (open?.step && lines.length > 0) {
      const first = lines.find((l) => l.trim() !== '') ?? '';
      const indent = indentOf(first);
      for (const l of lines) {
        if (l.trim() !== '' && indentOf(l) < indent) {
          throw new Error(`job ${job.id}: a \`run:\` block line is less indented than its first`);
        }
      }
      open.step.body = lines.map((l) => (l.trim() === '' ? '' : l.slice(indent))).join('\n');
    }
    open = null;
  };
  for (const line of job.lines) {
    if (open !== null && (line.trim() === '' || indentOf(line) > open.column)) {
      // In a block scalar a `#` line is text; after a plain or quoted value it is a comment.
      if (!open.block && line.trim().startsWith('#')) continue;
      open.lines.push(line);
      continue;
    }
    close();
    if (isBlankOrComment(line)) continue;
    const keyed = KEYED.exec(line);
    const lead = line.trim().replace(/^(?:-\s+)+/, '');
    if (!keyed) {
      if (/^[{[&*!?|>"']/.test(lead)) {
        throw new Error(`job ${job.id}: unsupported YAML syntax: ${line.trim()}`);
      }
      continue;
    }
    const key = keyed[2] ?? keyed[3] ?? keyed[4] ?? '';
    const value = (keyed[5] ?? '').trim();
    if (
      key === '<<' ||
      /^[{&*!]/.test(value) ||
      (/^\[/.test(value) && !/^\[[^"'{}[\]]*\]$/.test(value))
    ) {
      throw new Error(`job ${job.id}: unsupported YAML syntax: ${line.trim()}`);
    }
    if (/^["']/.test(value) && !isClosedQuoted(value.replace(/\s+#.*$/, ''))) {
      throw new Error(`job ${job.id}: a quoted value not closed on its line: ${line.trim()}`);
    }
    const step: RunStep | null = key === 'run' ? { header: value, body: null } : null;
    if (step) out.push(step);
    // Deeper lines continue this value (block scalar, continued scalar) or, under any key other
    // than run with an empty value, are a nested mapping read on its own.
    if (step || value !== '')
      open = { column: (keyed[1] ?? '').length, block: /^[|>]/.test(value), lines: [], step };
  }
  close();
  return out;
}

/** One single- or double-quoted scalar closed on its line. */
function isClosedQuoted(value: string): boolean {
  return value.startsWith("'") ? /^'(?:[^']|'')*'$/.test(value) : /^"(?:[^"\\]|\\.)*"$/.test(value);
}

/**
 * The trusted list (D10-2548, approvals 152): every `run:` step of the jobs verify-unit and
 * verify-spec-<i> in .github/workflows/ci.yml, verbatim except for the holes of the two test
 * templates below. `run:` values are compared as written
 * (see RunStep): no unquoting, no joining of continued lines, no removal of backslashes or blanks.
 */
const TESTED_BLOCK = [
  "tree=$(git rev-parse 'HEAD^{tree}')",
  'echo "tree=$tree" >> "$GITHUB_OUTPUT"',
  'echo "$tree" > "$RUNNER_TEMP/verified-tree.txt"',
].join('\n');
const INSTALL_RUN = 'pnpm install --frozen-lockfile';
const UNIT_RUNS = ['pnpm build', 'pnpm --filter @couli/api run smoke:entries'];

/**
 * The two test commands are templates with holes (r6, D10-2572): `<P>` a package name of the
 * strict shape below (no blanks, quotes, `;`, backslashes, `&` or other shell syntax), `<i>` and
 * `<N>` positive integers without a leading 0. Everything else is fixed text, escaped literally;
 * a step must match a whole template, as written. Which <P> and N the parts use is then derived
 * and cross-checked in readFastParts (D10-2504).
 */
const PACKAGE_HOLE = '@?[a-z0-9][a-z0-9._-]*(?:/[a-z0-9][a-z0-9._-]*)?';
const COUNT_HOLE = '[1-9][0-9]*';
const UNIT_TEST_TEMPLATE = "pnpm exec turbo run test --env-mode=loose --filter='!<P>'";
const SPEC_TEST_TEMPLATE = 'pnpm --filter <P> run test --shard=<i>/<N>';

/** An anchored regex for a template: fixed text escaped, each hole one capture group. */
function templateRegex(template: string): RegExp {
  const source = template
    .split(/(<P>|<i>|<N>)/)
    .map((piece) => {
      if (piece === '<P>') return `(${PACKAGE_HOLE})`;
      if (piece === '<i>' || piece === '<N>') return `(${COUNT_HOLE})`;
      return piece.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${source}$`);
}
const UNIT_TEST_RUN = templateRegex(UNIT_TEST_TEMPLATE);
const SPEC_TEST_RUN = templateRegex(SPEC_TEST_TEMPLATE);

/** Whether a step is in the trusted list for the job (verify-unit, or verify-spec-<specIndex>). */
function isTrusted(step: RunStep, specIndex: number | null): boolean {
  if (step.header === '|' && step.body === TESTED_BLOCK) return true;
  if (step.body !== null) return false;
  if (step.header === INSTALL_RUN) return true;
  if (specIndex === null) {
    return UNIT_RUNS.includes(step.header) || UNIT_TEST_RUN.test(step.header);
  }
  const m = SPEC_TEST_RUN.exec(step.header);
  return m !== null && m[2] === String(specIndex);
}

/**
 * The one-line `run:` commands of a job, after checking every `run:` step against the trusted
 * list; throws, naming the job and the step as written, at the first step not in it.
 */
function trustedCommandsOf(job: Job, specIndex: number | null): string[] {
  const out: string[] = [];
  for (const step of runSteps(job)) {
    if (!isTrusted(step, specIndex)) {
      const written = step.body === null ? step.header : `${step.header}\n${step.body}`;
      throw new Error(
        `job ${job.id}: a \`run:\` step not in the trusted list of tools/ci/fast-parts.ts: ${JSON.stringify(written)}`,
      );
    }
    if (step.body === null) out.push(step.header);
  }
  return out;
}

const TURBO_TEST = /(?:^|\s)turbo run test(?=\s|$)/;
const PACKAGE_TEST = /(?:^|\s)run test(?=\s|$)|--shard=/;

/** The parts of verify:fast as CI runs them; throws when the two files do not have that shape. */
export function readFastParts(workflowText: string, packageJsonText: string): FastParts {
  const steps = verifyFastSteps(packageJsonText);
  const testSteps = steps.filter((s) => s === ROOT_TEST_STEP);
  if (testSteps.length !== 1) {
    throw new Error(
      `verify:fast must have exactly one step \`${ROOT_TEST_STEP}\`, found ${String(testSteps.length)}`,
    );
  }
  const rootTest = scriptsOf(packageJsonText)['test'];
  if (typeof rootTest !== 'string' || rootTest.trim() === '') {
    throw new Error('package.json has no `test` script');
  }
  // The whole workspace: a filter (or any other argument that changes the set of packages) in the
  // root test script would make verify:fast run fewer tests than base + spec-1 … spec-N.
  if (!ROOT_TEST_SCRIPT.test(rootTest.trim())) {
    throw new Error(
      `the root \`test\` script must be \`turbo run test\` with at most \`--env-mode=<mode>\` (no filter): ${rootTest}`,
    );
  }

  const jobs = jobsOf(workflowText);
  const unitJobs = jobs.filter((j) => j.id === 'verify-unit');
  if (unitJobs.length !== 1) {
    throw new Error(`expected one job verify-unit, found ${String(unitJobs.length)}`);
  }
  const unitJob = unitJobs[0] as Job;
  const unitCommands = trustedCommandsOf(unitJob, null).filter((c) => TURBO_TEST.test(c));
  if (unitCommands.length !== 1) {
    throw new Error(
      `the job verify-unit must have exactly one turbo test command, found ${String(unitCommands.length)}`,
    );
  }
  const unit = unitCommands[0] ?? '';
  const prefix = `pnpm exec ${rootTest.trim()} `;
  const filter = unit.startsWith(prefix) ? UNIT_FILTER.exec(unit.slice(prefix.length)) : null;
  if (filter === null) {
    throw new Error(
      `the verify-unit command must be \`${prefix}--filter='!<package>'\` and nothing more: ${unit}`,
    );
  }
  const specPackage = filter[2] ?? '';

  const numbered = new Map<number, string>();
  let n: number | null = null;
  for (const job of jobs) {
    const m = SPEC_JOB.exec(job.id);
    if (!m) continue;
    const index = Number(m[1]);
    if (numbered.has(index)) throw new Error(`job ${job.id} appears twice`);
    const own = trustedCommandsOf(job, index).filter((c) => PACKAGE_TEST.test(c));
    if (own.length !== 1) {
      throw new Error(
        `job ${job.id} must have exactly one shard command, found ${String(own.length)}`,
      );
    }
    const command = own[0] ?? '';
    const shard = SPEC_COMMAND.exec(command);
    if (!shard) {
      throw new Error(
        `job ${job.id}: not \`pnpm --filter <package> run test --shard=<i>/<N>\`: ${command}`,
      );
    }
    if (shard[1] !== specPackage) {
      throw new Error(
        `job ${job.id} runs ${String(shard[1])}, verify-unit leaves out ${specPackage}`,
      );
    }
    const i = Number(shard[2]);
    const total = Number(shard[3]);
    if (i !== index) throw new Error(`job ${job.id} runs shard ${String(i)}, not ${String(index)}`);
    if (n === null) n = total;
    else if (total !== n) throw new Error(`shard counts differ: ${String(n)} and ${String(total)}`);
    numbered.set(index, command);
  }
  if (n === null || numbered.size === 0) throw new Error('no verify-spec-<i> job');
  if (n < 1) throw new Error(`a shard count of ${String(n)}`);
  for (const i of numbered.keys()) {
    if (i < 1 || i > n) throw new Error(`job verify-spec-${String(i)} is outside 1..${String(n)}`);
  }
  for (let i = 1; i <= n; i++) {
    if (!numbered.has(i)) throw new Error(`shard ${String(i)}/${String(n)} is missing`);
  }

  const parts: FastPart[] = [
    { id: 'base', commands: steps.map((s) => (s === ROOT_TEST_STEP ? unit : s)) },
  ];
  for (let i = 1; i <= n; i++) {
    parts.push({ id: `spec-${String(i)}`, commands: [numbered.get(i) ?? ''] });
  }
  return { n, parts };
}

function main(argv: string[]): number {
  const usage =
    'usage: fast-parts.ts [--workflow <path>] [--package-json <path>] | --steps [--package-json <path>]';
  let workflow: string | null = null;
  let packageJson: string | null = null;
  let steps = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--steps' && !steps) {
      steps = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value === '' || value.startsWith('--')) throw new Error(usage);
    if (flag === '--workflow' && workflow === null) workflow = value;
    else if (flag === '--package-json' && packageJson === null) packageJson = value;
    else throw new Error(usage);
    i += 1;
  }
  if (steps && workflow !== null) throw new Error(usage);
  const pkgPath = packageJson ?? resolve(import.meta.dirname, '../../package.json');
  const pkgText = readFileSync(pkgPath, 'utf8');
  let out: unknown;
  if (steps) out = { steps: verifyFastSteps(pkgText) };
  else {
    const path = workflow ?? resolve(import.meta.dirname, '../../.github/workflows/ci.yml');
    out = readFastParts(readFileSync(path, 'utf8'), pkgText);
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`fast-parts: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
  }
}
