// B2-18 第 9 次写测（任务书 §17.2；资金评审第 5 轮 S1 ②，负责人 2026-11-25；B2-02zf 的只写登记口
// registerReconDiffWriteOnly）：月结与补充登记 union_mismatch（联盟有结算而我方 ESTIMATED / VOID / CLAWED_BACK 或无单，
// BR-FUND-09）改接只写登记口——同一账单同一订单再次登记只发一条 INSERT … ON CONFLICT DO NOTHING、冲突即返回，不回读
// 差错单表（现有 registerReconDiff 冲突后经 findExisting 回读整行，含 resolution）。入参形状照主干 bill/job.ts 的
// diffInput：type union_mismatch、source R1、period = 账单号、ref_type order、ref_id = 订单键、dedupe_key 与 resolution
// 为 null。
//
// 生产装配：账单日经 worker 的 settle 处理器（./kit.ts withWorker），补充经后台入口（./kit.ts withSupplementAdmin）；
// 两者的数据库执行器都装 ./kit.ts reconDiffsReadFault（凡是读 recon_diffs 的语句一执行就计数并抛错，纯写入的
// INSERT … VALUES / ON CONFLICT DO NOTHING 不算读；判定见 kit isReconDiffsRead）。只读库执行器的做法同
// ./supplement.int.test.ts [AC-B2-18#33]：独立的插件实例，包在同一个 base.db 上（本用例的库来自别的目录的冻结 Suite，
// 拿不到只读角色的连接串）——要证明的是后台入口拿到的只读库句柄上一旦读这张表就会被拦下并计数。
// 夹具：后台夹具的应用（../admin-settle-commands/kit.ts fixture，Clock 定在账单日 2032-07-24 10:00 +08:00，资产快照已
// 超时、可出账）上的真实订单行（./kit.ts seedOrder），再置为我方 VOID（./kit.ts voidOrder，与 seedOrder 同一种直接
// 造行的做法）；账单里只有这一张不入批的单，所以月结不产生草稿批次，补充不会被 pending_draft 拒绝。
// 自拟金额：联盟结算佣金 1000（STATEMENT seq 1），快照 N 1000（预留 0）——作废单不比金额，金额只出现在差错单上。
// 顶层 it()（规划/11 §4.3）。
import { expect, it } from 'vitest';
import { fixture, suite, type Fixture } from '../admin-settle-commands/kit.ts';
import {
  BILL_DAY,
  EXAMPLE_PEOPLE,
  TIMEOUT,
  app,
  billRow,
  countsOf,
  creditOn,
  diffsOf,
  errorText,
  reconDiffsReadFault,
  seedOrder,
  settlementOnly,
  voidOrder,
  withSupplementAdmin,
  withWorker,
  within,
  type App,
  type LogLine,
  type Outcome,
  type Seeded,
} from './kit.ts';

const s = suite();
/** 后台夹具的 Clock：账单日 10:00 +08:00（与 ./kit.ts 的 app 缺省 Clock 同一时刻）。 */
const AT_BILL_DAY = `${BILL_DAY}T10:00:00+08:00`;
const TAOBAO = { platform: 'taobao' };

function shown(outcome: Outcome<unknown> | undefined): string {
  if (outcome === undefined) return 'not run';
  return outcome.ok ? 'ok' : errorText(outcome.error);
}

/** 账单月 2032-06 的应用（appId 与 Clock 取后台夹具的），入账开关 on（补充要求）。 */
async function appOf(f: Fixture): Promise<App> {
  const a = await app(f.db, { appId: f.appId, clock: f.clock });
  await creditOn(a);
  return a;
}

/** 登记出来的 union_mismatch 应有的形状（BR-FUND-09；入参照 bill/job.ts diffInput）。 */
function unionMismatchOf(a: App, o: Seeded) {
  return {
    app_id: a.appId,
    type: 'union_mismatch',
    source: 'R1',
    period: a.period,
    ref_type: 'order',
    ref_id: o.orderKey,
    dedupe_key: null,
    resolution: null,
    status: 'open',
  };
}

interface Executor {
  readonly executed: number;
  readonly fired: number;
  readonly violations: readonly string[];
  readonly statements: number;
}

/** 一个 reconDiffsReadFault 此刻的计数（取数）。 */
function snapshotOf(fault: ReturnType<typeof reconDiffsReadFault>): Executor {
  return {
    executed: fault.executed,
    fired: fault.fired,
    violations: [...fault.violations],
    statements: fault.statements,
  };
}

interface AdminSeen {
  status?: number;
  body?: string;
  lines: LogLine[];
  readHandle?: unknown;
}

/** 经后台入口对账单 a.period 发起一次补充（主库执行器 main、只读库执行器 readOnly），只发请求与取数。 */
async function supplementVia(
  base: Fixture,
  a: App,
  main: ReturnType<typeof reconDiffsReadFault>,
  readOnly: ReturnType<typeof reconDiffsReadFault>,
): Promise<AdminSeen> {
  const seen: AdminSeen = { lines: [] };
  const f: Fixture = { ...base, db: main.db };
  await withSupplementAdmin(
    f,
    async (h) => {
      seen.readHandle = h.resolvedDbRead();
      const sent = await h.supplement(a.period, TAOBAO);
      seen.status = sent.statusCode;
      seen.body = sent.body;
      seen.lines = h.lines;
    },
    { dbRead: readOnly.db },
  );
  return seen;
}

