import { expect, it } from 'vitest';
import { canTransitionBinding } from '../../../../apps/api/src/modules/linking/domain/binding-status-transitions.ts';
import {
  EDGES,
  ENTRIES,
  EVENTS,
  EVENT_TARGET,
  FROMS,
  STATES,
  edge,
  reachableEdges,
  transitionFunction,
} from './kit.ts';

// 编排补充第 4 点：生成物的边集合与现行唯一入口 canTransitionBinding 全组合逐一相等，
// 保证 B1-06zm 换用生成的 transition() 后行为不变。(6 + 1) 起点 × 6 目标 = 42 个组合，逐个对照。
const PAIRS = FROMS.flatMap((from) => STATES.map((to) => ({ from, to })));
const pairCases = ENTRIES.flatMap((entry) => PAIRS.map((pair) => ({ entry, ...pair })));

it.each(pairCases)(
  '[CT-10a#10] $entry.name：$from → $to 与 canTransitionBinding 及独立边表一致',
  ({ entry, from, to }) => {
    const transition = transitionFunction(entry.load());
    const reached = reachableEdges(transition);
    const expected = EDGES.includes(edge(from, to));
    expect(PAIRS).toHaveLength(42);
    expect(reached.has(edge(from, to)), `生成物 ${edge(from, to)}`).toBe(expected);
    expect(canTransitionBinding(from, to), `canTransitionBinding ${edge(from, to)}`).toBe(expected);
  },
);

it.each(ENTRIES)('[CT-10a#10] $name：可达边集合恰为现行 13 条边，不多不少', (entry) => {
  const reached = reachableEdges(transitionFunction(entry.load()));
  expect([...reached].sort()).toEqual([...EDGES].sort());
  for (const from of FROMS) {
    for (const to of STATES) {
      expect(canTransitionBinding(from, to), edge(from, to)).toBe(reached.has(edge(from, to)));
    }
  }
});

it.each(ENTRIES)(
  '[CT-10a#11] $name：canTransitionBinding(from, to) 等价于 transition(from, 进入 to 的事件).ok',
  (entry) => {
    const transition = transitionFunction(entry.load());
    for (const from of FROMS) {
      for (const event of EVENTS) {
        const result = transition(from, event) as { ok?: unknown; to?: unknown };
        const to = EVENT_TARGET[event];
        expect(result.ok === true, `${String(from)} + ${event}`).toBe(
          canTransitionBinding(from, to),
        );
        if (result.ok === true) expect(result.to, `${String(from)} + ${event}`).toBe(to);
      }
    }
  },
);

// 编排点名的表外组合：blocked → active、released → invalid、released → blocked、active → pending_auth、
// 任何 → unbound、任何 → cooling。
const NAMED = [
  ['blocked', 'active'],
  ['released', 'invalid'],
  ['released', 'blocked'],
  ['active', 'pending_auth'],
  ...FROMS.map((from) => [from, 'unbound'] as const),
  ...FROMS.map((from) => [from, 'cooling'] as const),
] as const;

it.each(ENTRIES)('[CT-10a#12] $name：编排点名的组合一律不可达', (entry) => {
  const reached = reachableEdges(transitionFunction(entry.load()));
  for (const [from, to] of NAMED) {
    expect(reached.has(edge(from, to)), edge(from, to)).toBe(false);
    expect(canTransitionBinding(from, to), edge(from, to)).toBe(false);
  }
});
