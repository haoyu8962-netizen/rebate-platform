// B2-02z writer rules of BALANCE_CORRECTED (claude-independent; D10-2092 ⑤, D10-2097, D10-2084;
// contracts/openapi.yaml recalcBalanceAdminReconDiff「Member notice」; 08 BR-FUND-24 ⑧「注销用户不发
// 站内信」): on the caller's transaction, one notify_logs row (channel inbox, status success, dedupe
// key balance_corrected:{reconDiffId}:{balanceVersion}) and one inbox_messages row; nothing for an
// unchanged available balance; nothing for users.status deleting or deleted, read on the caller's
// transaction; a member in the cooling-off period (a cooling request, status still normal) gets it;
// the same (reconDiffId, balanceVersion) never writes twice; never a push or SMS record; the
// notify_templates override of the app is used. Real database over couli_app.
import { createDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  NOW,
  dedupeKeyOf,
  deletionRequest,
  inputOf,
  member,
  overrideRow,
  record,
  recordBalanceCorrectedMessage,
  rowsOf,
} from './db-kit.ts';
import { CODE, TITLE, bodyOf } from './texts.ts';

let database: TestDatabase;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 6 });
}, 180_000);
afterAll(async () => {
  try {
    await db?.destroy();
  } finally {
    await database?.drop();
  }
});

it('[AC-B2-02z#8] 写入：一条 notify_logs（站内信渠道、success、去重键 balance_corrected:{reconDiffId}:{balanceVersion}）加一条站内信（标题「余额更正」、正文按模板与 BR-TEXT-10），没有推送与短信记录', async () => {
  const m = await member(db, { status: 'normal' });
  const input = inputOf(m, { before_fen: 1000n, after_fen: -1234n }, { balanceVersion: 7 });

  expect(await record(db, input)).toBe(true);

  const { logs, inbox } = await rowsOf(db, m.appId);
  expect(logs).toHaveLength(1);
  expect(logs[0]).toMatchObject({
    app_id: m.appId,
    user_id: m.uid,
    code: CODE,
    channel: 'inbox',
    status: 'success',
    dedupe_key: `balance_corrected:${input.reconDiffId}:7`,
    suppress_reason: null,
  });
  expect(logs[0]?.sent_at).not.toBeNull();
  expect(logs.filter((row) => row.channel !== 'inbox')).toEqual([]);
  expect(inbox).toHaveLength(1);
  expect(inbox[0]).toMatchObject({
    app_id: m.appId,
    user_id: m.uid,
    code: CODE,
    title: TITLE,
    body: bodyOf('¥10', '-¥12.34'),
    read_at: null,
  });
  expect(inbox[0]?.created_at.getTime()).toBe(NOW.getTime());
}, 900_000);

it('[AC-B2-02z#8] 调增同样写一条（D10-2092：调增调减都发），正文为更正前后的可用余额', async () => {
  const m = await member(db, { status: 'normal' });
  const input = inputOf(m, { before_fen: -150n, after_fen: 0n });

  expect(await record(db, input)).toBe(true);

  const { logs, inbox } = await rowsOf(db, m.appId);
  expect(logs.map((row) => [row.channel, row.status, row.dedupe_key])).toEqual([
    ['inbox', 'success', dedupeKeyOf(input)],
  ]);
  expect(inbox.map((row) => [row.code, row.title, row.body])).toEqual([
    [CODE, TITLE, bodyOf('-¥1.5', '¥0')],
  ]);
}, 900_000);

it('[AC-B2-02z#8] 同一 (reconDiffId, balanceVersion) 再调一次不重复写（同一事务里连调、之后另一事务再调都返回 false），两张表原样', async () => {
  const m = await member(db, { status: 'normal' });
  const input = inputOf(m, { before_fen: 500n, after_fen: 300n });

  const results = await db
    .transaction()
    .execute(async (trx) => [
      await recordBalanceCorrectedMessage(trx, input),
      await recordBalanceCorrectedMessage(trx, input),
    ]);
  expect(results).toEqual([true, false]);
  const once = await rowsOf(db, m.appId);
  expect(once.logs).toHaveLength(1);
  expect(once.inbox).toHaveLength(1);

  expect(await record(db, input)).toBe(false);
  expect(await rowsOf(db, m.appId)).toEqual(once);
}, 900_000);

