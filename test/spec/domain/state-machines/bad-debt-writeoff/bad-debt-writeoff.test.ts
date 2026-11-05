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
} from '../admin-adjustment/kit.ts';

// BR-FUND-12 与细则：每日 R3 后满 ledger.bad_debt_days 且达 ledger.bad_debt_min_fen 生成 PENDING 候选；
// 批准时重读 available 与 frozen：frozen > 0（开关 on）拒绝批准、候选保持 PENDING（不是迁移）；
// available < 0 → APPROVED 并写 BAD_DEBT_WRITEOFF；available ≥ 0 → CANCELLED，不写凭证。
// BD 编号与英文事件名为本任务的技术命名；阈值、锁、记账与风控标记由服务层落实。
const WRITEOFF = {
  name: 'bad-debt-writeoff',
  prefix: 'BAD_DEBT_WRITEOFF',
  functionName: 'transitionBadDebtWriteoff',
  enumName: 'bad_debt_writeoff_status',
  states: ['PENDING', 'APPROVED', 'CANCELLED'],
  events: ['GENERATE', 'APPROVE', 'CANCEL'],
  rows: [
    { id: 'BD1', from: null, event: 'GENERATE', to: 'PENDING' },
    { id: 'BD2', from: 'PENDING', event: 'APPROVE', to: 'APPROVED' },
    { id: 'BD3', from: 'PENDING', event: 'CANCEL', to: 'CANCELLED' },
  ],
} as const satisfies Contract;

it('[AC-B2-12a#33] 核销候选只含契约三态，生成入 PENDING，PENDING 可批准或取消', () => {
  assertDefinition(WRITEOFF);
});

it('[AC-B2-12a#34] 核销候选状态机由 YAML 生成，包入口与生成物一致', () => {
  assertGenerated(WRITEOFF);
});

it.each(WRITEOFF.rows)(
  '[AC-B2-12a#35] $id 接受 $from + $event → $to',
  ({ id, from, event, to }) => {
    for (const entry of ENTRIES) {
      expect(transition(WRITEOFF, entry)(from, event)).toEqual({ ok: true, to, id, noop: false });
    }
  },
);

it.each(illegalPairs(WRITEOFF))(
  '[AC-B2-12a#36] 表外 $from + $event 拒绝（含直接生成已批准、重复批准、已取消后批准）',
  ({ from, event }) => {
    for (const entry of ENTRIES) {
      expect(transition(WRITEOFF, entry)(from, event)).toEqual(ILLEGAL);
    }
  },
);

it('[AC-B2-12a#37] 有冻结金额拒绝批准不是迁移：表里没有回到 PENDING 的行，也没有同态或回退行', () => {
  const rows = machine(WRITEOFF).transitions;
  const backToPending = rows.filter((row) => row.to === 'PENDING' && row.from.includes('PENDING'));
  const fromTerminal = rows.filter((row) => row.from.some((s) => s !== null && s !== 'PENDING'));
  expect(backToPending).toEqual([]);
  expect(rows.filter((row) => row.to === 'same')).toEqual([]);
  expect(fromTerminal).toEqual([]);
});

const GUARDS = [
  {
    id: 'BD1',
    terms: [/R3/, /negative_since/, /ledger\.bad_debt_days/, /ledger\.bad_debt_min_fen/, /PENDING/],
  },
  {
    id: 'BD2',
    terms: [
      /权限/,
      /step-up/,
      /重读/,
      /frozen/,
      /ledger\.bad_debt_require_no_frozen\.enabled/,
      /BAD_DEBT_WRITEOFF/,
      /BADDEBT:/,
      /当前|批准时/,
      /风控/,
      /审计/,
    ],
  },
  { id: 'BD3', terms: [/重读|批准时/, /available/, /≥\s*0|>=\s*0/, /不写.*凭证/] },
];

it.each(GUARDS)(
  '[AC-B2-12a#38] $id 保留阈值、冻结拒批、按当前余额核销或取消的条件',
  ({ id, terms }) => {
    const guard = guardOf(WRITEOFF, id);
    for (const term of terms) expect(guard).toMatch(term);
  },
);

it.each(['REJECT', 'AUTO_APPROVE', 'WRITEOFF', 'REOPEN', 'approve', '', '__proto__'])(
  '[AC-B2-12a#39] 未定义事件 %s 拒绝迁移（核销不得自动执行）',
  (event) => {
    for (const entry of ENTRIES) {
      for (const from of [null, ...WRITEOFF.states]) {
        expect(transition(WRITEOFF, entry)(from, event)).toEqual(ILLEGAL);
      }
    }
  },
);
