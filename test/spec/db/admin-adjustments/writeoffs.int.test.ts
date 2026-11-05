import { randomUUID } from 'node:crypto';

import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';

import {
  LATER,
  candidate,
  enumValues,
  harness,
  insert,
  otherMember,
  parents,
  ready,
  sqlState,
  update,
  voucher,
  type Parents,
  type Row,
} from './kit.ts';

const h = harness(createTestDatabase);

async function attempt(row: Row): Promise<string> {
  return sqlState(insert(h.app, 'bad_debt_writeoffs', row));
}

async function approval(p: Parents, candidateId: unknown): Promise<Row> {
  const key = `BADDEBT:${p.accountId}:${String(candidateId)}`;
  return {
    status: 'APPROVED',
    approver_id: p.adminId,
    approved_at: LATER,
    voucher_id: await voucher(h.app, p, key),
  };
}

it('[AC-B2-12a#18] 核销候选单 PENDING、APPROVED、CANCELLED 三种形状都能写入并读回', async () => {
  await ready(h.app);
  const p = await parents(h.app);
  const pending = candidate(p);
  expect(await attempt(pending)).toBe('ok');
  const other = await otherMember(h.app, p);
  const done = candidate(p, { account_id: other.accountId, initiator_id: p.adminId });
  expect(await attempt({ ...done, ...(await approval(p, done['id'])) })).toBe('ok');
  const third = await otherMember(h.app, p);
  expect(await attempt(candidate(p, { account_id: third.accountId, status: 'CANCELLED' }))).toBe(
    'ok',
  );
  const stored = await sql<Row>`
    SELECT account_id, negative_since::text AS negative_since, candidate_fen, status, initiator_id
    FROM app.bad_debt_writeoffs WHERE id = ${pending['id']}
  `.execute(h.app);
  expect(stored.rows).toEqual([
    {
      account_id: p.accountId,
      negative_since: '2032-04-20',
      candidate_fen: 800n,
      status: 'PENDING',
      initiator_id: null,
    },
  ]);
});

it('[AC-B2-12a#19] status 只取契约 bad_debt_writeoff_status 的三个值', async () => {
  await ready(h.app);
  const p = await parents(h.app);
  const values = enumValues('bad_debt_writeoff_status');
  expect([...values].sort()).toEqual(['APPROVED', 'CANCELLED', 'PENDING']);
  for (const status of ['pending', 'REJECTED', 'VOID', '']) {
    expect(await attempt(candidate(p, { status })), status).toBe('23514');
  }
});

it.each(['voucher_id', 'approver_id', 'approved_at'])(
  '[AC-B2-12a#20] APPROVED 候选单缺 %s 被 CHECK 拒绝（批准即写 BAD_DEBT_WRITEOFF 凭证）',
  async (column) => {
    await ready(h.app);
    const p = await parents(h.app);
    const row = candidate(p);
    expect(await attempt({ ...row, ...(await approval(p, row['id'])), [column]: null })).toBe(
      '23514',
    );
    await insert(h.app, 'bad_debt_writeoffs', row);
    const change: Row = { ...(await approval(p, randomUUID())), [column]: null };
    expect(await sqlState(update(h.app, 'bad_debt_writeoffs', { id: row['id'] }, change))).toBe(
      '23514',
    );
  },
);

it('[AC-B2-12a#21] CANCELLED 候选单不写凭证：带 voucher_id 被拒绝', async () => {
  await ready(h.app);
  const p = await parents(h.app);
  const v = await voucher(h.app, p);
  expect(await attempt(candidate(p, { status: 'CANCELLED', voucher_id: v }))).toBe('23514');
  const row = candidate(p);
  await insert(h.app, 'bad_debt_writeoffs', row);
  const key = { id: row['id'] };
  const cancel = { status: 'CANCELLED', voucher_id: v };
  expect(await sqlState(update(h.app, 'bad_debt_writeoffs', key, cancel))).toBe('23514');
  expect(await sqlState(update(h.app, 'bad_debt_writeoffs', key, { status: 'CANCELLED' }))).toBe(
    'ok',
  );
});

it('[AC-B2-12a#22] 同一账户同时最多 1 张 PENDING 候选单，批准或取消后可再生成', async () => {
  await ready(h.app);
  const p = await parents(h.app);
  const first = candidate(p);
  expect(await attempt(first)).toBe('ok');
  expect(await attempt(candidate(p))).toBe('23505');
  const other = await otherMember(h.app, p);
  expect(await attempt(candidate(p, { account_id: other.accountId }))).toBe('ok');
  await update(h.app, 'bad_debt_writeoffs', { id: first['id'] }, { status: 'CANCELLED' });
  const second = candidate(p);
  expect(await attempt(second)).toBe('ok');
  await update(h.app, 'bad_debt_writeoffs', { id: second['id'] }, await approval(p, second['id']));
  expect(await attempt(candidate(p))).toBe('ok');
  expect(await attempt(candidate(p))).toBe('23505');
});

it.each(['account_id', 'initiator_id', 'approver_id', 'voucher_id'])(
  '[AC-B2-12a#23] %s 指向别的 app 或不存在的行时被外键拒绝',
  async (column) => {
    await ready(h.app);
    const p = await parents(h.app);
    const foreign = await parents(h.app);
    const foreignIds: Record<string, unknown> = {
      account_id: foreign.accountId,
      initiator_id: foreign.adminId,
      approver_id: foreign.adminId,
      voucher_id: await voucher(h.app, foreign),
    };
    const row = candidate(p);
    const base: Row = ['approver_id', 'voucher_id'].includes(column)
      ? { ...row, ...(await approval(p, row['id'])) }
      : row;
    expect(await attempt({ ...base, [column]: foreignIds[column] }), '跨 app').toBe('23503');
    expect(await attempt({ ...base, [column]: randomUUID() }), '不存在').toBe('23503');
  },
);
