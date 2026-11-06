import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { AutoPayoutOptions } from '../../../../apps/api/src/modules/payout/application/auto-payout.ts';
import { setup, type AutoFixture } from '../auto-payout/kit.ts';
import {
  close,
  hits,
  identity,
  open,
  rule,
  seedBlock,
  type Harness,
} from '../withdraw-blocklist-hits/db-kit.ts';
import { assembled } from './worker-kit.ts';

// Capture worker wiring, retaining its real matcher, hit writer and payout child logger.
// Only the existing kit's adult/decryption and external execution ports are substituted.
const capture = vi.hoisted(() => ({ options: null as AutoPayoutOptions | null }));
vi.mock('../../../../apps/api/src/modules/payout/application/auto-payout.ts', async (original) => {
  const actual =
    await original<
      typeof import('../../../../apps/api/src/modules/payout/application/auto-payout.ts')
    >();
  return {
    ...actual,
    createAutoPayoutConsumer(options: AutoPayoutOptions) {
      capture.options = options;
      return actual.createAutoPayoutConsumer(options);
    },
  };
});

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, 60_000);

type Dimension = 'phone' | 'id_no' | 'device' | 'alipay' | 'bank_card';
type IdentityValues = Awaited<ReturnType<typeof identity>>;

async function worker(f: AutoFixture) {
  capture.options = null;
  const app = await assembled(h.db, f.clock);
  try {
    expect(capture.options).not.toBeNull();
    const options = {
      ...capture.options!,
      adult: f.options.adult,
      execute: f.options.execute,
    };
    return { app, options, consumer: f.consumer(options) };
  } catch (error) {
    await app.close();
    throw error;
  }
}

async function seed(f: AutoFixture, dimension: Dimension) {
  const values = await identity(f);
  // Revoked sessions still connect a member to a device for the live ⑨ lookup.
  await sql`INSERT INTO app.sessions (id,app_id,sid,user_id,device_id,revoked_at,revoke_reason)
    VALUES (${randomUUID()},${f.appId},${randomUUID()},${f.actor.userId},${f.actor.deviceId},
      ${f.clock.now()},'logout')`.execute(h.db);
  await seedBlock(h.db, f.appId, dimension, values[dimension], f.clock, {
    expires: new Date('2027-01-01T00:00:00Z'),
  });
  return values;
}

function messages(lines: readonly string[]) {
  return lines
    .flatMap((line) => line.split('\n'))
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line['msg'] === 'auto_payout_blacklist_hit');
}

function privateValuesAbsent(lines: readonly string[], f: AutoFixture, values: IdentityValues) {
  // Inspect ALL worker output, including other messages and free-text values.
  const text = lines.join('\n');
  for (const value of new Set([...Object.values(values), f.actor.userId])) {
    expect(text).not.toContain(value);
  }
}

function oneHitLog(lines: readonly string[], f: AutoFixture, id: string, dimension: Dimension) {
  // Exact equality permits only pino's existing base fields and the four business fields.
  // Even redacted user_id / phone / digest / risk_msg_code fields must be absent.
  expect(messages(lines)).toEqual([
    {
      level: 30,
      time: expect.any(String),
      pid: expect.any(Number),
      entry: 'worker',
      env: 'test',
      module: 'payout',
      msg: 'auto_payout_blacklist_hit',
      app_id: f.appId,
      withdrawal_id: id,
      dimension,
      rule_id: `BLACKLIST_${dimension.toUpperCase()}`,
    },
  ]);
}

