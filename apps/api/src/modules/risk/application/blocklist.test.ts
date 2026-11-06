// Unit tests of the blocklist service without a database (B1-03d round 2 review items): Kysely runs
// on a scripted driver that records every connection checkout, transaction boundary and compiled
// statement, to pin
//   - the risk_rules registration written with created_at and updated_at from the same Clock
//     instant as the risk_hits rows, never the columns' DEFAULT now();
//   - matchRegistration reading through the caller's transaction only: no write and no second
//     pooled connection while that transaction is open; the hits are written by recordHits after.
// The SQL itself runs against PostgreSQL in the rule tests (test/spec/risk/blocklist).
import type { DB } from '@couli/db';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { expect, it } from 'vitest';
import { createRootLogger, type Clock, type FieldCrypto } from '../../platform/index.ts';
import { createBlocklistService } from './blocklist.ts';
import type { RiskRuleKey, RiskRuleStatusReader } from './risk-rule-status.ts';

const START_MS = Date.parse('2026-10-08T03:59:59.400Z');
const PHONE = '13812345678';
const DEVICE_HASH = 'b'.repeat(64);

interface Statement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

/** Each read moves 700 ms on: a second read of the Clock would show in the rows. */
class SteppingClock implements Clock {
  private epochMs = START_MS;
  now(): Date {
    const instant = new Date(this.epochMs);
    this.epochMs += 700;
    return instant;
  }
}

/** Rows of an insert; `$n` placeholders resolve to parameters, anything else stays literal. */
function insertedRows(statement: Statement): Record<string, unknown>[] {
  const columns = /\(([^)]*)\) values/.exec(statement.sql)?.[1];
  if (columns === undefined) throw new Error('not an insert');
  const names = columns.split(',').map((column) => column.trim().replaceAll('"', ''));
  const values = statement.sql.slice(statement.sql.indexOf(') values') + ') values'.length);
  const section = values.split(' on conflict')[0] ?? '';
  return [...section.matchAll(/\(([^)]*)\)/g)].map((tuple) => {
    const cells = (tuple[1] ?? '').split(',').map((cell) => cell.trim());
    const row: Record<string, unknown> = {};
    names.forEach((name, index) => {
      const cell = cells[index] ?? '';
      const placeholder = /^\$(\d+)$/.exec(cell);
      row[name] = placeholder === null ? cell : statement.parameters[Number(placeholder[1]) - 1];
    });
    return row;
  });
}

function setup(
  blocked: readonly string[] = [],
  disabled: readonly string[] = [],
  rules?: RiskRuleStatusReader,
) {
  const statements: Statement[] = [];
  const events: string[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      const statement = { sql: compiled.sql, parameters: compiled.parameters };
      statements.push(statement);
      events.push(compiled.sql.split(' ')[0] ?? '');
      if (compiled.sql.startsWith('select') && compiled.sql.includes('"risk_rules"')) {
        const off = compiled.parameters.some((parameter) => disabled.includes(String(parameter)));
        return Promise.resolve({
          rows: off ? [{ status: 'disabled' }] : [{ status: 'enabled' }],
        } as QueryResult<R>);
      }
      const hit =
        compiled.sql.startsWith('select') &&
        compiled.sql.includes('"blocklist"') &&
        compiled.parameters.some((parameter) => blocked.includes(String(parameter)));
      return Promise.resolve({
        rows: hit ? [{ violation_type: 'fraud_invite' }] : [],
      } as QueryResult<R>);
    },
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => {
      events.push('acquire');
      return connection;
    },
    beginTransaction: async () => void events.push('begin'),
    commitTransaction: async () => void events.push('commit'),
    rollbackTransaction: async () => void events.push('rollback'),
    releaseConnection: async () => void events.push('release'),
    destroy: async () => undefined,
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const crypto = {
    blindIndex: (value: string, context: string) => `hmac(${context}:${value})`,
  } as unknown as FieldCrypto;
  const service = createBlocklistService({
    db,
    clock: new SteppingClock(),
    crypto,
    logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
    ...(rules === undefined ? {} : { rules }),
  });
  return { db, service, statements, events };
}

