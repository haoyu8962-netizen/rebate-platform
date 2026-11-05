import { expect, it } from 'vitest';
import {
  assertDefinition,
  assertGenerated,
  ENTRIES,
  guardOf,
  ILLEGAL,
  illegalPairs,
  machine,
  transition,
  type Contract,
} from './kit.ts';

// BR-FUND-24 ① 与细则「后台入口」（2026-10-18 定稿 ②）：人工发起的单（含红冲单）一步提交并生效，
// 不再保存待批、不再撤回；PENDING 只剩系统预填的 ACCOUNT_CLOSED 单（⑧），批准或驳回（须填原因）。
// CANCELLED 照契约保留在状态集合里，但没有任何迁移写它（D10-590 ⑨）。
// AA 编号与英文事件名为本任务的技术命名；权限、step-up、重读余额、记账与审计由服务层落实。
const ADJUSTMENT = {
  name: 'admin-adjustment',
  prefix: 'ADMIN_ADJUSTMENT',
  functionName: 'transitionAdminAdjustment',
  enumName: 'admin_adjustment_status',
  states: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'],
  events: ['PREFILL', 'SUBMIT', 'APPROVE', 'REJECT'],
  rows: [
    { id: 'AA1', from: null, event: 'PREFILL', to: 'PENDING' },
    { id: 'AA2', from: null, event: 'SUBMIT', to: 'APPROVED' },
    { id: 'AA3', from: 'PENDING', event: 'APPROVE', to: 'APPROVED' },
    { id: 'AA4', from: 'PENDING', event: 'REJECT', to: 'REJECTED' },
  ],
} as const satisfies Contract;

it('[AC-B2-12a#26] 调账单只含契约四态，系统预填入 PENDING、人工单一步 APPROVED、PENDING 可批准或驳回', () => {
  assertDefinition(ADJUSTMENT);
});

it('[AC-B2-12a#27] 调账单状态机由 YAML 生成，包入口与生成物一致', () => {
  assertGenerated(ADJUSTMENT);
});

it.each(ADJUSTMENT.rows)(
  '[AC-B2-12a#28] $id 接受 $from + $event → $to',
  ({ id, from, event, to }) => {
    for (const entry of ENTRIES) {
      expect(transition(ADJUSTMENT, entry)(from, event)).toEqual({ ok: true, to, id, noop: false });
    }
  },
);

it.each(illegalPairs(ADJUSTMENT))(
  '[AC-B2-12a#29] 表外 $from + $event 拒绝（含人工单进 PENDING、已生效后重批或驳回、终态重开）',
  ({ from, event }) => {
    for (const entry of ENTRIES) {
      expect(transition(ADJUSTMENT, entry)(from, event)).toEqual(ILLEGAL);
    }
  },
);

it('[AC-B2-12a#30] CANCELLED 只保留不写：没有迁移进入 CANCELLED，CANCELLED 上任何事件都拒绝', () => {
  const doc = machine(ADJUSTMENT);
  expect(doc.transitions.filter((row) => row.to === 'CANCELLED')).toEqual([]);
  expect(doc.transitions.filter((row) => row.from.includes('CANCELLED'))).toEqual([]);
  for (const entry of ENTRIES) {
    for (const event of ADJUSTMENT.events) {
      expect(transition(ADJUSTMENT, entry)('CANCELLED', event)).toEqual(ILLEGAL);
    }
  }
});

const GUARDS = [
  { id: 'AA1', terms: [/ACCOUNT_CLOSED/, /注销/, /processing|处理中/, /available/, /系统/] },
  {
    id: 'AA2',
    terms: [
      /权限/,
      /step-up/,
      /短信/,
      /重读/,
      /同一事务|同事务/,
      /审计/,
      /红冲/,
      /deleting|注销处理中/,
    ],
  },
  { id: 'AA3', terms: [/权限/, /step-up/, /短信/, /重读|当时/, /available/, /审计/] },
  {
    id: 'AA4',
    terms: [/原因/, /不写.*凭证|不记账/, /审计/, /不需.*step-up|无需.*step-up|不要.*step-up/],
  },
];

it.each(GUARDS)(
  '[AC-B2-12a#31] $id 保留权限、step-up、重读余额与驳回原因等条件',
  ({ id, terms }) => {
    const guard = guardOf(ADJUSTMENT, id);
    for (const term of terms) expect(guard).toMatch(term);
  },
);

it.each(['CANCEL', 'WITHDRAW', 'SAVE_DRAFT', 'REVERSE', 'REOPEN', 'approve', '', '__proto__'])(
  '[AC-B2-12a#32] 未定义事件 %s 拒绝迁移（不提供撤回、保存待批或红冲状态）',
  (event) => {
    for (const entry of ENTRIES) {
      for (const from of [null, ...ADJUSTMENT.states]) {
        expect(transition(ADJUSTMENT, entry)(from, event)).toEqual(ILLEGAL);
      }
    }
  },
);
