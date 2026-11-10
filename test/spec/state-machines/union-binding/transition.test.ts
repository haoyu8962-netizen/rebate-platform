import { expect, it } from 'vitest';
import { ENTRIES, EVENTS, ILLEGAL, LEGAL, STATES, transitionFunction } from './kit.ts';

const legalCases = ENTRIES.flatMap((entry) => LEGAL.map((row) => ({ entry, ...row })));
const illegalCases = ENTRIES.flatMap((entry) => ILLEGAL.map((row) => ({ entry, ...row })));

it.each(legalCases)(
  '[SM-UB-$id] $entry.name：$from + $event → $to，非 noop',
  ({ entry, id, from, event, to }) => {
    expect(transitionFunction(entry.load())(from, event)).toEqual({
      ok: true,
      to,
      id,
      noop: false,
    });
  },
);

// (6 + 1) 起点 × 4 事件 − 13 合法 = 15 个表外组合。
// 含 null 只能 ACTIVATE、blocked + ACTIVATE（恢复与解封只回 invalid）、released + INVALIDATE / BLOCK / RELEASE、
// unbound / pending_auth 的失效与释放，以及各状态进入自身。
it.each(illegalCases)(
  '[CT-10a#7] $entry.name：$from + $event 是表外组合',
  ({ entry, from, event }) => {
    expect(ILLEGAL).toHaveLength(15);
    expect(transitionFunction(entry.load())(from, event)).toEqual({
      ok: false,
      reason: 'illegal',
      id: null,
    });
  },
);

// 不在枚举里的起点或事件（cooling、换绑类事件）同样表外：生成物不得默认放行。
const OUTSIDE = [
  { from: 'cooling', event: 'ACTIVATE' },
  { from: 'cooling', event: 'RELEASE' },
  { from: 'active', event: 'COOL' },
  { from: 'active', event: 'REBIND' },
  { from: 'released', event: 'UNBIND' },
  { from: null, event: 'BIND' },
];
const outsideCases = ENTRIES.flatMap((entry) => OUTSIDE.map((row) => ({ entry, ...row })));

it.each(outsideCases)(
  '[CT-10a#7] $entry.name：枚举外的 $from + $event 是表外组合',
  ({ entry, from, event }) => {
    expect(transitionFunction(entry.load())(from, event)).toEqual({
      ok: false,
      reason: 'illegal',
      id: null,
    });
  },
);

it.each(ENTRIES)('[CT-10a#8] $name：同状态不是迁移，任何事件都不把状态留在原地', (entry) => {
  const transition = transitionFunction(entry.load());
  for (const state of STATES) {
    for (const event of EVENTS) {
      const result = transition(state, event) as { ok?: unknown; to?: unknown; noop?: unknown };
      expect(result.noop === true, `${state} + ${event} 不得 noop`).toBe(false);
      expect(result.ok === true && result.to === state, `${state} + ${event} 不得停在原状态`).toBe(
        false,
      );
    }
  }
});

it.each(ENTRIES)('[CT-10a#9] $name：无行时只有 ACTIVATE 合法，首态只能 active', (entry) => {
  const transition = transitionFunction(entry.load());
  const outcomes = EVENTS.map((event) => [event, transition(null, event)]);
  expect(outcomes).toEqual([
    ['ACTIVATE', { ok: true, to: 'active', id: 'U1', noop: false }],
    ['INVALIDATE', { ok: false, reason: 'illegal', id: null }],
    ['BLOCK', { ok: false, reason: 'illegal', id: null }],
    ['RELEASE', { ok: false, reason: 'illegal', id: null }],
  ]);
});
