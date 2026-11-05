import { randomUUID } from 'node:crypto';

import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';

import {
  LATER,
  enumValues,
  harness,
  insert,
  manual,
  otherMember,
  parents,
  prefill,
  ready,
  refs,
  reversal,
  sqlState,
  update,
  voucher,
  type Parents,
  type Row,
} from './kit.ts';

const h = harness(createTestDatabase);

// 每张生效单各配一张新凭证：本单不规定凭证是否可被多张调账单共用。
async function approved(p: Parents, values: Row = {}): Promise<Row> {
  return manual(p, await voucher(h.app, p), values);
}

async function attempt(row: Row): Promise<string> {
  return sqlState(insert(h.app, 'admin_adjustments', row));
}

async function approval(p: Parents): Promise<Row> {
  return {
    status: 'APPROVED',
    amount_fen: 2000n,
    voucher_id: await voucher(h.app, p),
    reviewed_by: p.adminId,
    reviewed_at: LATER,
  };
}

it('[AC-B2-12a#5] 人工一步生效单、系统预填单、被驳回的预填单与红冲单都能按契约形状写入', async () => {
  await ready(h.app);
  const p = await parents(h.app);
  const original = await approved(p);
  expect(await attempt(original)).toBe('ok');
  expect(await attempt(prefill(p))).toBe('ok');
  const other = await otherMember(h.app, p);
  expect(
    await attempt(
      prefill(p, { user_id: other.userId, status: 'REJECTED', reject_note: '余额已核对' }),
    ),
  ).toBe('ok');
  const key = `ADJ:${String(original['adjust_id'])}:REVERSE`;
  const reverse = reversal(p, original, await voucher(h.app, p, key));
  expect(await attempt(reverse)).toBe('ok');
  const stored = await sql<Row>`
    SELECT adjust_id, direction, amount_fen, refs, reverses_adjust_id, created_by
    FROM app.admin_adjustments WHERE app_id = ${p.appId} AND adjust_id = ${reverse['adjust_id']}
  `.execute(h.app);
  expect(stored.rows).toEqual([
    {
      adjust_id: reverse['adjust_id'],
      direction: 'decrease',
      amount_fen: 500n,
      refs: [],
      reverses_adjust_id: original['adjust_id'],
      created_by: p.adminId,
    },
  ]);
});

it.each(['voucher_id', 'amount_fen', 'reviewed_by', 'reviewed_at'])(
  '[AC-B2-12a#6] APPROVED 单缺 %s 被 CHECK 拒绝（已生效必有凭证、金额与批准人）',
  async (column) => {
    await ready(h.app);
    const p = await parents(h.app);
    expect(await attempt(await approved(p, { [column]: null }))).toBe('23514');
    const pending = prefill(p);
    await insert(h.app, 'admin_adjustments', pending);
    const change: Row = { ...(await approval(p)), [column]: null };
    expect(
      await sqlState(
        update(h.app, 'admin_adjustments', { adjust_id: pending['adjust_id'] }, change),
      ),
    ).toBe('23514');
  },
);

it.each([0n, -1n, -500n])(
  '[AC-B2-12a#7] amount_fen = %s 被拒绝，金额非空时只能 > 0',
  async (amount) => {
    await ready(h.app);
    const p = await parents(h.app);
    expect(await attempt(await approved(p, { amount_fen: amount }))).toBe('23514');
    expect(await attempt(prefill(p, { amount_fen: amount }))).toBe('23514');
  },
);

it.each(['RESTORE', 'RECON_FIX', 'PAYOUT_RECOVERY', 'OTHER'])(
  '[AC-B2-12a#8] %s 单的 amount_fen 不能为空：只有 ACCOUNT_CLOSED 预填单批准前可空',
  async (reason) => {
    await ready(h.app);
    const p = await parents(h.app);
    const row = prefill(p, { reason_code: reason, created_by: p.adminId, direction: 'increase' });
    expect(await attempt(row)).toBe('23514');
  },
);

it('[AC-B2-12a#9] REJECTED 必须带驳回原因', async () => {
  await ready(h.app);
  const p = await parents(h.app);
  expect(await attempt(prefill(p, { status: 'REJECTED' }))).toBe('23514');
  const pending = prefill(p);
  await insert(h.app, 'admin_adjustments', pending);
  const key = { adjust_id: pending['adjust_id'] };
  const reject: Row = { status: 'REJECTED', reviewed_by: p.adminId, reviewed_at: LATER };
  expect(await sqlState(update(h.app, 'admin_adjustments', key, reject))).toBe('23514');
  expect(
    await sqlState(
      update(h.app, 'admin_adjustments', key, { ...reject, reject_note: '注销已撤销' }),
    ),
  ).toBe('ok');
});

