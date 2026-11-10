// CT-05a: the contracts-artifact job of .github/workflows/contracts.yml, read from the real file.
// On every push to main a read-only job builds the contracts distribution artifact with
// tools/ci/contracts-artifact.ts and uploads it with the pinned actions/upload-artifact; it asks
// for no write permission, uses no secrets and is not part of the required contracts-gate.
// (That check-workflows.ts passes on the whole repository is already asserted in
// check-workflows.test.ts.) The YAML helpers are line-based (no YAML dependency).
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '../..');
const TEXT = readFileSync(join(REPO, '.github/workflows/contracts.yml'), 'utf8');
const LINES = TEXT.split('\n');
const JOB = 'contracts-artifact';
const UPLOAD = 'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2';

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isBlankOrComment(line: string): boolean {
  const t = line.trim();
  return t === '' || t.startsWith('#');
}

/** The lines of job `id` (without its id line), or null when there is no such job. */
function jobBody(id: string): string[] | null {
  const jobsAt = LINES.findIndex((l) => l === 'jobs:');
  if (jobsAt < 0) return null;
  const re = new RegExp(`^ {2}${id.replace(/[-]/g, '\\-')}:\\s*(#.*)?$`);
  const at = LINES.findIndex((l, i) => i > jobsAt && re.test(l));
  if (at < 0) return null;
  const body: string[] = [];
  for (let i = at + 1; i < LINES.length; i++) {
    const line = LINES[i] ?? '';
    if (!isBlankOrComment(line) && indentOf(line) <= 2) break;
    body.push(line);
  }
  return body;
}

function requireJob(id: string): string[] {
  const body = jobBody(id);
  expect(body, `contracts.yml has a job \`${id}\``).not.toBeNull();
  return body ?? [];
}

/** Key `key` at indentation `indent` within `lines`: its inline value and its block lines. */
function entry(
  lines: string[],
  key: string,
  indent: number,
): { inline: string; block: string[] } | null {
  const re = new RegExp(`^ {${String(indent)}}${key.replace(/[-]/g, '\\-')}:(\\s.*)?$`);
  const at = lines.findIndex((l) => re.test(l));
  if (at < 0) return null;
  const line = lines[at] ?? '';
  const inline = line.slice(line.indexOf(':') + 1).trim();
  const block: string[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i] ?? '';
    if (l.trim() !== '' && indentOf(l) <= indent) break;
    block.push(l);
  }
  return { inline, block };
}