it(
  '[AC-B2-18#43] 只写登记口（新插入与重放写在同一个 it）：前半——生产装配的账单日（worker，执行器装 reconDiffsReadFault）遇「联盟有结算、我方 VOID」的单：登记恰一张 union_mismatch（period = 账单号、ref_type order、ref_id = 订单键、dedupe_key 与 resolution 为 NULL、status open），error_count 1，主库执行器上对 recon_diffs 的读取为零；后半——对同一账单经后台入口发起补充（主库与只读库两个执行器都注入），那张 VOID 单仍在来源里：请求 200，差错单仍恰一张且与前半读到的那一行逐字段相同，两个执行器在请求期间 executed / fired 增量都是 0、新增违规为空，主库执行器语句数增加，只读库令牌解析到的就是注入的执行器',
  async () => {
    const base = fixture(s, AT_BILL_DAY);
    const a = await appOf(base);
    const o = await seedOrder(a, { snapshotN: 1000n, settleFen: 1000n, people: EXAMPLE_PEOPLE });
    await voidOrder(a, o);
    const main = reconDiffsReadFault(base.db);

    // 前半：账单日（worker 回调里只投递与取数）。
    const billed: { outcome?: Outcome<void> } = {};
    await withWorker(
      a,
      async (w) => {
        billed.outcome = await within(w.bill(), 'bill');
      },
      { db: main.db },
    );
    const afterBill = snapshotOf(main);
    const firstDiffs = await diffsOf(a);
    const countsAfterBill = await countsOf(a);
    const billAfterBill = await billRow(a);

    expect(shown(billed.outcome)).toBe('ok');
    expect(firstDiffs).toEqual([expect.objectContaining(unionMismatchOf(a, o))]);
    expect(countsAfterBill.error_count).toBe(1);
    expect({
      executed: afterBill.executed,
      fired: afterBill.fired,
      violations: afterBill.violations,
    }).toEqual({ executed: 0, fired: 0, violations: [] });

    // 后半：对同一账单发起补充（重放登记）。
    const readOnly = reconDiffsReadFault(base.db);
    const seen = await supplementVia(base, a, main, readOnly);

    expect(seen.status, seen.body).toBe(200);
    expect(await diffsOf(a)).toEqual(firstDiffs);
    expect(main.violations.slice(afterBill.executed)).toEqual([]);
    expect(main.executed - afterBill.executed).toBe(0);
    expect(main.fired - afterBill.fired).toBe(0);
    expect(main.statements).toBeGreaterThan(afterBill.statements);
    expect(readOnly.violations).toEqual([]);
    expect(readOnly.executed).toBe(0);
    expect(readOnly.fired).toBe(0);
    expect(seen.readHandle).toBe(readOnly.db);
    // 补充不写账单计数列。
    expect(await billRow(a)).toEqual(billAfterBill);
  },
  TIMEOUT,
);

it(
  '[AC-B2-18#44] 补充自己的新插入：账单日那次这张 VOID 单还没有联盟结算（不在账单里、不登记），之后联盟结算数据才到（STATEMENT seq 1 结算 1000，订单状态不动）；对同一账单经后台入口发起补充（主库与只读库两个执行器都注入 reconDiffsReadFault）：请求 200，首次登记 union_mismatch 恰一张、字段同 #43，两个执行器零读取（executed / fired 为 0、违规为空），主库执行器上有语句经过、只读库令牌解析到注入的执行器；账单行（含 error_count）不回写',
  async () => {
    const base = fixture(s, AT_BILL_DAY);
    const a = await appOf(base);
    const o = await seedOrder(a, { snapshotN: 1000n, settleFen: null, people: EXAMPLE_PEOPLE });
    await voidOrder(a, o);

    const billed: { outcome?: Outcome<void> } = {};
    await withWorker(a, async (w) => {
      billed.outcome = await within(w.bill(), 'bill');
    });
    const diffsAfterBill = await diffsOf(a);
    const billAfterBill = await billRow(a);
    await settlementOnly(a, o, { seq: 1, source: 'STATEMENT', fen: 1000n });

    const main = reconDiffsReadFault(base.db);
    const readOnly = reconDiffsReadFault(base.db);
    const seen = await supplementVia(base, a, main, readOnly);

    expect(shown(billed.outcome)).toBe('ok');
    expect(diffsAfterBill).toEqual([]);
    expect(seen.status, seen.body).toBe(200);
    expect(await diffsOf(a)).toEqual([expect.objectContaining(unionMismatchOf(a, o))]);
    expect(snapshotOf(main)).toMatchObject({ executed: 0, fired: 0, violations: [] });
    expect(main.statements).toBeGreaterThan(0);
    expect(snapshotOf(readOnly)).toMatchObject({ executed: 0, fired: 0, violations: [] });
    expect(seen.readHandle).toBe(readOnly.db);
    expect(await billRow(a)).toEqual(billAfterBill);
  },
  TIMEOUT,
);