it('[AC-B2-02z#8] 同一差异单再次重算出新的余额版本 → 另写一条（去重键带余额版本）', async () => {
  const m = await member(db, { status: 'normal' });
  const first = inputOf(m, { before_fen: 500n, after_fen: 300n }, { balanceVersion: 4 });
  const again = inputOf(
    m,
    { before_fen: 300n, after_fen: 200n },
    { reconDiffId: first.reconDiffId, balanceVersion: 5 },
  );

  expect(await record(db, first)).toBe(true);
  expect(await record(db, again)).toBe(true);

  const { logs, inbox } = await rowsOf(db, m.appId);
  const diff = first.reconDiffId;
  const keys = logs.map((row) => row.dedupe_key).sort();
  expect(keys).toEqual([`balance_corrected:${diff}:4`, `balance_corrected:${diff}:5`]);
  const bodies = inbox.map((row) => row.body).sort();
  expect(bodies).toEqual([bodyOf('¥3', '¥2'), bodyOf('¥5', '¥3')]);
}, 900_000);

it('[AC-B2-02z#3] 更正前后可用余额相等 → 写入函数返回 false，notify_logs 与站内信都没有行', async () => {
  const m = await member(db, { status: 'normal' });
  await overrideRow(db, m.appId, {
    title_override: '余额已更正',
    body_override: '{before}→{after}',
  });
  for (const same of [0n, 2_000n, -1_234n]) {
    expect(await record(db, inputOf(m, { before_fen: same, after_fen: same }))).toBe(false);
  }
  expect(await rowsOf(db, m.appId)).toEqual({ logs: [], inbox: [] });
}, 900_000);

it.each(['deleting', 'deleted'] as const)(
  '[AC-B2-02z#7] users.status=%s 的会员不写：返回 false，notify_logs 与站内信都没有行',
  async (status) => {
    const m = await member(db, { status });
    await deletionRequest(db, m, status === 'deleting' ? 'processing' : 'done');

    const increase = inputOf(m, { before_fen: -500n, after_fen: 0n });
    const decrease = inputOf(m, { before_fen: 800n, after_fen: 100n });
    expect(await record(db, increase)).toBe(false);
    expect(await record(db, decrease)).toBe(false);

    expect(await rowsOf(db, m.appId)).toEqual({ logs: [], inbox: [] });
  },
  900_000,
);

it('[AC-B2-02z#7] 注销冷静期内（有 cooling 的注销申请、users.status 仍为 normal）照写一条', async () => {
  const m = await member(db, { status: 'normal' });
  await deletionRequest(db, m, 'cooling');
  const input = inputOf(m, { before_fen: 800n, after_fen: 100n });

  expect(await record(db, input)).toBe(true);

  const { logs, inbox } = await rowsOf(db, m.appId);
  expect(logs.map((row) => [row.user_id, row.channel, row.status, row.dedupe_key])).toEqual([
    [m.uid, 'inbox', 'success', dedupeKeyOf(input)],
  ]);
  expect(inbox.map((row) => [row.user_id, row.title, row.body])).toEqual([
    [m.uid, TITLE, bodyOf('¥8', '¥1')],
  ]);
}, 900_000);

it('[AC-B2-02z#7] users.status 在调用方事务里读：同一事务里刚改成 deleting（未提交）就不写', async () => {
  const m = await member(db, { status: 'normal' });
  const input = inputOf(m, { before_fen: 800n, after_fen: 100n });

  const wrote = await db.transaction().execute(async (trx) => {
    await sql`UPDATE app.users SET status = 'deleting'
      WHERE app_id = ${m.appId} AND id = ${m.uid}`.execute(trx);
    return recordBalanceCorrectedMessage(trx, input);
  });

  expect(wrote).toBe(false);
  expect(await rowsOf(db, m.appId)).toEqual({ logs: [], inbox: [] });
}, 900_000);

it('[AC-B2-02z#4] 写入时读本 app 的 notify_templates 覆盖行：标题与正文用运营措辞、变量照样替换；别的 app 的覆盖不用', async () => {
  const m = await member(db, { status: 'normal' });
  await overrideRow(db, m.appId, {
    title_override: '余额已更正',
    body_override: '可用余额：{before} → {after}（$& 照字面）',
  });
  const other = await member(db, { status: 'normal' });
  await overrideRow(db, other.appId, {
    title_override: '别家的标题',
    body_override: '别家 {after}',
  });
  const plain = await member(db, { status: 'normal' });

  expect(await record(db, inputOf(m, { before_fen: 500n, after_fen: -1234n }))).toBe(true);
  expect(await record(db, inputOf(plain, { before_fen: 500n, after_fen: -1234n }))).toBe(true);

  const reworded = await rowsOf(db, m.appId);
  expect(reworded.inbox.map((row) => [row.title, row.body])).toEqual([
    ['余额已更正', '可用余额：¥5 → -¥12.34（$& 照字面）'],
  ]);
  const defaults = await rowsOf(db, plain.appId);
  expect(defaults.inbox.map((row) => [row.title, row.body])).toEqual([
    [TITLE, bodyOf('¥5', '-¥12.34')],
  ]);
  expect(await rowsOf(db, other.appId)).toEqual({ logs: [], inbox: [] });
}, 900_000);
