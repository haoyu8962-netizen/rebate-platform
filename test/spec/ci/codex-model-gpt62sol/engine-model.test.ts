// CT-06zzzzzs (D10-2134): tools/ci/evidence-check.ts binds a codex review entry to gpt-6.2-sol;
// entries recorded with gpt-6-astra before the switch are still accepted (transition, to be removed
// by FU-CODEX-MODEL-ASTRA-SUNSET); any other model on a codex entry, and either Codex model on an
// independent Claude entry, is refused; the engine checks are otherwise unchanged. Every evidence
// entry (reviews[] and spec_test_review) goes through engineProblem, so it is called directly.
import { expect, it } from 'vitest';
import { ENGINE_MODELS, engineProblem } from '../../../../tools/ci/evidence-check.ts';
import {
  CLAUDE_INDEPENDENT_MODEL,
  CODEX_ACCEPTED,
  CODEX_MODEL,
  CODEX_MODEL_TRANSITION,
  CODEX_REFUSED,
  NO_MODEL,
  codexEntry,
  entry,
  independentEntry,
  label,
} from './kit.ts';

it('[AC-CT-06zzzzzs#1] a codex review entry naming gpt-6.2-sol passes; ENGINE_MODELS binds codex to gpt-6.2-sol, claude-independent to claude-opus-5-5', () => {
  expect(engineProblem(codexEntry(CODEX_MODEL))).toBeNull();
  expect(ENGINE_MODELS['codex']).toBe(CODEX_MODEL);
  expect(ENGINE_MODELS['claude-independent']).toBe(CLAUDE_INDEPENDENT_MODEL);
});

it('[AC-CT-06zzzzzs#2] transition: a codex entry naming gpt-6-astra (recorded before the switch) still passes, alongside gpt-6.2-sol', () => {
  for (const model of CODEX_ACCEPTED) {
    expect(engineProblem(codexEntry(model)), `codex entry with model ${label(model)}`).toBeNull();
  }
  expect(CODEX_ACCEPTED).toContain(CODEX_MODEL_TRANSITION);
});

it('[AC-CT-06zzzzzs#3] a codex entry naming any other model, or none, is refused, and the problem names gpt-6.2-sol', () => {
  for (const model of [...CODEX_REFUSED, NO_MODEL]) {
    const problem = engineProblem(codexEntry(model));
    expect(problem, `codex entry with model ${label(model)} must be refused`).not.toBeNull();
    expect(problem, `codex entry with model ${label(model)}`).toContain(CODEX_MODEL);
  }
});

it('[AC-CT-06zzzzzs#4] the Codex model names stay codex-only: a claude-independent entry naming gpt-6.2-sol or gpt-6-astra is refused, claude-opus-5-5 still passes', () => {
  for (const model of CODEX_ACCEPTED) {
    // The same name passes on a codex entry ...
    expect(engineProblem(codexEntry(model)), `codex entry with model ${label(model)}`).toBeNull();
    // ... and is refused on an independent Claude entry.
    const problem = engineProblem(independentEntry(model));
    expect(
      problem,
      `claude-independent entry with model ${label(model)} must be refused`,
    ).not.toBeNull();
    expect(problem).toContain(CLAUDE_INDEPENDENT_MODEL);
  }
  expect(engineProblem(independentEntry(CLAUDE_INDEPENDENT_MODEL))).toBeNull();
  for (const model of ['', 'gpt-6.2 sol', 'claude-opus-5', null, NO_MODEL]) {
    expect(
      engineProblem(independentEntry(model)),
      `claude-independent entry with model ${label(model)} must be refused`,
    ).not.toBeNull();
  }
});

it('[AC-CT-06zzzzzs#5] the engine checks are otherwise unchanged: with gpt-6.2-sol a codex entry still needs engine equal to reviewer', () => {
  // Control: the entry passes as it stands, so each refusal below comes from the engine field.
  expect(engineProblem(codexEntry(CODEX_MODEL))).toBeNull();
  for (const model of CODEX_ACCEPTED) {
    const noEngine = codexEntry(model);
    delete noEngine['engine'];
    expect(engineProblem(noEngine)).toMatch(/must be "codex"/);
    expect(engineProblem(entry('codex', 'gpt', model))).toMatch(
      /must be one of codex, claude, claude-independent/,
    );
    expect(engineProblem(entry('codex', 'claude-independent', model))).toMatch(
      /engine claude-independent does not match reviewer "codex"/,
    );
    // An independent Claude review filed under reviewer codex is refused by its engine.
    expect(engineProblem(entry('claude-independent', 'codex', model))).toMatch(
      /engine codex does not match reviewer "claude-independent"/,
    );
  }
  // The orchestrator's Claude subagent: engine claude, no model bound.
  expect(engineProblem({ reviewer: 'claude', engine: 'claude' })).toBeNull();
  expect(engineProblem({ reviewer: 'claude' })).toMatch(/must be "claude"/);
});