it.each(['RESTORE', 'RECON_FIX', 'PAYOUT_RECOVERY', 'OTHER'])(
  '[AC-B2-12a#10] %s 单 created_by 必填：只有系统预填的 ACCOUNT_CLOSED 单发起人可空',
  async (reason) => {
    await ready(h.app);
    const p = await parents(h.app);
    expect(await attempt(await approved(p, { reason_code: reason, created_by: null }))).toBe(
      '23514',
    );
    expect(await attempt(await approved(p, { reason_code: reason }))).toBe('ok');
  },
);

it('[AC-B2-12a#11] contra_platform 非空当且仅当对方科目为 UNION_RECEIVABLE', async () => {
  await ready(h.app);
  const p = await parents(h.app);
  const cases: [Row, string][] = [
    [{ contra_subject: 'UNION_RECEIVABLE', contra_platform: 'taobao' }, 'ok'],
    [{ contra_subject: 'UNION_RECEIVABLE', contra_platform: null }, '23514'],
    [{ contra_subject: 'COMMISSION_REVENUE', contra_platform: 'taobao' }, '23514'],
    [{ contra_subject: 'BAD_DEBT', contra_platform: 'jd' }, '23514'],
    [{ contra_subject: 'MKT_EXPENSE', contra_platform: null }, 'ok'],
  ];
  for (const [values, expected] of cases) {
    expect(await attempt(await approved(p, values)), JSON.stringify(values)).toBe(expected);
  }
});

it('[AC-B2-12a#12] refs 必须是数组且最多 10 张关联单据，超 10 张拒绝；空数组只出现在 OTHER 说明单与红冲单', async () => {
  await ready(h.app);
  const p = await parents(h.app);
  // 空数组：OTHER 以客服处理说明代替关联单据，红冲单以原单为关联、不另填（BR-FUND-24 ②③；契约 AdminAdjustment）。
  const other = await approved(p, {
    reason_code: 'OTHER',
    refs: refs(0),
    note: '客服处理说明：企业微信沟通确认重复入账，核实依据为联盟后台订单截图',
  });
  expect(await attempt(other), 'OTHER 说明单 refs=[]').toBe('ok');
  const original = await approved(p);
  await insert(h.app, 'admin_adjustments', original);
  const key = `ADJ:${String(original['adjust_id'])}:REVERSE`;
  const reverse = reversal(p, original, await voucher(h.app, p, key), { refs: refs(0) });
  expect(await attempt(reverse), '红冲单 refs=[]').toBe('ok');
  // 普通 RECON_FIX 单至少带一张关联单据（BR-FUND-24 ③），这里只测上界与形状。
  const cases: [string, string][] = [
    [refs(1), 'ok'],
    [refs(10), 'ok'],
    [refs(11), '23514'],
    [JSON.stringify({ ref_type: 'recon_diff', ref_id: randomUUID() }), '23514'],
    ['"recon_diff"', '23514'],
  ];
  for (const [value, expected] of cases) {
    expect(await attempt(await approved(p, { refs: value })), value.slice(0, 40)).toBe(expected);
  }
});

it('[AC-B2-12a#13] reason_code、status、direction、contra_subject 只取契约枚举值', async () => {
  await ready(h.app);
  const p = await parents(h.app);
  const reasons = enumValues('admin_adjust_sub_type');
  // D10-590 ⑩：DB CHECK 与枚举同列五个原因码，含 RESTORE。
  expect([...reasons].sort()).toEqual(
    ['ACCOUNT_CLOSED', 'OTHER', 'PAYOUT_RECOVERY', 'RECON_FIX', 'RESTORE'].sort(),
  );
  for (const reason of reasons) {
    const row =
      reason === 'ACCOUNT_CLOSED'
        ? prefill(p, { user_id: (await otherMember(h.app, p)).userId })
        : await approved(p, { reason_code: reason });
    expect(await attempt(row), reason).toBe('ok');
  }
  // CANCELLED 照契约保留在 CHECK 里，状态机不写它（D10-590 ⑨）。
  const byStatus: Record<string, Row> = {
    PENDING: prefill(p, { user_id: (await otherMember(h.app, p)).userId }),
    APPROVED: await approved(p),
    REJECTED: prefill(p, { status: 'REJECTED', reject_note: '驳回' }),
    CANCELLED: manual(p, null, { status: 'CANCELLED', reviewed_by: null, reviewed_at: null }),
  };
  for (const status of enumValues('admin_adjustment_status')) {
    expect(byStatus[status], `未覆盖的状态 ${status}`).toBeDefined();
    expect(await attempt(byStatus[status] ?? {}), status).toBe('ok');
  }
  for (const direction of enumValues('admin_adjustment_direction')) {
    expect(await attempt(await approved(p, { direction })), direction).toBe('ok');
  }
  for (const subject of enumValues('admin_adjustment_contra_subject')) {
    const platform = subject === 'UNION_RECEIVABLE' ? 'taobao' : null;
    const row = await approved(p, { contra_subject: subject, contra_platform: platform });
    expect(await attempt(row), subject).toBe('ok');
  }
  const invalid: Row[] = [
    { reason_code: 'ADMIN_ADJUST' },
    { reason_code: 'recon_fix' },
    { reason_code: '' },
    { status: 'approved' },
    { status: 'REVERSED' },
    { direction: 'INCREASE' },
    { direction: 'credit' },
    { contra_subject: 'USER_BALANCE' },
    { contra_subject: 'commission_revenue' },
  ];
  for (const values of invalid) {
    expect(await attempt(await approved(p, values)), JSON.stringify(values)).toBe('23514');
  }
});