/** The job-level value of `key` as one line (block scalars joined), or null. */
function jobValue(id: string, key: string): string | null {
  const e = entry(requireJob(id), key, 4);
  if (e === null) return null;
  const inline = e.inline.replace(/\s+#.*$/, '');
  const parts = /^[|>][-+]?\s*$/.test(inline) ? e.block.map((l) => l.trim()) : [inline];
  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function jobNeeds(id: string): string[] {
  const v = jobValue(id, 'needs');
  if (v === null) return [];
  if (v.startsWith('[')) {
    return v
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [v];
}

/** The steps of a job: each item of its `steps:` list as its lines (the `- ` line first). */
function steps(id: string): string[][] {
  const e = entry(requireJob(id), 'steps', 4);
  expect(e, `${id} has steps`).not.toBeNull();
  const out: string[][] = [];
  for (const line of e?.block ?? []) {
    if (/^ {6}- /.test(line)) out.push([line]);
    else if (out.length > 0) out[out.length - 1]?.push(line);
  }
  return out;
}

const stepText = (s: string[]): string => s.join('\n');

it('[CT-05a#60] contracts.yml has a job contracts-artifact without a name:', () => {
  const body = requireJob(JOB);
  expect(body.length).toBeGreaterThan(0);
  expect(entry(body, 'name', 4)).toBeNull();
});

it("[CT-05a#61] contracts-artifact runs only on a push to main (event_name == 'push' && ref == 'refs/heads/main')", () => {
  const cond = jobValue(JOB, 'if');
  expect(cond).not.toBeNull();
  const c = (cond ?? '').replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  expect(c).toMatch(/github\.event_name\s*==\s*'push'/);
  expect(c).toMatch(/github\.ref\s*==\s*'refs\/heads\/main'/);
  expect(c).toContain('&&');
  expect(c).not.toContain('||');
  expect(c).not.toMatch(/always\(\)|!=/);
});

it('[CT-05a#62] contracts-artifact runs on ubuntu-latest with a timeout', () => {
  expect(jobValue(JOB, 'runs-on')).toBe('ubuntu-latest');
  expect(jobValue(JOB, 'timeout-minutes') ?? '').toMatch(/^[1-9][0-9]*$/);
});

it('[CT-05a#63] no write permission anywhere in contracts.yml; the workflow stays contents: read', () => {
  const code = LINES.filter((l) => !isBlankOrComment(l)).map((l) => l.replace(/\s+#.*$/, ''));
  expect(code.filter((l) => /:\s*write\b/.test(l) || /write-all/.test(l))).toEqual([]);
  const perms = entry(LINES, 'permissions', 0);
  expect(perms).not.toBeNull();
  expect((perms?.block ?? []).map((l) => l.trim()).filter(Boolean)).toEqual(['contents: read']);
  // The job does not declare permissions of its own (it inherits contents: read).
  const own = entry(requireJob(JOB), 'permissions', 4);
  if (own !== null) {
    expect([own.inline, ...own.block].join('\n')).not.toMatch(/write/);
  }
});

it('[CT-05a#64] contracts-artifact uses no secrets', () => {
  expect(requireJob(JOB).join('\n')).not.toMatch(/secrets/i);
  expect(requireJob(JOB).join('\n')).not.toMatch(/GITHUB_TOKEN|github\.token/);
});

it('[CT-05a#65] steps: pinned checkout without persisted credentials, then the artifact script, then the pinned upload', () => {
  const all = steps(JOB);
  const checkoutAt = all.findIndex((s) => /uses:\s*actions\/checkout@/.test(stepText(s)));
  const buildAt = all.findIndex((s) => stepText(s).includes('tools/ci/contracts-artifact.ts'));
  const uploadAt = all.findIndex((s) => stepText(s).includes('actions/upload-artifact@'));
  expect(checkoutAt).toBeGreaterThanOrEqual(0);
  expect(buildAt).toBeGreaterThan(checkoutAt);
  expect(uploadAt).toBeGreaterThan(buildAt);

  const checkout = stepText(all[checkoutAt] ?? []);
  expect(checkout).toMatch(/uses:\s*actions\/checkout@[0-9a-f]{40} # v\S+/);
  expect(checkout).toMatch(/persist-credentials:\s*false/);

  const build = stepText(all[buildAt] ?? []);
  expect(build).toMatch(/run:/);
  expect(build).toMatch(/node tools\/ci\/contracts-artifact\.ts[\s\S]*--commit/);
  expect(build).toMatch(/--out/);
  expect(build).toMatch(/GITHUB_SHA|github\.sha/);

  const upload = stepText(all[uploadAt] ?? []);
  expect(upload).toContain(`uses: ${UPLOAD}`);
  const name = upload.split('\n').find((l) => /^\s+name:/.test(l) && indentOf(l) > 8);
  expect(name, 'upload step has with.name').toBeDefined();
  expect(name ?? '').toMatch(/github\.sha/);
  expect(upload).toMatch(/\n\s+path:\s*\S/);
  // Every action in the job is pinned to a full commit SHA.
  for (const s of all) {
    const uses = /uses:\s*(\S+)/.exec(stepText(s));
    if (uses) expect(uses[1] ?? '', stepText(s)).toMatch(/@[0-9a-f]{40}$/);
  }
});

it('[CT-05a#66] contracts-artifact does not soften failures (no continue-on-error)', () => {
  expect(requireJob(JOB).join('\n')).not.toMatch(/continue-on-error/);
});

it('[CT-05a#67] contracts-gate does not need contracts-artifact; its needs are unchanged', () => {
  expect(jobNeeds('contracts-gate')).toEqual(['contracts-detect', 'contracts-check']);
  expect(jobNeeds('contracts-gate')).not.toContain(JOB);
});

it('[CT-05a#68] contracts-artifact is not a required status check', () => {
  const protection = readFileSync(join(REPO, 'ops/branch-protection.json'), 'utf8');
  expect(protection).not.toContain(JOB);
  expect(protection).toContain('"contracts-gate"');
});

it('[CT-05a#69] the triggers stay pull_request and push to main', () => {
  const on = entry(LINES, 'on', 0);
  expect(on).not.toBeNull();
  const block = (on?.block ?? []).map((l) => l.trimEnd()).filter((l) => l.trim() !== '');
  expect(block).toEqual(['  pull_request:', '  push:', '    branches: [main]']);
});
