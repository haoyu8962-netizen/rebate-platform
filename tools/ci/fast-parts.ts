// CT-06zzzzzzzb (FU-VERIFY-FAST-PROFILE, D10-2503 / D10-2504): `pnpm run verify:fast` cut into the
// parts CI runs it as, read from .github/workflows/ci.yml and the root package.json themselves (no
// second list), for tools/ops/verify-container.sh --fast-part / --fast and
// tools/ops/verify-sharded-summary.ts.
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
// only when (1) verify:fast has exactly one step `pnpm run test`; (2) the verify-unit command is
// `pnpm exec <root test script>` plus one `--filter='!<P>'` and nothing else; (3) every spec
// command is `pnpm --filter <P> run test --shard=<i>/<N>` with that same <P>, one per i in 1..N,
// one N, the job named after its i. Anything else throws (exit 2 on the command line).
//
// Node built-in modules only; the line-based YAML reading is that of tools/ci/int-shards.ts.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type FastPart = { id: string; commands: string[] };
export type FastParts = { n: number; parts: FastPart[] };

const ROOT_TEST_STEP = 'pnpm run test';
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

/** Removes a trailing ` # comment` and surrounding quotes from a scalar value. */
function scalar(value: string): string {
  const withoutComment = value.replace(/\s+#.*$/, '').trim();
  const single = /^'(.*)'$/.exec(withoutComment);
  if (single) return (single[1] ?? '').replace(/''/g, "'");
  const double = /^"(.*)"$/.exec(withoutComment);
  return double ? (double[1] ?? '') : withoutComment;
}

type Job = { id: string; lines: string[] };

/** The jobs under `jobs:`, in file order (a repeated id stays repeated). */
function jobsOf(text: string): Job[] {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => /^jobs:\s*(#.*)?$/.test(l));
  if (at < 0) throw new Error('the workflow has no top-level `jobs:`');
  const jobs: Job[] = [];
  let current: Job | null = null;
  for (const line of lines.slice(at + 1)) {
    if (isBlankOrComment(line)) continue;
    if (indentOf(line) === 0) break;
    const head = /^ {2}([A-Za-z0-9_-]+):\s*(#.*)?$/.exec(line);
    if (head) {
      current = { id: head[1] ?? '', lines: [] };
      jobs.push(current);
    } else if (current && indentOf(line) > 2) {
      current.lines.push(line);
    }
  }
  return jobs;
}

/**
 * The commands of a job's step `run:` values: the scalar after `run:`, and each line of a
 * `run: |` / `run: >` block. The same text under any other key is not a command.
 */
function runCommands(lines: string[]): string[] {
  const out: string[] = [];
  let block: { column: number; run: boolean } | null = null;
  for (const line of lines) {
    if (isBlankOrComment(line)) continue;
    if (block !== null && indentOf(line) > block.column) {
      if (block.run) out.push(line.trim());
      continue;
    }
    block = null;
    const keyed = /^(\s*(?:-\s+)?)([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(line);
    if (!keyed) continue;
    const column = (keyed[1] ?? '').length;
    const value = (keyed[3] ?? '').replace(/\s+#.*$/, '').trim();
    const isRun = keyed[2] === 'run';
    if (/^[|>][0-9+-]*$/.test(value)) {
      block = { column, run: isRun };
      continue;
    }
    if (isRun) out.push(scalar(value));
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

  const jobs = jobsOf(workflowText);
  const unitJobs = jobs.filter((j) => j.id === 'verify-unit');
  if (unitJobs.length !== 1) {
    throw new Error(`expected one job verify-unit, found ${String(unitJobs.length)}`);
  }
  const unitCommands = runCommands(unitJobs[0]?.lines ?? []).filter((c) => TURBO_TEST.test(c));
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
    const own = runCommands(job.lines).filter((c) => PACKAGE_TEST.test(c));
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