function inserts(statements: readonly Statement[], table: string): Record<string, unknown>[] {
  return statements
    .filter((statement) => statement.sql.startsWith(`insert into "app"."${table}"`))
    .flatMap(insertedRows);
}

it('[AC-B1-03d#13][BR-ID-36] risk_rules 补登记显式写 created_at 与 updated_at，与同次 risk_hits 同一 Clock 时刻', async () => {
  const { service, statements } = setup();
  await service.recordHit({
    app_id: 'couli',
    request_type: 'register',
    related_phone: PHONE,
    dimension: 'device',
    value_hmac: DEVICE_HASH,
    rule_id: 'DEVICE_REGISTER_LIMIT',
  });
  const [rule] = inserts(statements, 'risk_rules');
  const [hit] = inserts(statements, 'risk_hits');
  expect(rule?.rule_id).toBe('DEVICE_REGISTER_LIMIT');
  expect(rule?.created_at).toBeInstanceOf(Date);
  expect(rule?.updated_at).toBeInstanceOf(Date);
  const at = (hit?.created_at as Date).getTime();
  expect((rule?.created_at as Date).getTime()).toBe(at);
  expect((rule?.updated_at as Date).getTime()).toBe(at);
  const registration = statements.find((s) => s.sql.startsWith('insert into "app"."risk_rules"'));
  expect(registration?.sql).toContain('on conflict ("app_id", "rule_id") do nothing');
});

it('[AC-B1-03d#21][BR-ID-31/36] matchRegistration 只经调用方事务读：事务开着时不借第二个连接、不写；命中由 recordHits 事后写，共用编号', async () => {
  const { db, service, statements, events } = setup(['hmac(users.phone:13812345678)', DEVICE_HASH]);
  const block = await db.transaction().execute((trx) =>
    service.matchRegistration(trx, {
      app_id: 'couli',
      phone_hmac: 'hmac(users.phone:13812345678)',
      device_hash: DEVICE_HASH,
      related_phone: PHONE,
    }),
  );
  expect(block).toEqual({
    code: 44001,
    data: { risk_msg_code: 'blocklist.fraud_invite' },
    hits: [
      {
        dimension: 'phone',
        value_hmac: 'hmac(users.phone:13812345678)',
        rule_id: 'BLACKLIST_PHONE',
      },
      { dimension: 'device', value_hmac: DEVICE_HASH, rule_id: 'BLACKLIST_DEVICE' },
    ],
  });
  // Per dimension: the rule status (B1-03zh), then the entry; all through the caller's transaction.
  expect(events).toEqual([
    'acquire',
    'begin',
    'select',
    'select',
    'select',
    'select',
    'commit',
    'release',
  ]);
  expect(statements.filter((s) => !s.sql.startsWith('select'))).toEqual([]);

  const { ref_id: refId } = await service.recordHits(
    { app_id: 'couli', request_type: 'register', related_phone: PHONE },
    block!.hits,
  );
  const rows = inserts(statements, 'risk_hits');
  expect(rows.map((row) => [row.dimension, row.rule_id, row.ref_id])).toEqual([
    ['phone', 'BLACKLIST_PHONE', refId],
    ['device', 'BLACKLIST_DEVICE', refId],
  ]);
  expect(rows.every((row) => row.user_id === null && row.request_type === 'register')).toBe(true);
  expect(rows[0]?.related_phone_masked).toBe('138****5678');
});

it('[AC-B1-03d#21] matchRegistration 未命中回 null；recordHits 不接受空命中', async () => {
  const { db, service, statements } = setup();
  expect(
    await db.transaction().execute((trx) =>
      service.matchRegistration(trx, {
        app_id: 'couli',
        phone_hmac: 'x',
        related_phone: PHONE,
      }),
    ),
  ).toBeNull();
  await expect(
    service.recordHits({ app_id: 'couli', request_type: 'register', related_phone: PHONE }, []),
  ).rejects.toThrow();
  expect(statements.filter((s) => !s.sql.startsWith('select'))).toEqual([]);
});