it('[AC-B2-12a#14] 同一用户同时只能有一张 PENDING 的 ACCOUNT_CLOSED 预填单，驳回或生效后可补建', async () => {
  await ready(h.app);
  const p = await parents(h.app);
  const first = prefill(p);
  expect(await attempt(first)).toBe('ok');
  expect(await attempt(prefill(p))).toBe('23505');
  const other = await otherMember(h.app, p);
  expect(await attempt(prefill(p, { user_id: other.userId }))).toBe('ok');
  // D10-590：驳回后注销完成门仍 pending，次一会计日补建一张。
  await update(
    h.app,
    'admin_adjustments',
    { adjust_id: first['adjust_id'] },
    { status: 'REJECTED', reviewed_by: p.adminId, reviewed_at: LATER, reject_note: '复核后驳回' },
  );
  const second = prefill(p);
  expect(await attempt(second)).toBe('ok');
  await update(h.app, 'admin_adjustments', { adjust_id: second['adjust_id'] }, await approval(p));
  expect(await attempt(prefill(p))).toBe('ok');
  // 唯一性只针对 ACCOUNT_CLOSED 的 PENDING：同一用户的其他调账单不受限。
  expect(await attempt(await approved(p))).toBe('ok');
  expect(await attempt(await approved(p))).toBe('ok');
});

it('[AC-B2-12a#15] 一张原调账单只能被红冲一次，红冲单可各自对应不同原单', async () => {
  await ready(h.app);
  const p = await parents(h.app);
  const original = await approved(p);
  const another = await approved(p, { amount_fen: 50n });
  await insert(h.app, 'admin_adjustments', original);
  await insert(h.app, 'admin_adjustments', another);
  expect(await attempt(reversal(p, original, await voucher(h.app, p)))).toBe('ok');
  expect(await attempt(reversal(p, original, await voucher(h.app, p)))).toBe('23505');
  expect(await attempt(reversal(p, another, await voucher(h.app, p)))).toBe('ok');
  const count = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM app.admin_adjustments
    WHERE app_id = ${p.appId} AND reverses_adjust_id = ${original['adjust_id']}
  `.execute(h.app);
  expect(count.rows).toEqual([{ n: '1' }]);
});

it.each(['user_id', 'created_by', 'reviewed_by', 'voucher_id', 'reverses_adjust_id'])(
  '[AC-B2-12a#16] %s 指向别的 app 或不存在的行时被外键拒绝',
  async (column) => {
    await ready(h.app);
    const p = await parents(h.app);
    const foreign = await parents(h.app);
    const foreignVoucher = await voucher(h.app, foreign);
    const foreignOriginal = manual(foreign, foreignVoucher);
    await insert(h.app, 'admin_adjustments', foreignOriginal);
    const foreignIds: Record<string, unknown> = {
      user_id: foreign.userId,
      created_by: foreign.adminId,
      reviewed_by: foreign.adminId,
      voucher_id: foreignVoucher,
      reverses_adjust_id: foreignOriginal['adjust_id'],
    };
    const shape = column === 'reverses_adjust_id' ? { refs: '[]', direction: 'decrease' } : {};
    const base = await approved(p, shape);
    expect(await attempt({ ...base, [column]: foreignIds[column] }), '跨 app').toBe('23503');
    expect(await attempt({ ...base, [column]: randomUUID() }), '不存在').toBe('23503');
  },
);

it('[AC-B2-12a#17] 预填单批准时可回填金额、凭证与批准人，原样读回', async () => {
  await ready(h.app);
  const p = await parents(h.app);
  const pending = prefill(p);
  await insert(h.app, 'admin_adjustments', pending);
  const change: Row = { ...(await approval(p)), amount_fen: 9007199254740993n };
  expect(
    await sqlState(update(h.app, 'admin_adjustments', { adjust_id: pending['adjust_id'] }, change)),
  ).toBe('ok');
  const stored = await sql<Row>`
    SELECT status, amount_fen, voucher_id, reviewed_by, reviewed_at, created_by
    FROM app.admin_adjustments WHERE adjust_id = ${pending['adjust_id']}
  `.execute(h.app);
  expect(stored.rows).toEqual([
    {
      status: 'APPROVED',
      amount_fen: 9007199254740993n,
      voucher_id: change['voucher_id'],
      reviewed_by: p.adminId,
      reviewed_at: new Date(LATER),
      created_by: null,
    },
  ]);
});
