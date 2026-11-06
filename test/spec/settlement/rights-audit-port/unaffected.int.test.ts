// B2-04zx（FU-B104ZZA-AUDIT-PORT，编排 D10-723）③：不需要重开的路径不受缺审计端口影响——缺端口的命令（即
// settlement/rights 与 rights-estimate 两个大夹具的建法）对 PROCESSING / WAIT_COMMISSION 的正常更新、结果的
// 正常落地、各种 duplicate 都照旧：结果与现行一致，不写审计行、不发该原因的告警。每条用例最后在同一订单上
// 另起一条 API 源 FAILED → 联盟报 SUCCEEDED 作对照：缺端口的命令必须拒绝它、什么都不写（只有它被拒）。
// 默认订单同 settlement/rights/record-credited：N 1000、预留 1500；应扣佣金 400 → 扣回四张凭证、键带 R{id}。
// 用例全部是顶层 it（规划/11 §4.3）。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  TIMEOUT,
  auditHarness,
  databaseFixture,
  keysOf,
  type AuditHarness,
  type RecordSpec,
  type SeededOrder,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

const KEPT_NO = 'kept-n1';
const OPEN_NO = 'open-n1';

interface Step {
  readonly spec: RecordSpec;
  readonly kind: 'applied' | 'duplicate';
}

interface PathCase {
  readonly label: string;
  readonly seed: (h: AuditHarness) => Promise<SeededOrder>;
  readonly steps: readonly Step[];
  /** What the steps leave, checked before the contrast. */
  readonly check: (h: AuditHarness, o: SeededOrder) => Promise<void>;
}

const credited = (h: AuditHarness) => h.credited();
const waiting = (h: AuditHarness) => h.order();

function api(spec: Omit<RecordSpec, 'source' | 'rightsNo'>): RecordSpec {
  return { source: 'API', rightsNo: KEPT_NO, ...spec };
}

function imported(spec: Omit<RecordSpec, 'source' | 'rightsNo'>): RecordSpec {
  return { source: 'IMPORT', rightsNo: KEPT_NO, ...spec };
}

/** The kept record is SUCCEEDED and clawed back once under R{its id}. */
async function clawedBack(h: AuditHarness, o: SeededOrder): Promise<void> {
  const row = await h.rightsOf(o, KEPT_NO);
  expect(row).toMatchObject({ status: 'SUCCEEDED', deduction_commission_fen: 400n });
  expect(await h.clawbackKeys(o)).toEqual(keysOf(o, `R${row.id}`));
  expect(await h.rebateColumns(o)).toMatchObject({
    rebate_status: 'CREDITED',
    booked_n_fen: 600n,
    rights_pending: false,
  });
}

/** The kept record has the given status and the order has no CLAWBACK voucher. */
function kept(status: string, rightsPending: boolean) {
  return async (h: AuditHarness, o: SeededOrder): Promise<void> => {
    expect(await h.rightsOf(o, KEPT_NO)).toMatchObject({ status });
    expect(await h.clawbackKeys(o)).toEqual([]);
    expect((await h.read(o)).rights_pending).toBe(rightsPending);
  };
}