it('[AC-B1-03zh#14][BR-ID-36] 停用 BLACKLIST_PHONE：check 不匹配名单、回 null，不写命中', async () => {
  const { service, statements } = setup(['hmac(users.phone:13812345678)'], ['BLACKLIST_PHONE']);
  const result = await service.check({
    app_id: 'couli',
    dimension: 'phone',
    value: PHONE,
    related_phone: PHONE,
    request_type: 'register',
  });
  expect(result).toBeNull();
  expect(statements.some((s) => s.sql.includes('"blocklist"'))).toBe(false);
  expect(statements.filter((s) => !s.sql.startsWith('select'))).toEqual([]);
});

it('[AC-B1-03zh#15][BR-ID-36] 停用 BLACKLIST_PHONE：matchRegistration 只按仍生效的设备维度拦', async () => {
  const { db, service } = setup(
    ['hmac(users.phone:13812345678)', DEVICE_HASH],
    ['BLACKLIST_PHONE'],
  );
  const block = await db.transaction().execute((trx) =>
    service.matchRegistration(trx, {
      app_id: 'couli',
      phone_hmac: 'hmac(users.phone:13812345678)',
      device_hash: DEVICE_HASH,
      related_phone: PHONE,
    }),
  );
  expect(block?.hits).toEqual([
    { dimension: 'device', value_hmac: DEVICE_HASH, rule_id: 'BLACKLIST_DEVICE' },
  ]);
});

it('[AC-B1-03zh#13][BR-ID-36] 停用 DEVICE_REGISTER_LIMIT：recordHit 不开事务、不登记规则、不写命中', async () => {
  const { service, statements, events } = setup([], ['DEVICE_REGISTER_LIMIT']);
  await service.recordHit({
    app_id: 'couli',
    request_type: 'register',
    related_phone: PHONE,
    dimension: 'device',
    value_hmac: DEVICE_HASH,
    rule_id: 'DEVICE_REGISTER_LIMIT',
  });
  expect(statements.filter((s) => !s.sql.startsWith('select'))).toEqual([]);
  expect(events).not.toContain('begin');
});

it('[AC-B1-03zh#15][BR-ID-36] recordHits 只写仍生效规则的行；同一请求的生效行照常共用编号', async () => {
  const { service, statements } = setup([], ['BLACKLIST_PHONE']);
  const { ref_id: refId } = await service.recordHits(
    { app_id: 'couli', request_type: 'register', related_phone: PHONE },
    [
      { dimension: 'phone', value_hmac: 'p', rule_id: 'BLACKLIST_PHONE' },
      { dimension: 'device', value_hmac: DEVICE_HASH, rule_id: 'BLACKLIST_DEVICE' },
    ],
  );
  expect(inserts(statements, 'risk_hits').map((row) => [row.rule_id, row.ref_id])).toEqual([
    ['BLACKLIST_DEVICE', refId],
  ]);
  expect(inserts(statements, 'risk_rules').map((row) => row.rule_id)).toEqual(['BLACKLIST_DEVICE']);
});

it('[AC-B1-03zh#13][BR-ID-36] allowBlockedRegistration 不看规则状态（停用的上限由 identity 在计数前跳过），照旧默认拒绝', async () => {
  const { db, service, events } = setup([], ['DEVICE_REGISTER_LIMIT']);
  const allowed = await db.transaction().execute((trx) =>
    service.allowBlockedRegistration(trx, {
      app_id: 'couli',
      device_hash: DEVICE_HASH,
      count: 3,
      limit: 3,
      phone_hmac: null,
      third_party_digest: null,
    }),
  );
  expect(allowed).toBe(false);
  expect(events).toEqual(['acquire', 'begin', 'commit', 'release']);
});

