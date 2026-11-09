// B2-02v: ledger's port against PostgreSQL (D10-1038, D10-1180, D10-1185). It counts, per app_id, the
// recon_diffs rows with type ledger_mismatch, status open or processing, ref_type voucher and a ref_id
// starting with `credit_postcheck:`. The daily check's ledger_mismatch rows, resolved rows, other types and a
// ref_id that only contains the string do not count; an app without a counted row has no key. A
// session whose every transaction is READ ONLY runs the port, so any write fails in PostgreSQL itself.
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { readCreditPostcheckOpen } from '../../../../../apps/api/src/modules/ledger/index.ts';
import { createMetricsRegistry } from '../../../../../apps/api/src/modules/platform/metrics/index.ts';
import { readOnlyUrl } from '../kit.ts';
import {
  OTHER_TYPES,
  REF_PREFIX,
  RESOLVED,
  creditPostcheckGauge,
  diffSnapshot,
  insertDiff,
  setDiffStatus,
} from './postcheck-harness.ts';

const TIMEOUT = 60_000;

async function open() {
  const database = await createTestDatabase();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  const readOnly = createDb({ connectionString: readOnlyUrl(database), max: 2 });
  return {
    db,
    readOnly,
    async close() {
      await destroyDb(readOnly);
      await destroyDb(db);
      await database.drop();
    },
  };
}

/** The app that does count, next to the ones that must not: the port is read, not just silent. */
const CONTROL = 'postcheck_control';

