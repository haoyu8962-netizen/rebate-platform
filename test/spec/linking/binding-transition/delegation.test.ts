// B1-06zm: canTransitionBinding (CT-10a's compat test imports it; signature unchanged) is decided by
// the generated transitionUnionBinding at every call: from = null is U1's start, `to` is entered
// by exactly one event (TARGET), unbound and pending_auth by none (BR-ID-19 细则). A substitute
// table behind the mocked transition() must show through unchanged.
import * as domain from '@couli/domain';
import { afterEach, expect, it, vi } from 'vitest';
import { canTransitionBinding } from '../../../../apps/api/src/modules/linking/domain/binding-status-transitions.ts';
import { EVENT_INTO, FROMS, STATES, asked, edge } from './kit.ts';

const gate = vi.hoisted(() => ({
  deny: new Set<string>(),
  table: null as ReadonlySet<string> | null,
}));

vi.mock('@couli/domain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@couli/domain')>();
  const { gatedTransition } = await import('./kit.ts');
  return {
    ...actual,
    transitionUnionBinding: vi.fn(gatedTransition(gate, actual.transitionUnionBinding)),
  };
});

const transition = vi.mocked(domain.transitionUnionBinding);

afterEach(() => {
  gate.deny.clear();
  gate.table = null;
  transition.mockClear();
});

const TARGETS = [...STATES, 'cooling'] as const;

// Independent list of today's 13 legal changes (BR-ID-19 / 20 / 21; CT-10a 编排补充的边表).
const LEGAL = [
  [null, 'active'],
  ['unbound', 'active'],
  ['pending_auth', 'active'],
  ['pending_auth', 'blocked'],
  ['active', 'invalid'],
  ['active', 'blocked'],
  ['active', 'released'],
  ['invalid', 'active'],
  ['invalid', 'blocked'],
  ['invalid', 'released'],
  ['blocked', 'invalid'],
  ['blocked', 'released'],
  ['released', 'active'],
] as const;

function legal(from: string | null, to: string): boolean {
  return LEGAL.some(([f, t]) => f === from && t === to);
}

// A table no rule has: blocked straight back to active, released into invalid / blocked, a new row
// straight into blocked, unbound released. Every real edge is absent from it.
const SUBSTITUTE: ReadonlySet<string> = new Set([
  edge('blocked', 'ACTIVATE'),
  edge('released', 'INVALIDATE'),
  edge('released', 'BLOCK'),
  edge(null, 'BLOCK'),
  edge('unbound', 'RELEASE'),
]);

it('[AC-B1-06zm#3] 生成物换成替身表时 canTransitionBinding 跟着替身表走：(6 + 1) 起点 × 全部目标逐一相等，unbound / pending_auth / cooling 一律不可进入', () => {
  gate.table = SUBSTITUTE;
  for (const from of FROMS) {
    for (const to of TARGETS) {
      const event = EVENT_INTO[to];
      const expected = event !== undefined && SUBSTITUTE.has(edge(from, event));
      expect(canTransitionBinding(from, to), `${String(from)} → ${to}`).toBe(expected);
    }
  }
});

it('[AC-B1-06zm#4] 生成物原样时 canTransitionBinding 对每个起点与目标都询问 transitionUnionBinding(from, 进入 to 的事件)，结果与现行 13 条边一致', () => {
  for (const from of FROMS) {
    for (const to of STATES) {
      const event = EVENT_INTO[to];
      transition.mockClear();
      const result = canTransitionBinding(from, to);
      if (event !== undefined) {
        expect(asked(transition), `${String(from)} → ${to}`).toContain(edge(from, event));
      }
      expect(result, `${String(from)} → ${to}`).toBe(legal(from, to));
    }
  }
});

it('[AC-B1-06zm#5] 生成物拒绝一切时 canTransitionBinding 一律 false（含无行 → active，不留手写特例）', () => {
  gate.table = new Set();
  for (const from of FROMS) {
    for (const to of TARGETS) {
      expect(canTransitionBinding(from, to), `${String(from)} → ${to}`).toBe(false);
    }
  }
});

const DENIED = LEGAL.map(([from, to]) => ({ from, to }));

it.each(DENIED)(
  '[AC-B1-06zm#6] 生成物只拒绝 $from → $to 时 canTransitionBinding 只对这一条改判，其余 12 条照旧',
  ({ from: deniedFrom, to: deniedTo }) => {
    gate.deny.add(edge(deniedFrom, EVENT_INTO[deniedTo] ?? ''));
    for (const [from, to] of LEGAL) {
      const denied = from === deniedFrom && to === deniedTo;
      expect(canTransitionBinding(from, to), edge(from, to)).toBe(!denied);
    }
  },
);
