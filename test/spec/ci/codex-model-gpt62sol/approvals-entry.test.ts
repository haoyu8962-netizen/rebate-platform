// CT-06zzzzzs (D10-2134, ledger scope ④): ops/approvals.yaml gains an entry that records the
// owner's words 「Codex 对抗评审模型请修改为 gpt-6.2 sol」 and grants the switch of the review model
// to gpt-6.2-sol. Read as text: the entry is the `- id:` block holding those words; its number,
// title wording and the rest of the file are not pinned.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { APPROVALS, CODEX_MODEL } from './kit.ts';

const OWNER_WORDS = 'Codex 对抗评审模型请修改为 gpt-6.2 sol';

/** The `- id: N` entries of ops/approvals.yaml, as text blocks. */
function approvalEntries(yaml: string): string[] {
  return yaml.split(/^(?=\s*- id:\s*\d+\s*$)/m).filter((b) => /^\s*- id:\s*\d+\s*$/m.test(b));
}

it('[AC-CT-06zzzzzs#7] ops/approvals.yaml: a granted entry records the owner words and the switch to gpt-6.2-sol', () => {
  const entries = approvalEntries(readFileSync(APPROVALS, 'utf8'));
  expect(entries.length, 'ops/approvals.yaml lists its entries as "- id: N"').toBeGreaterThan(0);
  const hits = entries.filter((b) => b.includes(OWNER_WORDS));
  expect(hits.length, `entries recording the owner words 「${OWNER_WORDS}」`).toBeGreaterThan(0);
  const granted = hits.filter((b) => b.includes(CODEX_MODEL) && /^\s*granted:\s*true\s*$/m.test(b));
  expect(
    granted.length,
    `a granted entry with the owner words names ${CODEX_MODEL}`,
  ).toBeGreaterThan(0);
});
