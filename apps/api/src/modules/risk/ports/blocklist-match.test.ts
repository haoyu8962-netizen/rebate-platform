// Unit tests of risk's blocklist match walk without a database (B1-03zj; BR-WDR-29 ⑨, BR-WDR-03 ③a,
// BR-ID-36): Kysely runs on a scripted driver that answers the member's HMACs, the listed devices'
// hashes and the blocklist rows by value, to pin the dimension order (phone → id_no → each device
// → payee account) for one device and for a device list, the rule switches (a disabled dimension is
// skipped, its status read once per walk however many devices), and that nothing is written. The
// SQL itself runs against PostgreSQL in the rule tests (test/spec/risk/blocklist-hit-order and
// test/spec/payout/withdraw-blocklist-hits).
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
import type { RiskRuleKey, RiskRuleStatusReader } from '../application/risk-rule-status.ts';
import { createBlocklistMatchReader } from './blocklist-match.ts';

const APP = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
const D1 = '33333333-3333-3333-3333-333333333331';
const D2 = '33333333-3333-3333-3333-333333333332';
const D3 = '33333333-3333-3333-3333-333333333333';
const NOW = new Date('2026-11-06T00:00:00.000Z');

interface World {
  readonly phone?: string;
  readonly idNo?: string;
  /** device id → device hash */
  readonly devices?: Readonly<Record<string, string>>;
  /** listed value HMACs (any dimension) → violation type */
  readonly listed?: Readonly<Record<string, string>>;
}

interface Recorder {
  readonly statements: string[];
}

function fakeDb(world: World, recorder: Recorder): Kysely<DB> {
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      const { sql, parameters } = compiled;
      recorder.statements.push(sql);
      let rows: unknown[] = [];
      if (sql.includes('from "app"."users"')) {
        rows = world.phone === undefined ? [] : [{ phone_hmac: world.phone }];
      } else if (sql.includes('from "app"."realname"')) {
        rows = world.idNo === undefined ? [] : [{ id_no_hmac: world.idNo }];
      } else if (sql.includes('from "app"."devices"')) {
        const ids = parameters.slice(1);
        rows = ids
          .filter((id) => typeof id === 'string' && world.devices?.[id] !== undefined)
          .reverse() // the answer's order is not the caller's order
          .map((id) => ({ id, device_hash: world.devices?.[id as string] }));
      } else if (sql.includes('from "app"."blocklist"')) {
        const value = parameters[2];
        const violation = typeof value === 'string' ? world.listed?.[value] : undefined;
        rows = violation === undefined ? [] : [{ violation_type: violation }];
      } else {
        throw new Error(`unexpected statement: ${sql}`);
      }
      return Promise.resolve({ rows } as QueryResult<R>);
    },
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async () => undefined,
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
    releaseConnection: async () => undefined,
    destroy: async () => undefined,
  };
  return new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}

/** A status reader over a fixed set of disabled rule ids that counts its reads per rule. */
function statusReader(disabled: readonly string[] = []) {
  const reads: string[] = [];
  const handles: unknown[] = [];
  const reader: RiskRuleStatusReader = {
    isEnabled(key: RiskRuleKey, executor) {
      reads.push(key.rule_id);
      handles.push(executor);
      return Promise.resolve(!disabled.includes(key.rule_id));
    },
  };
  return { reader, reads, handles };
}

function subject(over: { deviceId?: string; deviceIds?: readonly string[] } = {}) {
  return {
    appId: APP,
    userId: USER,
    deviceId: over.deviceId ?? D1,
    ...(over.deviceIds === undefined ? {} : { deviceIds: over.deviceIds }),
    payeeHmac: 'payee-h',
    payoutMethod: 'alipay' as const,
    now: NOW,
  };
}

const EVERYTHING: World = {
  phone: 'phone-h',
  idNo: 'id-h',
  devices: { [D1]: 'dev1-h', [D2]: 'dev2-h', [D3]: 'dev3-h' },
};

it('[AC-B1-03zj#7] 单台设备：设备与收款账号同时在黑名单时记设备；手机号在时记手机号（③a 顺序）', async () => {
  const recorder: Recorder = { statements: [] };
  const reader = createBlocklistMatchReader();
  const both = fakeDb(
    { ...EVERYTHING, listed: { 'dev1-h': 'fraud', 'payee-h': 'abuse' } },
    recorder,
  );
  expect(await reader.match?.(both, subject())).toEqual({
    risk_msg_code: 'blocklist.fraud',
    hit: { dimension: 'device', value_hmac: 'dev1-h', rule_id: 'BLACKLIST_DEVICE' },
  });
  const phone = fakeDb(
    { ...EVERYTHING, listed: { 'phone-h': 'spam', 'dev1-h': 'fraud', 'payee-h': 'abuse' } },
    recorder,
  );
  expect(await reader.read(phone, subject())).toEqual({ risk_msg_code: 'blocklist.spam' });
  expect(recorder.statements.every((sql) => sql.startsWith('select'))).toBe(true);
});