it('[AC-B1-03zh#1][BR-ID-36] ruleInForce：与本服务共用同一读口与缓存，经给定事务读', async () => {
  const { db, service, statements } = setup([], ['SMS_BLOCKED_PREFIX']);
  const key = { app_id: 'couli', rule_id: 'SMS_BLOCKED_PREFIX' };
  expect(await db.transaction().execute((trx) => service.ruleInForce!(key, trx))).toBe(false);
  // Cached: the prefix hit writer asks again without a second read.
  await service.recordHit({
    app_id: 'couli',
    request_type: 'register',
    related_phone: PHONE,
    dimension: 'phone_prefix',
    value_hmac: 'p',
    rule_id: 'SMS_BLOCKED_PREFIX',
  });
  expect(statements.filter((s) => s.sql.includes('"risk_rules"'))).toHaveLength(1);
  expect(statements.filter((s) => !s.sql.startsWith('select'))).toEqual([]);
  expect(await service.ruleInForce!({ app_id: 'couli', rule_id: 'DEVICE_REGISTER_LIMIT' })).toBe(
    true,
  );
});

/**
 * A reader whose answer for each (app_id, rule_id) is «enabled» on its first read and «disabled» on
 * every later one: the cache running out right after the decision (money r1 S1 of B1-03zh).
 */
function expiringReader() {
  const reads: RiskRuleKey[] = [];
  const reader: RiskRuleStatusReader = {
    isEnabled(key) {
      const earlier = reads.some((r) => r.app_id === key.app_id && r.rule_id === key.rule_id);
      reads.push({ app_id: key.app_id, rule_id: key.rule_id });
      return Promise.resolve(!earlier);
    },
  };
  return { reader, reads };
}

it.each(['SMS_BLOCKED_PREFIX', 'DEVICE_REGISTER_LIMIT'])(
  '[AC-B1-03zh#19][AC-B1-03zh#20][BR-ID-36] recordDecidedHit（%s）：调用方已按生效判定拒绝，写命中不再读规则状态，状态随后变停用也照写',
  async (ruleId) => {
    const { reader, reads } = expiringReader();
    const { db, service, statements } = setup([], [], reader);
    // The decision: the one read of this judgement.
    const key = { app_id: 'couli', rule_id: ruleId };
    expect(await db.transaction().execute((trx) => service.ruleInForce!(key, trx))).toBe(true);
    await service.recordDecidedHit!({
      app_id: 'couli',
      request_type: 'register',
      related_phone: PHONE,
      dimension: ruleId === 'SMS_BLOCKED_PREFIX' ? 'phone_prefix' : 'device',
      value_hmac: 'v',
      rule_id: ruleId,
    });
    expect(reads).toHaveLength(1);
    expect(inserts(statements, 'risk_hits').map((row) => row.rule_id)).toEqual([ruleId]);
    // A plain recordHit (no decision of its own) still reads, and now finds the rule disabled.
    await service.recordHit({
      app_id: 'couli',
      request_type: 'register',
      related_phone: PHONE,
      dimension: 'device',
      value_hmac: 'w',
      rule_id: ruleId,
    });
    expect(reads).toHaveLength(2);
    expect(inserts(statements, 'risk_hits')).toHaveLength(1);
  },
);

it('[AC-B1-03zh#19][BR-ID-36] recordHit 带 decided_in_force：不读规则状态，照写命中', async () => {
  const { service, statements } = setup([], ['SMS_BLOCKED_PREFIX']);
  await service.recordHit({
    app_id: 'couli',
    request_type: 'register',
    related_phone: PHONE,
    dimension: 'phone_prefix',
    value_hmac: 'p',
    rule_id: 'SMS_BLOCKED_PREFIX',
    decided_in_force: true,
  });
  expect(
    statements.filter((s) => s.sql.includes('"risk_rules"') && s.sql.startsWith('select')),
  ).toEqual([]);
  expect(inserts(statements, 'risk_hits')).toEqual([
    expect.objectContaining({ rule_id: 'SMS_BLOCKED_PREFIX', dimension: 'phone_prefix' }),
  ]);
});

