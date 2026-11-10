import * as domain from '@couli/domain';
import { expect } from 'vitest';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';
import { generatedExports, readRequired, type Machine } from '../order/kit.ts';

export { readRequired, repoFile } from '../order/kit.ts';

export const SOURCE = 'specs/state-machines/union-binding.yaml';
export const GENERATED = 'packages/domain/src/state-machines/union-binding.gen.ts';
export const FN = 'transitionUnionBinding';

// 独立预期：04 §4.4 枚举行与 BR-ID-19 / 20 / 21 正文与细则，CT-10a 编排补充的边表。
// 不从待测 YAML 或生成表反推任何期望。
// 状态顺序同 04 §4.4 与 0018 CHECK；不设 cooling（冷却用 released + cooldown_until）。
export const STATES = [
  'unbound',
  'pending_auth',
  'active',
  'invalid',
  'released',
  'blocked',
] as const;

// 事件按目标状态命名：每个事件只进入一个状态，原因（blocked_reason、重置授权、巡检、解封、恢复返利）不拆事件，
// 由 guard 文字与调用方写入的列表达。这样 canTransitionBinding(from, to) 恰好等价于 transition(from, 进入 to 的事件).ok。
export const EVENTS = ['ACTIVATE', 'INVALIDATE', 'BLOCK', 'RELEASE'] as const;

export type BindingState = (typeof STATES)[number];
export type BindingEvent = (typeof EVENTS)[number];

export const EVENT_TARGET: Readonly<Record<BindingEvent, BindingState>> = {
  ACTIVATE: 'active',
  INVALIDATE: 'invalid',
  BLOCK: 'blocked',
  RELEASE: 'released',
};

export interface LegalRow {
  id: string;
  from: readonly (BindingState | null)[];
  event: BindingEvent;
  to: BindingState;
  // guard 文字须引用的 08 规则编号（每条迁移能对到原文）。
  refs: readonly string[];
}

// YAML 行（共 10 行）：
// U1 无行 → active：用户授权直接写 active（pending_auth 不产生；冷却结束后新建行，BR-ID-19）
// U2 unbound → active：0018 CHECK 允许的投影值，现写者不产生，显式保留（BR-ID-19 细则「unbound 不落库」）
// U3 pending_auth → active：保留值，不产生（BR-ID-19 细则「pending_auth 不产生」）
// U4 invalid → active：同 relation_id 重新授权（BR-ID-21）；其他联盟恢复返利 / 解封第二步（BR-ID-20）
// U5 released → active：冷却期内本人原行恢复（BR-ID-19）
// U6 active → invalid：巡检失效（BR-ID-21）
// U7 blocked → invalid：ban 解封、admin_disable 恢复返利（BR-ID-20；解封见 BR-ID-31）
// U8 pending_auth / active / invalid → blocked：ban、admin_disable、deletion（BR-ID-20）
// U9 active / invalid → released：后台重置授权（BR-ID-20）
// U10 blocked → released：blocked_reason=deletion 满 180 天的每日释放任务（BR-ID-20）
export const ROWS: readonly LegalRow[] = [
  { id: 'U1', from: [null], event: 'ACTIVATE', to: 'active', refs: ['BR-ID-19'] },
  { id: 'U2', from: ['unbound'], event: 'ACTIVATE', to: 'active', refs: ['BR-ID-19'] },
  { id: 'U3', from: ['pending_auth'], event: 'ACTIVATE', to: 'active', refs: ['BR-ID-19'] },
  { id: 'U4', from: ['invalid'], event: 'ACTIVATE', to: 'active', refs: ['BR-ID-21', 'BR-ID-20'] },
  { id: 'U5', from: ['released'], event: 'ACTIVATE', to: 'active', refs: ['BR-ID-19'] },
  { id: 'U6', from: ['active'], event: 'INVALIDATE', to: 'invalid', refs: ['BR-ID-21'] },
  {
    id: 'U7',
    from: ['blocked'],
    event: 'INVALIDATE',
    to: 'invalid',
    refs: ['BR-ID-20', 'BR-ID-31'],
  },
  {
    id: 'U8',
    from: ['pending_auth', 'active', 'invalid'],
    event: 'BLOCK',
    to: 'blocked',
    refs: ['BR-ID-20'],
  },
  { id: 'U9', from: ['active', 'invalid'], event: 'RELEASE', to: 'released', refs: ['BR-ID-20'] },
  { id: 'U10', from: ['blocked'], event: 'RELEASE', to: 'released', refs: ['BR-ID-20'] },
];

export interface LegalCase {
  id: string;
  from: BindingState | null;
  event: BindingEvent;
  to: BindingState;
}

// 按起点展开：13 个合法组合。
export const LEGAL: readonly LegalCase[] = ROWS.flatMap((row) =>
  row.from.map((from) => ({ id: row.id, from, event: row.event, to: row.to })),
);

export const FROMS: readonly (BindingState | null)[] = [null, ...STATES];

// (6 + 1) 起点 × 4 事件 − 13 合法 = 15 个表外组合。
export interface IllegalCase {
  from: BindingState | null;
  event: BindingEvent;
}

export const ILLEGAL: readonly IllegalCase[] = FROMS.flatMap((from) =>
  EVENTS.filter((event) => !LEGAL.some((row) => row.from === from && row.event === event)).map(
    (event) => ({ from, event }),
  ),
);

// 现行唯一入口 apps/api/src/modules/linking/domain/binding-status-transitions.ts 的边（编排补充逐条抄录，
// 独立于生成物与该文件本身）。
export const EDGES: readonly string[] = [
  'null→active',
  'unbound→active',
  'pending_auth→active',
  'pending_auth→blocked',
  'active→invalid',
  'active→blocked',
  'active→released',
  'invalid→active',
  'invalid→blocked',
  'invalid→released',
  'blocked→invalid',
  'blocked→released',
  'released→active',
];

export function edge(from: string | null, to: string): string {
  return `${String(from)}→${to}`;
}

export function yamlText(): string {
  return readRequired(SOURCE);
}

export function machine(): Machine {
  const parsed = parseYamlLite(yamlText());
  expect(parsed).toMatchObject({
    name: 'union-binding',
    field: 'status',
    states: expect.any(Array),
    events: expect.any(Array),
    transitions: expect.any(Array),
  });
  return parsed as Machine;
}

export function publicExports(): Record<string, unknown> {
  return domain;
}

export type TransitionFn = (from: string | null, event: string) => unknown;

export function transitionFunction(exports: Record<string, unknown>): TransitionFn {
  const fn = exports[FN];
  // 缺失导出先断言，避免模块加载错误或 TypeError 被误认作先红。
  expect(fn).toEqual(expect.any(Function));
  return fn as TransitionFn;
}

export const ENTRIES = [
  { name: '包入口', load: publicExports },
  { name: '生成物', load: () => generatedExports(readRequired(GENERATED)) },
];

// 用 transition 遍历全部起点 × 事件，得到实际可达的边（from→to）。
export function reachableEdges(transition: TransitionFn): Set<string> {
  const out = new Set<string>();
  for (const from of FROMS) {
    for (const event of EVENTS) {
      const result = transition(from, event);
      expect(result).toEqual(expect.objectContaining({ ok: expect.any(Boolean) }));
      const outcome = result as { ok: boolean; to?: unknown };
      if (outcome.ok) {
        expect(outcome.to).toEqual(expect.any(String));
        out.add(edge(from, String(outcome.to)));
      }
    }
  }
  return out;
}
