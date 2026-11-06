// B2-12g unit tests (no database): the marker's one statement on the caller's transaction, compiled
// by a dummy PostgreSQL driver. The rule tests (test/spec/risk/bad-debt-linked/**) run it for real.
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
} from 'kysely';
import { expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { createBadDebtLinkedMarker } from './bad-debt-linked.ts';

const AT = '2027-02-19T02:30:00.000Z';
const INPUT = {
  appId: 'app_unit',
  sourceUserId: '01900000-0000-7000-8000-00000000000c',
  sourceRef: '01900000-0000-7000-8000-00000000000a',
};

async function capture(): Promise<CompiledQuery[]> {
  const queries: CompiledQuery[] = [];
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => {
      if (event.level === 'query') queries.push(event.query);
    },
  });
  const marker = createBadDebtLinkedMarker({ clock: new FixedClock(AT) });
  await db.transaction().execute((trx) => marker.mark(trx, INPUT));
  await db.destroy();
  return queries;
}

it('[AC-B2-12g#6] 一条 INSERT … SELECT 写 app.risk_linked_marks，ON CONFLICT (app_id, source_ref, user_id, dimension) DO NOTHING', async () => {
  const queries = await capture();
  const inserts = queries.filter((query) => /insert\s+into/i.test(query.sql));
  expect(inserts).toHaveLength(1);
  const text = inserts[0]!.sql.replace(/\s+/g, ' ');
  expect(text).toMatch(/INSERT INTO app\.risk_linked_marks/);
  expect(text).toMatch(/ON CONFLICT \(app_id, source_ref, user_id, dimension\) DO NOTHING/);
  expect(text).not.toMatch(/user_id IS NULL|device\.user_id|devices\.user_id/);
});

async function insertText(): Promise<string> {
  const [insert] = (await capture()).filter((query) => /insert\s+into/i.test(query.sql));
  return insert!.sql.replace(/\s+/g, ' ');
}

it('[AC-B2-12g#1] 两个维度都按同 app、排除本人取关联账户：会话设备、收款账号 HMAC', async () => {
  const text = await insertText();
  for (const dimension of ['device', 'payout_account']) {
    expect(text).toContain(`'${dimension}'::text`);
  }
  expect(text).not.toMatch(/revoked_at/);
  // device, payout_account by alipay_hmac and by bank_card_hmac.
  expect(text.match(/other\.user_id <> mine\.user_id/g)).toHaveLength(3);
  expect(text.match(/mine\.app_id = \$\d+ AND mine\.user_id = \$\d+::uuid/g)).toHaveLength(3);
});

it('[AC-B2-12g#1] 同实名本期不做（FU-BAD-DEBT-LINKED-REALNAME）：不写 id_no，不读 realname 与旧身份', async () => {
  const text = await insertText();
  expect(text).not.toContain("'id_no'");
  expect(text).not.toMatch(/realname|prior_identities|id_no_hmac/);
});

it('[AC-B2-12g#12] 同设备按 device_hash：被核销用户会话（含已吊销）的设备行取哈希，同 app 同哈希的任一设备行上有会话的其他用户；不读 devices.user_id', async () => {
  const text = await insertText();
  expect(text).toContain(
    'FROM app.sessions mine JOIN app.devices mine_device ON mine_device.app_id = mine.app_id AND mine_device.id = mine.device_id',
  );
  expect(text).toContain(
    'JOIN app.devices other_device ON other_device.app_id = mine_device.app_id AND other_device.device_hash = mine_device.device_hash',
  );
  expect(text).toContain(
    'JOIN app.sessions other ON other.app_id = other_device.app_id AND other.device_id = other_device.id',
  );
  expect(text).not.toMatch(/other\.device_id = mine\.device_id/);
  expect(text).not.toMatch(/_device\.user_id/);
});

it('[AC-B2-12g#10] 同收款账号含历史行：双方全部 payout_accounts 行（不限 is_current），支付宝 HMAC 与银行卡 HMAC 各一支', async () => {
  const text = await insertText();
  expect(text).not.toMatch(/is_current/);
  expect(text).toContain(
    'FROM app.payout_accounts mine JOIN app.payout_accounts other ON other.app_id = mine.app_id AND other.alipay_hmac = mine.alipay_hmac',
  );
  expect(text).toContain(
    'FROM app.payout_accounts mine JOIN app.payout_accounts other ON other.app_id = mine.app_id AND other.bank_card_hmac = mine.bank_card_hmac',
  );
  expect(text).not.toMatch(/alipay_hmac OR/);
});

it('[AC-B2-12g#6] 参数：app_id、被核销用户、候选单 id 与注入时钟的时刻', async () => {
  const [insert] = (await capture()).filter((query) => /insert\s+into/i.test(query.sql));
  const parameters = insert!.parameters;
  expect(parameters).toContain(INPUT.appId);
  expect(parameters).toContain(INPUT.sourceUserId);
  expect(parameters).toContain(INPUT.sourceRef);
  expect(parameters).toContainEqual(new Date(AT));
});
