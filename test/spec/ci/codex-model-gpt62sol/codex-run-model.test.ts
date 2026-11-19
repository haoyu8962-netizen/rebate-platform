// CT-06zzzzzs (D10-2134): tools/agent/codex-run.sh runs Codex (review and implementation share
// the one MODEL of the codex engine branch) on gpt-6.2-sol. Only that assignment is pinned, read
// from the source text; the script is not run. The independent Claude branch keeps its model.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { CLAUDE_INDEPENDENT_MODEL, CODEX_MODEL, CODEX_RUN } from './kit.ts';

/** The body of the `<label>)` branch of the `case "${AGENT_ENGINE:-}" in … esac` engine switch. */
function engineBranch(src: string, branch: string): string {
  const start = src.indexOf('case "${AGENT_ENGINE:-}" in');
  expect(start, 'codex-run.sh switches on AGENT_ENGINE').toBeGreaterThanOrEqual(0);
  const rest = src.slice(start);
  const end = rest.search(/^\s*esac\b/m);
  expect(end, 'the AGENT_ENGINE switch ends with esac').toBeGreaterThan(0);
  const body = rest.slice(0, end);
  const lines = body.split('\n');
  const open = lines.findIndex((l) => l.trim() === `${branch})`);
  expect(open, `the AGENT_ENGINE switch has a "${branch})" branch`).toBeGreaterThan(0);
  const close = lines.findIndex((l, i) => i > open && l.trim() === ';;');
  expect(close, `the "${branch})" branch ends with ;;`).toBeGreaterThan(open);
  return lines.slice(open + 1, close).join('\n');
}

/** The values assigned to MODEL in a branch body, quotes removed. */
function modelAssignments(body: string): string[] {
  return [...body.matchAll(/^\s*MODEL=(\S+)\s*$/gm)].map((m) =>
    (m[1] ?? '').replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1'),
  );
}

it('[AC-CT-06zzzzzs#6] codex-run.sh: the codex engine branch sets MODEL to gpt-6.2-sol (one assignment); the claude-independent branch keeps claude-opus-5-5', () => {
  const src = readFileSync(CODEX_RUN, 'utf8');
  expect(modelAssignments(engineBranch(src, 'codex'))).toEqual([CODEX_MODEL]);
  expect(modelAssignments(engineBranch(src, 'claude-independent'))).toEqual([
    CLAUDE_INDEPENDENT_MODEL,
  ]);
});