const CASES: readonly PathCase[] = [
  {
    label: '入账后 API PROCESSING → SUCCEEDED（应扣佣金 400）：applied、applied，扣回一次',
    seed: credited,
    steps: [
      { spec: api({ status: 'PROCESSING', deductionFen: null }), kind: 'applied' },
      { spec: api({ status: 'SUCCEEDED', deductionFen: 400n }), kind: 'applied' },
    ],
    check: clawedBack,
  },
  {
    label: '入账后 API PROCESSING → FAILED：applied、applied，不扣回、rights_pending 解除',
    seed: credited,
    steps: [
      { spec: api({ status: 'PROCESSING', deductionFen: null }), kind: 'applied' },
      { spec: api({ status: 'FAILED', deductionFen: 400n }), kind: 'applied' },
    ],
    check: kept('FAILED', false),
  },
  {
    label:
      '入账后导入 SUCCEEDED 无应扣佣金（WAIT_COMMISSION）→ 同一单号给出 400：applied、applied，扣回一次',
    seed: credited,
    steps: [
      { spec: imported({ status: 'SUCCEEDED', deductionFen: null }), kind: 'applied' },
      { spec: imported({ status: 'SUCCEEDED', deductionFen: 400n }), kind: 'applied' },
    ],
    check: clawedBack,
  },
  {
    label: '入账后 WAIT_COMMISSION 期间同一结果重放：applied、duplicate',
    seed: credited,
    steps: [
      { spec: imported({ status: 'SUCCEEDED', deductionFen: null }), kind: 'applied' },
      { spec: imported({ status: 'SUCCEEDED', deductionFen: null }), kind: 'duplicate' },
    ],
    check: kept('WAIT_COMMISSION', true),
  },
  {
    label: '入账后 API SUCCEEDED 重放：applied、duplicate，只扣一次',
    seed: credited,
    steps: [
      { spec: api({ status: 'SUCCEEDED', deductionFen: 400n }), kind: 'applied' },
      { spec: api({ status: 'SUCCEEDED', deductionFen: 400n }), kind: 'duplicate' },
    ],
    check: clawedBack,
  },
  {
    label: '入账后 API SUCCEEDED 之后报 FAILED（成功后回退）：applied、duplicate',
    seed: credited,
    steps: [
      { spec: api({ status: 'SUCCEEDED', deductionFen: 400n }), kind: 'applied' },
      { spec: api({ status: 'FAILED', deductionFen: 400n }), kind: 'duplicate' },
    ],
    check: clawedBack,
  },
  {
    label: '入账后导入 FAILED 之后联盟报成功：applied、duplicate',
    seed: credited,
    steps: [
      { spec: imported({ status: 'FAILED', deductionFen: 400n }), kind: 'applied' },
      { spec: api({ status: 'SUCCEEDED', deductionFen: 400n }), kind: 'duplicate' },
    ],
    check: kept('FAILED', false),
  },
  {
    // 评审 r1 S1：重开要求新来的也是 API 源；导入源的成功不触发重开，缺端口也不抛错。
    label: '入账后 API FAILED 之后同一单号以导入源报 SUCCEEDED（应扣佣金 400）：applied、duplicate',
    seed: credited,
    steps: [
      { spec: api({ status: 'FAILED', deductionFen: 400n }), kind: 'applied' },
      { spec: imported({ status: 'SUCCEEDED', deductionFen: 400n }), kind: 'duplicate' },
    ],
    check: kept('FAILED', false),
  },
  {
    label: '入账后 API FAILED 之后报 PROCESSING：applied、duplicate',
    seed: credited,
    steps: [
      { spec: api({ status: 'FAILED', deductionFen: 400n }), kind: 'applied' },
      { spec: api({ status: 'PROCESSING', deductionFen: null }), kind: 'duplicate' },
    ],
    check: kept('FAILED', false),
  },
  {
    label: '入账后 API FAILED 之后报成功而无应扣佣金（会落 WAIT_COMMISSION）：applied、duplicate',
    seed: credited,
    steps: [
      { spec: api({ status: 'FAILED', deductionFen: 400n }), kind: 'applied' },
      { spec: api({ status: 'SUCCEEDED', deductionFen: null }), kind: 'duplicate' },
    ],
    check: kept('FAILED', false),
  },
  {
    label: '入账后 API FAILED 重放：applied、duplicate',
    seed: credited,
    steps: [
      { spec: api({ status: 'FAILED', deductionFen: 400n }), kind: 'applied' },
      { spec: api({ status: 'FAILED', deductionFen: 400n }), kind: 'duplicate' },
    ],
    check: kept('FAILED', false),
  },
  {
    label: '入账前（WAITING）API PROCESSING → FAILED：applied、applied，返利状态不变',
    seed: waiting,
    steps: [
      { spec: api({ status: 'PROCESSING', deductionFen: null }), kind: 'applied' },
      { spec: api({ status: 'FAILED', deductionFen: 400n }), kind: 'applied' },
    ],
    check: async (h, o) => {
      await kept('FAILED', false)(h, o);
      expect((await h.read(o)).rebate_status).toBe('WAITING');
    },
  },
];

it.each(CASES)(
  '[AC-B2-04zx#6] 缺审计端口、$label；不写审计行、无该原因告警；对照：同一订单另一条 API 源 FAILED → 联盟报 SUCCEEDED（应扣佣金 100）被缺端口的命令拒绝，什么都不写',
  async ({ seed, steps, check }) => {
    const h = await auditHarness(p.db);
    const o = await seed(h);
    for (const step of steps) {
      const answered = await h.attempt(h.bare(), o, step.spec);
      expect(answered.error).toBeUndefined();
      expect(answered.result).toEqual({ kind: step.kind });
      if (step.kind === 'duplicate') expect(answered.after).toEqual(answered.before);
    }
    await check(h, o);
    expect(await h.audits()).toEqual([]);
    expect(h.reasonAlerts()).toEqual([]);

    // 对照：只有 D10-699 的重开被缺端口的命令拒绝。
    expect(
      await h.commit(h.bare(), o, {
        source: 'API',
        status: 'FAILED',
        deductionFen: 100n,
        rightsNo: OPEN_NO,
      }),
    ).toEqual({ kind: 'applied' });
    const committed = await h.appState();
    const refused = await h.attempt(h.bare(), o, {
      source: 'API',
      status: 'SUCCEEDED',
      deductionFen: 100n,
      rightsNo: OPEN_NO,
    });
    expect(refused.result).toBeUndefined();
    expect(refused.error).toBeInstanceOf(Error);
    expect(refused.after).toEqual(refused.before);
    expect(await h.appState()).toEqual(committed);
    expect(await h.audits()).toEqual([]);
    expect(h.reasonAlerts()).toEqual([]);
  },
  TIMEOUT,
);