it('[AC-B1-03zh#15][BR-ID-36] matchRegistration 判定过的命中行交给 recordHits 不再读状态；别处来的行、别的 app 照旧自读', async () => {
  const { reader, reads } = expiringReader();
  const { db, service, statements } = setup(['p', DEVICE_HASH], [], reader);
  const input = {
    app_id: 'couli',
    phone_hmac: 'p',
    device_hash: DEVICE_HASH,
    related_phone: PHONE,
  };
  const block = await db.transaction().execute((trx) => service.matchRegistration(trx, input));
  expect(block?.hits.map((hit) => hit.rule_id)).toEqual(['BLACKLIST_PHONE', 'BLACKLIST_DEVICE']);
  expect(reads).toHaveLength(2);
  const request = { app_id: 'couli', request_type: 'register' as const, related_phone: PHONE };
  // A caller that filters the rows keeps the decided objects.
  await service.recordHits(request, block!.hits.filter(Boolean));
  expect(reads).toHaveLength(2);
  expect(inserts(statements, 'risk_hits').map((row) => row.rule_id)).toEqual([
    'BLACKLIST_PHONE',
    'BLACKLIST_DEVICE',
  ]);
  // A look-alike row is no token: read here, now disabled, nothing written.
  await service.recordHits(request, [{ ...block!.hits[0]! }]);
  // A decided row handed over for another app is no token there either.
  await service.recordHits({ ...request, app_id: 'other' }, [block!.hits[1]!]);
  expect(reads).toHaveLength(4);
  expect(inserts(statements, 'risk_hits')).toHaveLength(3);
  expect(inserts(statements, 'risk_hits')[2]).toMatchObject({ app_id: 'other' });
});

it('[AC-B2-05q-UNIT#1][BR-ID-36] recordDecidedHit 收手机号摘要 + 脱敏号：原样入库、不再算摘要、不读规则状态', async () => {
  const { service, statements } = setup([], ['BLACKLIST_DEVICE']);
  await service.recordDecidedHit!({
    app_id: 'couli',
    request_type: 'withdraw',
    user_id: '018f0000-0000-7000-8000-000000000001',
    amount_fen: 1300n,
    related_phone_digest: { hmac: 'stored-digest', masked: '138****5678' },
    dimension: 'device',
    value_hmac: DEVICE_HASH,
    rule_id: 'BLACKLIST_DEVICE',
  });
  expect(
    statements.filter((s) => s.sql.includes('"risk_rules"') && s.sql.startsWith('select')),
  ).toEqual([]);
  expect(inserts(statements, 'risk_hits')).toEqual([
    expect.objectContaining({
      ref_type: 'blocked_request',
      request_type: 'withdraw',
      risk_action: 'block',
      user_id: '018f0000-0000-7000-8000-000000000001',
      amount_fen: 1300n,
      dimension: 'device',
      value_hmac: DEVICE_HASH,
      rule_id: 'BLACKLIST_DEVICE',
      related_phone_hmac: 'stored-digest',
      related_phone_masked: '138****5678',
    }),
  ]);
});

it('[AC-B2-05q-UNIT#2][BR-ID-36] recordDecidedHit 的账号没有手机号（摘要给 null）：关联手机号两列同空，命中照写', async () => {
  const { service, statements } = setup();
  const { ref_id: refId } = await service.recordDecidedHit!({
    app_id: 'couli',
    request_type: 'withdraw',
    user_id: '018f0000-0000-7000-8000-000000000002',
    amount_fen: 500n,
    related_phone_digest: null,
    dimension: 'alipay',
    value_hmac: 'payee-digest',
    rule_id: 'BLACKLIST_ALIPAY',
  });
  expect(inserts(statements, 'risk_hits')).toEqual([
    expect.objectContaining({
      ref_id: refId,
      amount_fen: 500n,
      related_phone_hmac: null,
      related_phone_masked: null,
    }),
  ]);
});

it('[AC-B2-05q-UNIT#3][BR-ID-36] 明文手机号的给法不变：摘要取 users.phone 盲索引，脱敏 3 + 4', async () => {
  const { service, statements } = setup();
  await service.recordDecidedHit!({
    app_id: 'couli',
    request_type: 'payout_account',
    user_id: '018f0000-0000-7000-8000-000000000003',
    related_phone: PHONE,
    dimension: 'alipay',
    value_hmac: 'payee-digest',
    rule_id: 'BLACKLIST_ALIPAY',
  });
  expect(inserts(statements, 'risk_hits')).toEqual([
    expect.objectContaining({
      related_phone_hmac: `hmac(users.phone:${PHONE})`,
      related_phone_masked: '138****5678',
      amount_fen: null,
    }),
  ]);
});
