// CT-06zzzzzs (FU-CODEX-MODEL-GPT62SOL, D10-2134): helpers for the rule tests of the Codex model
// switch to gpt-6.2-sol. The owner said, 2026-11-19 before 18:22: 「Codex 对抗评审模型请修改为
// gpt-6.2 sol」. evidence-check is reached only through its exported engineProblem / ENGINE_MODELS
// with in-memory entries; codex-run.sh and ops/approvals.yaml are read as text (no process, no
// database, no codex call). No new export name of the implementation is required: the transition
// constant (gpt-6-astra still accepted until FU-CODEX-MODEL-ASTRA-SUNSET) is the implementer's to
// name; only its effect on engineProblem is pinned.
import { join } from 'node:path';

export const REPO = join(import.meta.dirname, '..', '..', '..', '..');
export const CODEX_RUN = join(REPO, 'tools', 'agent', 'codex-run.sh');
export const APPROVALS = join(REPO, 'ops', 'approvals.yaml');

/** The model Codex runs from now on (codex-run.sh MODEL, ENGINE_MODELS.codex). */
export const CODEX_MODEL = 'gpt-6.2-sol';
/** The model before the switch: codex entries recorded with it are still accepted (transition). */
export const CODEX_MODEL_TRANSITION = 'gpt-6-astra';
/** The model of the independent Claude engine: unchanged. */
export const CLAUDE_INDEPENDENT_MODEL = 'claude-opus-5-5';

/** Every model name a codex entry may carry during the transition, the new one first. */
export const CODEX_ACCEPTED = [CODEX_MODEL, CODEX_MODEL_TRANSITION] as const;

/**
 * Model values a codex entry must not carry: other engines' models, empty, spacing / case /
 * suffix / separator variants of either Codex name, and non-string values (a one-element array
 * would stringify to the accepted name).
 */
export const CODEX_REFUSED: readonly unknown[] = [
  CLAUDE_INDEPENDENT_MODEL,
  '',
  'gpt-6.2 sol',
  'GPT-6.2-SOL',
  'Gpt-6.2-Sol',
  'gpt-6.2-sol-mini',
  'gpt-6.2-SOL',
  ' gpt-6.2-sol',
  'gpt-6.2-sol ',
  'gpt-6.2_sol',
  'gpt-6.2sol',
  'gpt-6.2',
  'gpt-6-sol',
  'gpt-6.2-astra',
  'gpt-6-astra-mini',
  'GPT-6-ASTRA',
  'gpt-6 astra',
  ' gpt-6-astra',
  'gpt-6-astra ',
  'gpt-6.2-sol,gpt-6-astra',
  null,
  0,
  true,
  [CODEX_MODEL],
  [CODEX_MODEL_TRANSITION],
  { model: CODEX_MODEL },
];

/** Marks "no model key at all" in the entry builders. */
export const NO_MODEL: unique symbol = Symbol('no model');

/** An evidence review entry; `model` is left out when NO_MODEL is given. */
export function entry(reviewer: string, engine: string, model: unknown): Record<string, unknown> {
  const e: Record<string, unknown> = {
    reviewer,
    engine,
    verdict: 'pass',
    open_s0_s1: 0,
    checklist_complete: true,
  };
  if (model !== NO_MODEL) e['model'] = model;
  return e;
}

/** A codex review entry naming `model`. */
export function codexEntry(model: unknown): Record<string, unknown> {
  return entry('codex', 'codex', model);
}

/** An independent Claude review entry naming `model`. */
export function independentEntry(model: unknown): Record<string, unknown> {
  return entry('claude-independent', 'claude-independent', model);
}

/** A readable label of a model value for assertion messages. */
export function label(model: unknown): string {
  return model === NO_MODEL ? '(no model key)' : JSON.stringify(model);
}
