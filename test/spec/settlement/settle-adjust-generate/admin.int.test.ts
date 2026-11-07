// B2-09zb rule tests (claude-independent, SPEC_REF 18f0015): the manual trigger
// adminRunSettleAdjust (POST /admin/v1/settle-adjust-runs; 08 BR-FUND-09「finance 可手动触发」;
// CT-24zv; D10-769, D10-770). fund.settle_adjust (10403 data.reason=admin_permission_denied), totp
// step-up (10003 data.tier=totp), Idempotency-Key (same key same body → the first result, same key
// another body → 20901), bill_date after the current accounting day → 20001 data.fields=[bill_date];
// queues the scheduled run's job (queue settle, job settle_adjust, payload { app_id, platform,
// accounting_date: bill_date }, singletonKey settle_adjust:<app_id>:<platform>:<bill_date>; one still
// queued absorbs another) and answers { result: 'submitted' }; one audit record
// settle_adjust_run_request naming platform and bill_date. The request itself writes no candidate.
// Fixture clock: 2026-10-30 10:00 +08:00 (accounting day 2026-10-30).
import { expect, it } from 'vitest';
import {
  RUN_ACTION,
  answer,
  appJobs,
  audits,
  fixture,
  footprint,
  jobsUnder,
  newKey,
  runKey,
  suite,
  withRunAdmin,
} from './admin-harness.ts';

const s = suite();
const TIMEOUT = 180_000;
const BILL_DATE = '2026-10-24';

it(
  '[AC-B2-09zb#10] fund.settle_adjust + totp step-up：答 submitted（契约校验通过），settle 队列入队一条 settle_adjust（payload 与 singletonKey 正确），一条审计 settle_adjust_run_request（platform、bill_date）；请求本身不写候选、不写 settle_jobs',
  async () => {
    const f = fixture(s);
    await withRunAdmin(f, async (h) => {
      const before = await footprint(f);
      const sent = await h.run({ platform: 'taobao', bill_date: BILL_DATE });

      await answer(sent, 0, { result: 'submitted' });
      const jobs = await jobsUnder(f, runKey(f, 'taobao', BILL_DATE));
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        state: 'created',
        name: 'settle_adjust',
        payload: { app_id: f.appId, platform: 'taobao', accounting_date: BILL_DATE },
      });
      const records = await audits(f, RUN_ACTION);
      expect(records).toHaveLength(1);
      const record = records[0]!;
      expect(record.admin_id).toBe(h.adjuster.id);
      expect(record.at).toEqual(f.clock.now());
      const recorded = JSON.stringify([record.target, record.before, record.after]);
      expect(recorded).toContain('taobao');
      expect(recorded).toContain(BILL_DATE);
      expect(await footprint(f)).toEqual(before);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zb#10] 超管同样可以触发；bill_date 等于当前会计日可以',
  async () => {
    const f = fixture(s);
    await withRunAdmin(f, async (h) => {
      const root = await h.caller([], { superAdmin: true });
      await answer(await h.run({ platform: 'jd', bill_date: '2026-10-30' }, { caller: root }), 0, {
        result: 'submitted',
      });
      expect(await jobsUnder(f, runKey(f, 'jd', '2026-10-30'))).toHaveLength(1);
      expect((await audits(f, RUN_ACTION)).map((r) => r.admin_id)).toEqual([root.id]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zb#10] 无 fund.settle_adjust（只有 fund.view）→ 10403；缺 step-up 或 sms 档 → 10003（tier totp）；都不入队、不写审计',
  async () => {
    const f = fixture(s);
    await withRunAdmin(f, async (h) => {
      const body = { platform: 'taobao', bill_date: BILL_DATE };
      await answer(await h.run(body, { caller: h.viewer }), 10403, {
        reason: 'admin_permission_denied',
      });
      await answer(await h.run(body, { stepUp: null }), 10003, { tier: 'totp' });
      await answer(await h.run(body, { stepUp: await h.stepUp(h.adjuster, 'sms') }), 10003, {
        tier: 'totp',
      });
      expect(await appJobs(f)).toEqual([]);
      expect(await audits(f)).toEqual([]);

      // The same request with the permission and the step-up is served (the refusals above are
      // the checks of a mounted route, not a missing one).
      await answer(await h.run(body), 0, { result: 'submitted' });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zb#10] bill_date 晚于当前会计日 → 20001 data.fields=[bill_date]；不入队、不写审计',
  async () => {
    const f = fixture(s);
    await withRunAdmin(f, async (h) => {
      await answer(await h.run({ platform: 'taobao', bill_date: '2026-10-31' }), 20001, {
        fields: ['bill_date'],
      });
      expect(await appJobs(f)).toEqual([]);
      expect(await audits(f, RUN_ACTION)).toEqual([]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zb#10] 幂等：同键同体重放答第一次结果、不再入队不再审计；同键换体 → 20901',
  async () => {
    const f = fixture(s);
    await withRunAdmin(f, async (h) => {
      const key = newKey();
      const body = { platform: 'taobao', bill_date: BILL_DATE };
      const first = await answer(await h.run(body, { key }), 0, { result: 'submitted' });
      const replay = await answer(await h.run(body, { key }), 0, { result: 'submitted' });
      expect(replay.data).toEqual(first.data);
      expect(await audits(f, RUN_ACTION)).toHaveLength(1);
      expect(await jobsUnder(f, runKey(f, 'taobao', BILL_DATE))).toHaveLength(1);

      await answer(await h.run({ platform: 'taobao', bill_date: '2026-10-23' }, { key }), 20901);
      expect(await audits(f, RUN_ACTION)).toHaveLength(1);
      expect(await jobsUnder(f, runKey(f, 'taobao', '2026-10-23'))).toEqual([]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zb#10] 两次手动触发（不同幂等键）同一平台同一账单日：都答 submitted、各一条审计，队列里仍只有一条在排的 settle_adjust（singletonKey 吸收）',
  async () => {
    const f = fixture(s);
    await withRunAdmin(f, async (h) => {
      const body = { platform: 'taobao', bill_date: BILL_DATE };
      await answer(await h.run(body), 0, { result: 'submitted' });
      await answer(await h.run(body), 0, { result: 'submitted' });
      expect(await audits(f, RUN_ACTION)).toHaveLength(2);
      const live = (await jobsUnder(f, runKey(f, 'taobao', BILL_DATE))).filter((job) =>
        ['created', 'retry', 'active'].includes(job.state),
      );
      expect(live).toHaveLength(1);
      expect(live[0]).toMatchObject({
        name: 'settle_adjust',
        payload: { app_id: f.appId, platform: 'taobao', accounting_date: BILL_DATE },
      });
    });
  },
  TIMEOUT,
);
