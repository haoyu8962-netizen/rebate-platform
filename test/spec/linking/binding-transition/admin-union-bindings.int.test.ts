// B1-06zm: the console's 重置授权 / 停用返利 / 恢复返利 (admin-union-bindings.ts; BR-ID-20, OPS-11,
// owner 2026-10-18) judge every step through the generated union-binding transition(): reset is
// U9 (+ RELEASE), disable U8 (+ BLOCK), enable U7 (blocked + INVALIDATE) and, on a union other than
// Taobao, U4 right after it on the same transaction (invalid + ACTIVATE; no blocked → active edge).
// With the real table the answer and the row are as before; with a step refused by the gate the
// action is refused and neither the binding (row_version included) nor the audit log changes.
// Only the orchestrator runs this file.
import * as domain from '@couli/domain';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  REASON,
  accepted,
  binding,
  current,
  setup,
  snapshot,
} from '../admin-union-bindings/kit.ts';
import { asked, edge } from './kit.ts';

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
const h = useHarness();

beforeEach(() => {
  gate.deny.clear();
  transition.mockClear();
});

afterEach(() => {
  gate.deny.clear();
});

const CASES = [
  {
    action: 'reset',
    platform: 'taobao',
    from: 'active',
    blockedReason: null,
    to: 'released',
    edges: [edge('active', 'RELEASE')],
  },
  {
    action: 'reset',
    platform: 'taobao',
    from: 'invalid',
    blockedReason: null,
    to: 'released',
    edges: [edge('invalid', 'RELEASE')],
  },
  {
    action: 'disable',
    platform: 'taobao',
    from: 'invalid',
    blockedReason: null,
    to: 'blocked',
    edges: [edge('invalid', 'BLOCK')],
  },
  {
    action: 'disable',
    platform: 'pdd',
    from: 'active',
    blockedReason: null,
    to: 'blocked',
    edges: [edge('active', 'BLOCK')],
  },
  {
    action: 'enable',
    platform: 'taobao',
    from: 'blocked',
    blockedReason: 'admin_disable',
    to: 'invalid',
    edges: [edge('blocked', 'INVALIDATE')],
  },
  {
    action: 'enable',
    platform: 'pdd',
    from: 'blocked',
    blockedReason: 'admin_disable',
    to: 'active',
    edges: [edge('blocked', 'INVALIDATE'), edge('invalid', 'ACTIVATE')],
  },
] as const;

it.each(CASES)(
  '[AC-B1-06zm#13] 后台 $action $platform $from → $to：每一步都问生成的 transition()，应答与绑定照旧',
  async ({ action, platform, from, blockedReason, to, edges }) => {
    const s = await setup(h);
    const row = await binding(s, { platform, status: from, blocked_reason: blockedReason });

    const data = await accepted(
      await s.post(action, { reason: REASON, expected_row_version: row.row_version }, { platform }),
    );

    expect(asked(transition)).toEqual(expect.arrayContaining([...edges]));
    expect(data).toMatchObject({ platform, status: to });
    expect(await current(s, row.id)).toMatchObject({
      id: row.id,
      platform,
      status: to,
      blocked_reason: action === 'disable' ? 'admin_disable' : null,
      relation_id: row.relation_id,
      bound_at: row.bound_at,
      reason: REASON,
    });
  },
);

const DENIED = CASES.flatMap((c) => c.edges.map((denied) => ({ ...c, denied })));

it.each(DENIED)(
  '[AC-B1-06zm#14] 后台 $action $platform $from：生成物拒绝 $denied 时操作被拒，绑定与审计都不变（row_version 不变）',
  async ({ action, platform, from, blockedReason, denied }) => {
    const s = await setup(h);
    const row = await binding(s, { platform, status: from, blocked_reason: blockedReason });
    const before = await snapshot(s);
    gate.deny.add(denied);

    const response = await s.post(
      action,
      { reason: REASON, expected_row_version: row.row_version },
      { platform },
    );

    expect(asked(transition)).toContain(denied);
    expect(response.json<{ code: number }>().code).not.toBe(0);
    expect(await snapshot(s)).toEqual(before);
  },
);