it(
  '[AC-B2-02v#12] 按 app_id 分别计数，值为数字：一个 app 多张未结单计多张，各 app 互不影响',
  async () => {
    const t = await open();
    try {
      await insertDiff(t.db, { appId: 'postcheck_three' });
      await insertDiff(t.db, { appId: 'postcheck_three' });
      await insertDiff(t.db, { appId: 'postcheck_three' });
      await insertDiff(t.db, { appId: 'postcheck_one' });

      expect(await readCreditPostcheckOpen(t.readOnly)).toEqual({
        open: { postcheck_three: 3, postcheck_one: 1 },
      });
    } finally {
      await t.close();
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-02v#13] 只数未结案 status ∈ {open, processing}：processing 与 open 同样计入，adjusted / written_off / closed 都不算；只有已结案状态的 app 没有样本，与未结案行同 app 时只数未结案行；processing 行同样要满足 type、ref_type、ref_id 前缀',
  async () => {
    const t = await open();
    try {
      await insertDiff(t.db, { appId: CONTROL });
      await insertDiff(t.db, { appId: 'postcheck_only_processing', status: 'processing' });
      await insertDiff(t.db, { appId: 'postcheck_mixed' });
      await insertDiff(t.db, { appId: 'postcheck_mixed', status: 'processing' });
      for (const status of RESOLVED) {
        await insertDiff(t.db, { appId: `postcheck_only_${status}`, status });
        await insertDiff(t.db, { appId: 'postcheck_mixed', status });
      }
      // Counting processing widens the status condition only; the other three still apply to it.
      await insertDiff(t.db, {
        appId: 'postcheck_processing_type',
        status: 'processing',
        type: 'union_mismatch',
      });
      await insertDiff(t.db, {
        appId: 'postcheck_processing_ref_type',
        status: 'processing',
        refType: 'order',
      });
      await insertDiff(t.db, {
        appId: 'postcheck_processing_ref_id',
        status: 'processing',
        refId: `voucher_sum_zero:${randomUUID()}`,
      });

      expect(await readCreditPostcheckOpen(t.readOnly)).toEqual({
        open: { [CONTROL]: 1, postcheck_only_processing: 1, postcheck_mixed: 2 },
      });
    } finally {
      await t.close();
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-02v#14] 只数 type=ledger_mismatch：别的 type 即使 status=open、ref_type=voucher、ref_id 带前缀也不算',
  async () => {
    const t = await open();
    try {
      await insertDiff(t.db, { appId: CONTROL });
      for (const type of OTHER_TYPES) {
        await insertDiff(t.db, { appId: `postcheck_type_${type}`, type });
      }

      expect(await readCreditPostcheckOpen(t.readOnly)).toEqual({ open: { [CONTROL]: 1 } });
    } finally {
      await t.close();
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-02v#15] 只数 ref_type=voucher：ref_id 带前缀但 ref_type 为 order / ledger_account 的 ledger_mismatch 不算',
  async () => {
    const t = await open();
    try {
      await insertDiff(t.db, { appId: CONTROL });
      for (const refType of ['order', 'ledger_account']) {
        await insertDiff(t.db, { appId: `postcheck_ref_${refType}`, refType });
      }

      expect(await readCreditPostcheckOpen(t.readOnly)).toEqual({ open: { [CONTROL]: 1 } });
    } finally {
      await t.close();
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-02v#16] ref_id 必须以 credit_postcheck: 开头：日终校验的 voucher 差错单、只是含这个串但不在开头、没有冒号、别的前缀、下划线换成别的字符（LIKE 通配）、大小写不同都不算',
  async () => {
    const t = await open();
    try {
      const voucher = randomUUID();
      const refIds: readonly (readonly [string, string])[] = [
        ['daily', `voucher_sum_zero:${voucher}`],
        ['inside', `voucher_sum_zero:${REF_PREFIX}${voucher}`],
        ['leading_space', ` ${REF_PREFIX}${voucher}`],
        ['no_colon', `credit_postcheck${voucher}`],
        ['longer_word', `credit_postcheck_v2:${voucher}`],
        ['like_wildcard', `creditXpostcheck:${voucher}`],
        ['upper_case', `CREDIT_POSTCHECK:${voucher}`],
      ];
      await insertDiff(t.db, { appId: CONTROL, refId: `${REF_PREFIX}${voucher}` });
      for (const [name, refId] of refIds) {
        await insertDiff(t.db, { appId: `postcheck_id_${name}`, refId });
      }

      expect(await readCreditPostcheckOpen(t.readOnly)).toEqual({ open: { [CONTROL]: 1 } });
    } finally {
      await t.close();
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-02v#17] 没有未结单的 app 没有样本（不是 0），端口不缓存：表空时为空；新增一张下一次读就加一，结案一张就减一，结案到 0 时样本消失',
  async () => {
    const t = await open();
    try {
      expect(await readCreditPostcheckOpen(t.readOnly), 'empty table').toEqual({ open: {} });

      const first = await insertDiff(t.db, { appId: CONTROL });
      expect(await readCreditPostcheckOpen(t.readOnly)).toEqual({ open: { [CONTROL]: 1 } });
      const second = await insertDiff(t.db, { appId: CONTROL });
      expect(await readCreditPostcheckOpen(t.readOnly)).toEqual({ open: { [CONTROL]: 2 } });

      await setDiffStatus(t.db, first, 'closed');
      expect(await readCreditPostcheckOpen(t.readOnly)).toEqual({ open: { [CONTROL]: 1 } });
      await setDiffStatus(t.db, second, 'closed');
      const { open: after } = await readCreditPostcheckOpen(t.readOnly);
      expect(Object.hasOwn(after, CONTROL), 'no sample once every diff is closed').toBe(false);
    } finally {
      await t.close();
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-02v#18] 只读：只读事务可跑、表的行前后不变；worker registry 以该端口渲染出同样的值',
  async () => {
    const t = await open();
    try {
      await insertDiff(t.db, { appId: CONTROL });
      await insertDiff(t.db, { appId: 'postcheck_read_only' });
      // The session really is read-only: the port cannot write behind the test's back.
      await expect(
        insertDiff(t.readOnly, { appId: CONTROL }),
        'fixture session must be read-only',
      ).rejects.toThrow(/read-only/);
      const before = await diffSnapshot(t.db);

      expect(await readCreditPostcheckOpen(t.readOnly)).toEqual({
        open: { [CONTROL]: 1, postcheck_read_only: 1 },
      });
      expect(await diffSnapshot(t.db), 'rows unchanged by the read').toEqual(before);

      const registry = createMetricsRegistry({
        entry: 'worker',
        collectCreditPostcheck: () => readCreditPostcheckOpen(t.readOnly),
      });
      expect(creditPostcheckGauge(await registry.render())).toEqual({
        [CONTROL]: 1,
        postcheck_read_only: 1,
      });
    } finally {
      await t.close();
    }
  },
  TIMEOUT,
);
