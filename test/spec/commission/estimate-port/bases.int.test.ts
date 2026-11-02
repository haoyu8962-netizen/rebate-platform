// B2-03q · bases（D10-565）：after = 用入参的 estAfter、settleCommissionFen 按冻结条款算 B，结算优先；
// before = 最大版本 totals.base_fen。无快照两者都 null；有效佣金全空 after 为 null，不当 0。
// 拼多多 N = 佣金 − 服务费（BR-CALC-02、BR-CALC-03，与快照同口径）；N 不含补贴（BR-CALC-02）。
// 默认单：预留 1500、N=1000 → B=850（425 / 85 / 42）。
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { LATER, amountRows, fixture, frozenRows, totalsRows, type PersonInput } from './kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
let readonlyDb: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
  readonlyDb = createDb({ connectionString: database.urlFor('couli_readonly'), max: 1 });
}, 60_000);

afterAll(async () => {
  try {
    if (readonlyDb) await destroyDb(readonlyDb);
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 60_000);

it('[AC-B2-03q#1][BR-CALC-02] after 用入参预估按快照预留换算，before 取库内最大版本的 B', async () => {
  const f = await fixture(db);
  const o = await f.order();
  expect(await f.bases(o, { estAfter: 2000n, settleCommissionFen: null })).toEqual({
    before: 850n,
    after: 1700n,
  });
});

it('[AC-B2-03q#2][BR-CALC-02] 结算优先：有结算佣金时预估不参与 after', async () => {
  const f = await fixture(db);
  const o = await f.order();
  expect(await f.bases(o, { estAfter: 5000n, settleCommissionFen: 1000n })).toEqual({
    before: 850n,
    after: 850n,
  });
  expect(await f.bases(o, { estAfter: null, settleCommissionFen: 1200n })).toEqual({
    before: 850n,
    after: 1020n,
  });
});

it('[AC-B2-03q#3][BR-CALC-02] 结算佣金为 0 或负数时 after 是 0，不退回预估', async () => {
  const f = await fixture(db);
  const o = await f.order();
  expect(await f.bases(o, { estAfter: 5000n, settleCommissionFen: 0n })).toEqual({
    before: 850n,
    after: 0n,
  });
  expect(await f.bases(o, { estAfter: 5000n, settleCommissionFen: -5n })).toEqual({
    before: 850n,
    after: 0n,
  });
});

it('[AC-B2-03q#4][BR-CALC-02] 预估为负按 0 算 after；预估为 0 也是 0，不是 null', async () => {
  const f = await fixture(db);
  const o = await f.order();
  expect(await f.bases(o, { estAfter: -1n, settleCommissionFen: null })).toEqual({
    before: 850n,
    after: 0n,
  });
  expect(await f.bases(o, { estAfter: 0n, settleCommissionFen: null })).toEqual({
    before: 850n,
    after: 0n,
  });
});

it('[AC-B2-03q#5] 有效佣金全空：after 是 null，不当 0；before 照旧取库内值', async () => {
  const f = await fixture(db);
  const o = await f.order();
  expect(await f.bases(o, { estAfter: null, settleCommissionFen: null })).toEqual({
    before: 850n,
    after: null,
  });
});

it('[AC-B2-03q#6] 无快照：before 与 after 都是 null，即使入参带了佣金', async () => {
  const f = await fixture(db);
  const o = await f.order({ snapshot: false });
  expect(await f.bases(o, { estAfter: 2000n, settleCommissionFen: null })).toEqual({
    before: null,
    after: null,
  });
  expect(await f.bases(o, { estAfter: null, settleCommissionFen: 1000n })).toEqual({
    before: null,
    after: null,
  });
  // 连订单都没有：同样是未知，不是 0，也不报错。
  expect(
    await f.bases({ ...o, orderId: randomUUID() }, { estAfter: 2000n, settleCommissionFen: null }),
  ).toEqual({ before: null, after: null });
});

it('[AC-B2-03q#7][BR-CALC-02] 预留与淘礼金扣除取快照冻结值：规则改了也不变，基数截到 0', async () => {
  const f = await fixture(db);
  const o = await f.order({ reserveBp: 2000, tljDeductFen: 30n, rebateMode: 'normal' });
  await f.newerRules();
  // 2000 × 80% = 1600，再扣淘礼金 30 → 1570；新规则的 90% 预留不能进来。
  expect(await f.bases(o, { estAfter: 2000n, settleCommissionFen: null })).toEqual({
    before: 770n,
    after: 1570n,
  });
  // 20 × 80% = 16 < 30 → 0。
  expect(await f.bases(o, { estAfter: 20n, settleCommissionFen: null })).toEqual({
    before: 770n,
    after: 0n,
  });
});

it('[AC-B2-03q#8] before 只看版本号最大的 totals，不看写入顺序、时间、入参 estBefore 或 orders 版本', async () => {
  const f = await fixture(db);
  const o = await f.order({ commissionVersion: 5, estFen: 9000n });
  // 版本 3 先写且时间更早，版本 2 后写且时间更晚；订单版本已到 5，金额行还没跟上。
  await f.version(o, {
    version: 3,
    nTotalFen: 3000n,
    baseFen: 2550n,
    amounts: [1275n, 255n, 127n],
    createdAt: new Date('2026-10-20T00:00:00.000Z'),
  });
  await f.version(o, {
    version: 2,
    nTotalFen: 2000n,
    baseFen: 1700n,
    amounts: [850n, 170n, 85n],
    createdAt: new Date(LATER),
  });
  expect(
    await f.bases(o, { estBefore: 7777n, estAfter: 2000n, settleCommissionFen: null }),
  ).toEqual({ before: 2550n, after: 1700n });
});

it('[AC-B2-03q#9] 库内当前版本 B=0：before 是 0，不是 null', async () => {
  const f = await fixture(db);
  const o = await f.order();
  await f.version(o, { version: 2, nTotalFen: 0n, baseFen: 0n, amounts: [0n, 0n, 0n] });
  expect(await f.bases(o, { estAfter: 2000n, settleCommissionFen: null })).toEqual({
    before: 0n,
    after: 1700n,
  });
});

it('[AC-B2-03q#10] 只读：只读角色的 READ ONLY 事务里可执行，重复调用结果相同，什么也不写', async () => {
  const f = await fixture(db);
  const o = await f.order();
  const before = {
    amounts: await amountRows(db, o),
    totals: await totalsRows(db, o),
    frozen: await frozenRows(db, o),
  };
  await readonlyDb.transaction().execute(async (trx) => {
    await sql`SET TRANSACTION READ ONLY`.execute(trx);
    const input = {
      appId: o.appId,
      orderId: o.orderId,
      attrAt: o.attrAt,
      estBefore: 1000n,
      estAfter: 2000n,
      settleCommissionFen: null,
    };
    expect(await f.estimates.bases(trx, input)).toEqual({ before: 850n, after: 1700n });
    expect(await f.estimates.bases(trx, input)).toEqual({ before: 850n, after: 1700n });
  });
  expect({
    amounts: await amountRows(db, o),
    totals: await totalsRows(db, o),
    frozen: await frozenRows(db, o),
  }).toEqual(before);
});

it('[AC-B2-03q#11] bigint 超过安全整数时逐分准确', async () => {
  const f = await fixture(db);
  const o = await f.order();
  const answer = await f.bases(o, { estAfter: 11764705882352943n, settleCommissionFen: null });
  expect(answer).toEqual({ before: 850n, after: 10000000000000001n });
  expect(typeof answer.after).toBe('bigint');
});

it('[AC-B2-03q#12] 跨 App 不串：别的 App 的订单在本 App 下读不到，同一受益人也一样', async () => {
  const f = await fixture(db);
  const other = await fixture(db);
  const people: readonly PersonInput[] = [
    { role: 'self', ratioBp: 5000 },
    { role: 'direct', ratioBp: 1000, userId: randomUUID() },
  ];
  const mine = await f.order({ people });
  const theirs = await other.order({ people, reserveBp: 3000, snapshotNFen: 3000n });
  expect(await f.bases(mine, { estAfter: 2000n, settleCommissionFen: null })).toEqual({
    before: 850n,
    after: 1700n,
  });
  expect(await other.bases(theirs, { estAfter: 2000n, settleCommissionFen: null })).toEqual({
    before: 2100n,
    after: 1400n,
  });
  expect(
    await f.bases({ ...theirs, appId: mine.appId }, { estAfter: 2000n, settleCommissionFen: null }),
  ).toEqual({ before: null, after: null });
});

it('[AC-B2-03q#52][BR-CALC-02][BR-CALC-03] 拼多多：after 按佣金减服务费换算，结算额同样减；佣金不高于服务费时 N 为 0', async () => {
  const f = await fixture(db);
  const o = await f.order({
    platform: 'pdd',
    estFen: 1200n,
    patch: { service_fee_fen: 200n },
  });
  // (2000 − 200) × 85% = 1530。
  expect(await f.bases(o, { estAfter: 2000n, settleCommissionFen: null })).toEqual({
    before: 850n,
    after: 1530n,
  });
  // 结算优先：(3000 − 200) × 85% = 2380，预估不参与。
  expect(await f.bases(o, { estAfter: 2000n, settleCommissionFen: 3000n })).toEqual({
    before: 850n,
    after: 2380n,
  });
  // 等于服务费与低于服务费都是 0：R6 看的就是这个 0。
  expect(await f.bases(o, { estAfter: 200n, settleCommissionFen: null })).toEqual({
    before: 850n,
    after: 0n,
  });
  expect(await f.bases(o, { estAfter: 150n, settleCommissionFen: null })).toEqual({
    before: 850n,
    after: 0n,
  });
});

it('[AC-B2-03q#53][BR-CALC-03] 拼多多服务费缺失：after 是 null，不按服务费 0 换算；服务费 0 是已知值，照常换算', async () => {
  const f = await fixture(db);
  const unknown = await f.order({
    platform: 'pdd',
    estFen: 1200n,
    patch: { service_fee_fen: null },
  });
  expect(await f.bases(unknown, { estAfter: 2000n, settleCommissionFen: null })).toEqual({
    before: 850n,
    after: null,
  });
  const free = await f.order({ platform: 'pdd', estFen: 1200n, patch: { service_fee_fen: 0n } });
  expect(await f.bases(free, { estAfter: 2000n, settleCommissionFen: null })).toEqual({
    before: 850n,
    after: 1700n,
  });
});

it('[AC-B2-03q#54][BR-CALC-03] 不扣服务费的平台：列里有值也不减，空值也不是未知', async () => {
  const f = await fixture(db);
  const filled = await f.order({ platform: 'jd', patch: { service_fee_fen: 200n } });
  expect(await f.bases(filled, { estAfter: 2000n, settleCommissionFen: null })).toEqual({
    before: 850n,
    after: 1700n,
  });
  const empty = await f.order({ platform: 'taobao', patch: { service_fee_fen: null } });
  expect(await f.bases(empty, { estAfter: 2000n, settleCommissionFen: null })).toEqual({
    before: 850n,
    after: 1700n,
  });
});

it('[AC-B2-03q#55][BR-CALC-02] 补贴不进 N：有补贴时 after 不变，佣金 0 或负数时 after 仍是 0', async () => {
  const f = await fixture(db);
  const o = await f.order({ subsidyFen: 111n });
  expect(await f.bases(o, { estAfter: 2000n, settleCommissionFen: null })).toEqual({
    before: 850n,
    after: 1700n,
  });
  expect(await f.bases(o, { estAfter: 0n, settleCommissionFen: null })).toEqual({
    before: 850n,
    after: 0n,
  });
  expect(await f.bases(o, { estAfter: -50n, settleCommissionFen: null })).toEqual({
    before: 850n,
    after: 0n,
  });
});