it.each(['phone', 'id_no', 'device', 'alipay', 'bank_card'] as const)(
  '[AC-B2-05r#1][BR-WDR-29][BR-ID-33] %s 命中记下后：worker 的 info 日志只有四个业务字段，全部日志无会员编号或摘要',
  async (dimension) => {
    const f = await setup(h, { method: dimension === 'bank_card' ? 'bank_card' : 'alipay' });
    const id = await f.start(100n);
    const values = await seed(f, dimension);
    const w = await worker(f);
    try {
      await w.consumer.consume(await f.event(id));
      expect(await f.row(id)).toMatchObject({
        review_mode: 'manual',
        auto_decision: { failed_conditions: expect.arrayContaining(['risk_flag:blacklist_hit']) },
      });
      expect(await hits(h, f.appId)).toEqual([
        expect.objectContaining({ ref_id: id, dimension, value_hmac: values[dimension] }),
      ]);
      oneHitLog(w.app.lines, f, id, dimension);
      privateValuesAbsent(w.app.lines, f, values);
    } finally {
      await w.app.close();
    }
  },
);

it('[AC-B2-05r#2][BR-WDR-29][BR-ID-33] 不命中与规则停用不打日志，同规则启用后的下一单才有一条', async () => {
  const f = await setup(h);
  const clean = await f.start(100n);
  const w = await worker(f);
  try {
    await w.consumer.consume(await f.event(clean));
    expect(messages(w.app.lines)).toEqual([]);
    expect(await hits(h, f.appId)).toEqual([]);
    const disabled = await f.start(100n);
    const values = await seed(f, 'phone');
    await rule({ db: h.db, clock: f.clock }, f.appId, 'phone', 'disabled');
    f.clock.advanceMs(60_001);
    await w.consumer.consume(await f.event(disabled));
    expect(messages(w.app.lines)).toEqual([]);
    expect(await hits(h, f.appId)).toEqual([]);
    await rule({ db: h.db, clock: f.clock }, f.appId, 'phone', 'enabled');
    f.clock.advanceMs(60_001);
    const blocked = await f.start(100n);
    await w.consumer.consume(await f.event(blocked));
    expect(await hits(h, f.appId)).toEqual([expect.objectContaining({ ref_id: blocked })]);
    oneHitLog(w.app.lines, f, blocked, 'phone');
    privateValuesAbsent(w.app.lines, f, values);
  } finally {
    await w.app.close();
  }
});

it('[AC-B2-05r#3][BR-WDR-29][BR-ID-33] 已判定单的同事件重投、第二个事件都不重复打日志', async () => {
  const f = await setup(h);
  const id = await f.start(100n);
  const values = await seed(f, 'device');
  const first = await f.event(id);
  const second = await f.event(id);
  const w = await worker(f);
  try {
    await w.consumer.consume(first);
    oneHitLog(w.app.lines, f, id, 'device');
    await w.consumer.consume(first);
    oneHitLog(w.app.lines, f, id, 'device');
    await w.consumer.consume(second);
    oneHitLog(w.app.lines, f, id, 'device');
    expect(await hits(h, f.appId)).toEqual([expect.objectContaining({ ref_id: id })]);
    privateValuesAbsent(w.app.lines, f, values);
  } finally {
    await w.app.close();
  }
});

it('[AC-B2-05r#4][BR-WDR-29][BR-ID-33] 旧 warn-only logger 命中不报错也不降级打 warn，下一单用实际 logger 才打 info', async () => {
  const f = await setup(h);
  const legacy = await f.start(100n);
  const values = await seed(f, 'phone');
  const w = await worker(f);
  const warn = vi.fn<AutoPayoutOptions['logger']['warn']>();
  try {
    const consumer = f.consumer({ ...w.options, logger: { warn } });
    await expect(consumer.consume(await f.event(legacy))).resolves.toBeUndefined();
    expect(await hits(h, f.appId)).toEqual([expect.objectContaining({ ref_id: legacy })]);
    // Calendar configuration warnings are unrelated and may still be emitted.
    expect(warn.mock.calls.map(([, message]) => message)).not.toContain(
      'auto_payout_blacklist_hit',
    );
    expect(messages(w.app.lines)).toEqual([]);
    const next = await f.start(100n);
    await w.consumer.consume(await f.event(next));
    oneHitLog(w.app.lines, f, next, 'phone');
    privateValuesAbsent(w.app.lines, f, values);
  } finally {
    await w.app.close();
  }
});