it('[AC-B1-03zj#8] 设备列表：任一台设备与收款账号同时在黑名单时记那台设备，不论排第几；deviceId 不读', async () => {
  const recorder: Recorder = { statements: [] };
  const reader = createBlocklistMatchReader();
  const db = fakeDb({ ...EVERYTHING, listed: { 'dev3-h': 'fraud', 'payee-h': 'abuse' } }, recorder);
  const decided = await reader.match?.(
    db,
    subject({ deviceId: '00000000-0000-0000-0000-000000000000', deviceIds: [D1, D2, D3] }),
  );
  expect(decided).toEqual({
    risk_msg_code: 'blocklist.fraud',
    hit: { dimension: 'device', value_hmac: 'dev3-h', rule_id: 'BLACKLIST_DEVICE' },
  });
  const deviceReads = recorder.statements.filter((sql) => sql.includes('from "app"."devices"'));
  expect(deviceReads).toHaveLength(1);
});

it('[AC-B1-03zj#9] 设备列表：两台都在黑名单时记列表里靠前的那台；身份证在时记身份证', async () => {
  const reader = createBlocklistMatchReader();
  const recorder: Recorder = { statements: [] };
  const two = fakeDb({ ...EVERYTHING, listed: { 'dev2-h': 'a', 'dev3-h': 'b' } }, recorder);
  expect((await reader.match?.(two, subject({ deviceIds: [D3, D2] })))?.hit.value_hmac).toBe(
    'dev3-h',
  );
  const idNo = fakeDb({ ...EVERYTHING, listed: { 'id-h': 'c', 'dev2-h': 'a' } }, recorder);
  expect((await reader.match?.(idNo, subject({ deviceIds: [D1, D2] })))?.hit).toEqual({
    dimension: 'id_no',
    value_hmac: 'id-h',
    rule_id: 'BLACKLIST_ID_NO',
  });
});

it('[AC-B1-03zj#10] 设备列表：只有收款账号在黑名单时记收款账号；空列表不查设备；都不在时为 null', async () => {
  const reader = createBlocklistMatchReader();
  const recorder: Recorder = { statements: [] };
  const payee = fakeDb({ ...EVERYTHING, listed: { 'payee-h': 'abuse' } }, recorder);
  expect((await reader.match?.(payee, subject({ deviceIds: [D1, D2] })))?.hit).toEqual({
    dimension: 'alipay',
    value_hmac: 'payee-h',
    rule_id: 'BLACKLIST_ALIPAY',
  });
  const empty: Recorder = { statements: [] };
  const none = fakeDb({ ...EVERYTHING, listed: { 'dev1-h': 'fraud' } }, empty);
  expect(await reader.match?.(none, subject({ deviceIds: [] }))).toBeNull();
  expect(empty.statements.some((sql) => sql.includes('from "app"."devices"'))).toBe(false);
  expect(await reader.read(fakeDb(EVERYTHING, recorder), subject({ deviceIds: [D1] }))).toBeNull();
});

it('[AC-B1-03zj#11] 设备规则停用：设备与收款账号同时在黑名单时记收款账号；每个维度的状态一次判定只读一次、走调用方句柄', async () => {
  const { reader: rules, reads, handles } = statusReader(['BLACKLIST_DEVICE']);
  const reader = createBlocklistMatchReader({ rules });
  const recorder: Recorder = { statements: [] };
  const db = fakeDb(
    { ...EVERYTHING, listed: { 'dev1-h': 'fraud', 'dev2-h': 'fraud', 'payee-h': 'abuse' } },
    recorder,
  );
  expect((await reader.match?.(db, subject({ deviceIds: [D1, D2, D3, D1] })))?.hit).toEqual({
    dimension: 'alipay',
    value_hmac: 'payee-h',
    rule_id: 'BLACKLIST_ALIPAY',
  });
  expect(reads).toEqual([
    'BLACKLIST_PHONE',
    'BLACKLIST_ID_NO',
    'BLACKLIST_DEVICE',
    'BLACKLIST_ALIPAY',
  ]);
  expect(handles.every((handle) => handle === db)).toBe(true);
  expect(recorder.statements.filter((sql) => sql.includes('from "app"."blocklist"'))).toHaveLength(
    3,
  );
});

it('[AC-B1-03zj#12] 设备列表重复或同哈希的设备只查一次黑名单；启用时状态也只读一次', async () => {
  const { reader: rules, reads } = statusReader();
  const reader = createBlocklistMatchReader({ rules });
  const recorder: Recorder = { statements: [] };
  const db = fakeDb(
    { phone: 'phone-h', devices: { [D1]: 'same-h', [D2]: 'same-h' }, listed: {} },
    recorder,
  );
  expect(await reader.match?.(db, subject({ deviceIds: [D1, D2, D1] }))).toBeNull();
  expect(reads.filter((rule) => rule === 'BLACKLIST_DEVICE')).toHaveLength(1);
  // phone, the one device hash, the payee account
  expect(recorder.statements.filter((sql) => sql.includes('from "app"."blocklist"'))).toHaveLength(
    3,
  );
});
