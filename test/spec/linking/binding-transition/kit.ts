// B1-06zm rule-test fixture: linking's union_bindings.status writers judge every change through the
// generated union-binding transition() (CT-10a, specs/state-machines/union-binding.yaml U1–U10;
// approvals #26 superseded once CT-10 merged). BR-ID-19 / BR-ID-20 / BR-ID-21; 04 §4.4.
//
// How the tests see the single entry: each test file mocks '@couli/domain' with every export kept
// as is except transitionUnionBinding, which becomes a recorded gate over the real one
// (gatedTransition). The gate can refuse chosen (from, event) pairs that the real table allows, or
// replace the whole table with a substitute one. A writer whose decision comes from the generated
// transition() follows the gate; a writer with its own table does not.
//
// This file imports nothing at run time from '@couli/domain' (types only), so the test files may
// load it inside their vi.mock factory.
import { readFileSync } from 'node:fs';
import type {
  UnionBindingEvent,
  UnionBindingState,
  UnionBindingTransitionResult,
} from '@couli/domain';

export const ROOT = new URL('../../../../', import.meta.url);

const LINKING = 'apps/api/src/modules/linking/';

/** The hand-written table that CT-10a's compat test still imports (signature frozen). */
export const TRANSITIONS_FILE = `${LINKING}domain/binding-status-transitions.ts`;

/** The six places that carried「换用生成的 transition() — blocked on CT-10」(编排补充「现状」). */
export const CT10_TODO_FILES: readonly string[] = [
  TRANSITIONS_FILE,
  `${LINKING}application/union-bindings.ts`,
  `${LINKING}application/binding-risk.ts`,
  `${LINKING}application/admin-union-bindings.ts`,
  `${LINKING}application/deletion-cleanup.ts`,
  `${LINKING}application/merge-release.ts`,
];

export function source(path: string): string {
  return readFileSync(new URL(path, ROOT), 'utf8');
}

/** Source text without block comments and whole-line `//` comments. */
export function code(path: string): string {
  return source(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

// Independent expectations (04 §4.4 enum; BR-ID-19 / 20 / 21): six stored values, no cooling.
export const STATES = [
  'unbound',
  'pending_auth',
  'active',
  'invalid',
  'released',
  'blocked',
] as const;

export const FROMS: readonly (UnionBindingState | null)[] = [null, ...STATES];

/** Each event enters exactly one status; nothing enters unbound or pending_auth (BR-ID-19 细则). */
export const TARGET: Readonly<Record<UnionBindingEvent, UnionBindingState>> = {
  ACTIVATE: 'active',
  INVALIDATE: 'invalid',
  BLOCK: 'blocked',
  RELEASE: 'released',
};

export const EVENT_INTO: Readonly<Partial<Record<string, UnionBindingEvent>>> = {
  active: 'ACTIVATE',
  invalid: 'INVALIDATE',
  blocked: 'BLOCK',
  released: 'RELEASE',
};

export function edge(from: string | null, event: string): string {
  return `${String(from)}→${event}`;
}

export interface Gate {
  /** Pairs refused although the real table allows them. */
  readonly deny: Set<string>;
  /** When set, the pairs allowed, all others refused (a substitute table); the real one unused. */
  table: ReadonlySet<string> | null;
}

type Transition = (
  from: UnionBindingState | null,
  event: UnionBindingEvent,
) => UnionBindingTransitionResult;

/** The real transition() behind the gate. */
export function gatedTransition(gate: Gate, real: Transition): Transition {
  return (from, event) => {
    const key = edge(from, event);
    const refused: UnionBindingTransitionResult = { ok: false, reason: 'illegal', id: null };
    if (gate.table !== null) {
      return gate.table.has(key)
        ? { ok: true, to: TARGET[event], id: `substitute ${key}`, noop: false }
        : refused;
    }
    return gate.deny.has(key) ? refused : real(from, event);
  };
}

/** The (from, event) pairs the mocked transition() was asked, as `from→EVENT`. */
export function asked(fn: { readonly mock: { readonly calls: readonly unknown[][] } }): string[] {
  return fn.mock.calls.map(([from, event]) => edge(from as string | null, String(event)));
}
