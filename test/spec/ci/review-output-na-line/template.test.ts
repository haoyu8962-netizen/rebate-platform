// CT-06zzzzzq (D10-2087 ②): the 「Mandatory checklist」 rules of tools/agent/prompts/review-money.md
// say concretely how an `na` item carries no position: file "" and line 0. Only that the rule is
// there (one bullet / paragraph naming `na`, file "", line 0) and that the old instruction to cite
// a line of the change for `na` is gone are pinned, not the wording around them.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { MONEY_PROMPT } from './kit.ts';

/** The rules of the 「Mandatory checklist」 section, before its item table. */
function checklistRules(md: string): string {
  const start = md.indexOf('## Mandatory checklist');
  expect(start, 'review-money.md has a "## Mandatory checklist" section').toBeGreaterThanOrEqual(0);
  const rest = md.slice(start + 1);
  const next = rest.search(/^## /m);
  const section = next < 0 ? rest : rest.slice(0, next);
  const table = section.search(/^\|/m);
  return table < 0 ? section : section.slice(0, table);
}

const LONE_ZERO = /(?<![\w.^−-])0(?![\w.])/;

it('[AC-CT-06zzzzzq#6] review-money.md: an na checklist item leaves file empty ("") and sets line 0', () => {
  const rules = checklistRules(readFileSync(MONEY_PROMPT, 'utf8'));
  const parts = rules.split(/\n(?=\s*- )|\n\s*\n/);
  const naRule = parts.filter(
    (p) =>
      /\bna\b/.test(p) &&
      p.includes('""') &&
      LONE_ZERO.test(p) &&
      /\bfile\b/.test(p) &&
      /\bline\b/.test(p),
  );
  expect(naRule.length, rules).toBeGreaterThan(0);
  // The instruction it replaces (cite a line of the change for na) is gone.
  expect(rules).not.toMatch(/for `na` the line of the change/);
  // Control: ok / issue items still cite a location inside the diff.
  expect(rules).toMatch(/inside the diff/);
});
