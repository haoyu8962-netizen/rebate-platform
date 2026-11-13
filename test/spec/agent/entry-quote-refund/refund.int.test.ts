// B3-05r · BR-AI-15: real HTTP admission → orchestrator → RunManager → PG finalization.
// Reuse the existing integration database kit and synthetic business ports. Never replace
// shouldRefund, admission, the run manager, or PG finalization. A prior successful entry run
// gives every quota key nonzero usage; observe the second charge before its quote finishes.
// The baseline may already satisfy these rules (task §9): do not manufacture a red result.
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import { OFF_SHELF, ParsingError } from '../../../../apps/api/src/modules/parsing/index.ts';
import { GovernanceError } from '../../../../apps/api/src/modules/platform/http/index.ts';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import { fixture } from '../stream-assembly/kit.ts';
import {
  framesOf,
  message,
  newGuest,
  openSession,
  send,
  usePgEach,
  type Frame,
  type Row,
} from '../stream-mount/kit.ts';
import { scriptModel } from '../trace-persist/kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

const ENTRY_KEY = 'tb:synthetic-cup';
const SEED = '先看看这个商品';
const QUESTION = '这个值得买吗';
const ANSWER = '可以先看看商品说明再决定。';
const DAY = '2026-10-06';

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Rig = ReturnType<Fixture['mount']>;
type Tier = 'member' | 'guest';
type Fault = 'timeout' | '5xx' | 'circuit_open';

function upstreamFailure(fault: Fault): Error {
  // Normalized errors at the catalog port, not invented platform response bodies.
  return fault === '5xx'
    ? new UnionError('upstream_unavailable', 'synthetic upstream HTTP 503', 'taobao')
    : new GovernanceError(fault, 'union:taobao:online', `synthetic ${fault}`);
}

function quotaKeys(f: Fixture): string[] {
  return f.caller.phoneBound
    ? [JSON.stringify(['member', f.caller.userId])]
    : [JSON.stringify(['device', f.caller.deviceHash]), JSON.stringify(['ip', f.caller.ipKey])];
}

async function usage(f: Fixture, day = DAY): Promise<number[]> {
  return Promise.all(
    quotaKeys(f).map(async (key) => {
      const result = await sql<{ n: string }>`SELECT count(*) AS n FROM app.agent_runs
        WHERE app_id = ${f.caller.appId} AND ${key} = ANY(quota_subjects)
          AND (accepted_at AT TIME ZONE 'Asia/Shanghai')::date = ${day}::date
          AND settle_result IS DISTINCT FROM 'refunded'`.execute(pg.db);
      return Number(result.rows[0]!.n);
    }),
  );
}

function cards(frames: readonly Frame[]): Frame[] {
  return frames.filter((frame) => frame.event === 'card');
}

function terminal(frames: readonly Frame[]): Frame {
  const endings = frames.filter((frame) => frame.event === 'error' || frame.event === 'done');
  expect(endings).toHaveLength(1);
  expect(frames.at(-1)).toEqual(endings[0]);
  return endings[0]!;
}

async function persisted(f: Fixture, frames: readonly Frame[], refunded: boolean): Promise<void> {
  const meta = frames.find((frame) => frame.event === 'meta');
  expect(meta?.data['run_id']).toBeTypeOf('string');
  const rows = await pg.db
    .selectFrom('agent_runs')
    .selectAll()
    .where('app_id', '=', f.caller.appId)
    .where('id', '=', meta!.data['run_id'] as string)
    .execute();
  expect(rows).toHaveLength(1);
  const end = terminal(frames);
  expect(rows[0]).toMatchObject({
    end_reason: refunded ? 'server_error' : 'stop',
    settle_result: refunded ? 'refunded' : 'counted',
    card_delivered: false,
    finish_reason: refunded ? 'error' : 'stop',
    quota_subjects: quotaKeys(f),
    final_event: { type: end.event, data: end.data },
  });
  expect(rows[0]?.settled_at).not.toBeNull();
  expect(rows[0]?.ended_at).not.toBeNull();
  expect(cards(frames).filter((frame) => frame.data['type'] !== 'notice')).toEqual([]);
}

interface Scenario {
  readonly f: Fixture;
  readonly r: Rig;
  readonly sessionId: string;
  readonly before: number[];
  readonly complete: ReturnType<typeof scriptModel> | undefined;
  submit(body?: Row): Promise<Frame[]>;
}

async function withScenario(
  tier: Tier,
  model: boolean,
  check: (scenario: Scenario) => Promise<void>,
  // D10-1506 夹具机械修：seed=false 时不发种子消息，会话里没有先前的报价卡；默认保持原行为。
  { seed: withSeed = true }: { readonly seed?: boolean } = {},
): Promise<void> {
  const caller = tier === 'guest' ? await newGuest(pg.db) : undefined;
  const f = await fixture(pg.db, caller);
  // The runtime currently fixes its model route to no_model. This existing fixture wraps only
  // the real core factory's model/prompt/review ports; all admission and settlement remain real.
  const complete = model
    ? scriptModel({ [SEED]: [{ text: ANSWER }], [QUESTION]: [{ text: ANSWER }] })
    : undefined;
  const r = f.mount(f.build());
  try {
    const sessionId = await openSession(r, f.caller);
    if (withSeed) {
      const seed = framesOf(
        (
          await send(r, f.caller, sessionId, {
            ...message(SEED),
            context: { product_key: ENTRY_KEY },
          })
        ).chunks,
      );
      expect(terminal(seed)).toMatchObject({ event: 'done', data: { finish_reason: 'stop' } });
      expect(cards(seed).map((frame) => frame.data['type'])).toEqual(['rebate_quote']);
    }
    const before = await usage(f);
    // D10-1506 夹具机械修：不发种子时当日计数基线为 0。
    const base = withSeed ? 1 : 0;
    expect(before).toEqual(tier === 'member' ? [base] : [base, base]);
    f.readProduct.mockClear();
    complete?.mockClear();
    await check({
      f,
      r,
      sessionId,
      before,
      complete,
      async submit(body = { ...message(QUESTION), context: { product_key: ENTRY_KEY } }) {
        return framesOf((await send(r, f.caller, sessionId, body)).chunks);
      },
    });
  } finally {
    await r.runtime.close();
  }
}

it.each([
  { ac: 1, tier: 'member', fault: 'timeout' },
  { ac: 2, tier: 'member', fault: '5xx' },
  { ac: 3, tier: 'member', fault: 'circuit_open' },
  { ac: 4, tier: 'guest', fault: 'timeout' },
  { ac: 5, tier: 'guest', fault: '5xx' },
  { ac: 6, tier: 'guest', fault: 'circuit_open' },
] as const)(
  '[AC-B3-05r#$ac][BR-AI-15] 无模型商品入口 $tier / $fault：50401、retryable=false，退回所有日计数；同键重放不再扣退',
  async ({ tier, fault }) => {
    await withScenario(tier, false, async ({ f, before, submit }) => {
      let during: number[] | undefined;
      f.readProduct.mockImplementation(async () => {
        during = await usage(f);
        throw upstreamFailure(fault);
      });
      const body = { ...message(QUESTION), context: { product_key: ENTRY_KEY } };
      const frames = await submit(body);
      expect(during).toEqual(before.map((n) => n + 1));
      expect(f.readProduct).toHaveBeenCalledTimes(1);
      expect(f.readProduct.mock.calls[0]?.[0]).toBe(ENTRY_KEY);
      expect(terminal(frames)).toMatchObject({
        event: 'error',
        data: { code: 50401, retryable: false },
      });
      expect(cards(frames)).toEqual([]);
      expect(f.searchProducts).not.toHaveBeenCalled();
      await persisted(f, frames, true);
      expect(await usage(f)).toEqual(before);

      const replay = await submit(body);
      expect(terminal(replay).event).toBe('error');
      expect(terminal(replay).data).toEqual(terminal(frames).data);
      expect(f.readProduct).toHaveBeenCalledTimes(1);
      expect(await usage(f)).toEqual(before);
      const runs = await pg.db.selectFrom('agent_runs').select('id').execute();
      expect(runs).toHaveLength(2);
    });
  },
  120_000,
);

it.each([
  { ac: 7, result: 'off_shelf', notice: `error.${String(OFF_SHELF)}` },
  { ac: 8, result: 'price_unavailable', notice: 'error.50301' },
] as const)(
  '[AC-B3-05r#$ac][BR-AI-15] 无模型入口业务结果 $result：notice、stop，会员日计数保留 +1',
  async ({ result, notice }) => {
    await withScenario('member', false, async ({ f, before, submit }) => {
      let during: number[] | undefined;
      f.readProduct.mockImplementation(async () => {
        during = await usage(f);
        if (result === 'off_shelf') throw new ParsingError(OFF_SHELF, 'synthetic delisted item');
        return f.state.row;
      });
      if (result === 'price_unavailable') {
        // Real catalog card entry answers price_unavailable for a normalized anomalous price.
        f.state.row = { ...f.state.row, item: { ...f.state.row.item, price_status: 'anomaly' } };
      }
      const frames = await submit();
      expect(during).toEqual(before.map((n) => n + 1));
      expect(f.readProduct.mock.calls.map(([key]) => key)).toEqual([ENTRY_KEY]);
      expect(cards(frames)).toHaveLength(1);
      expect(cards(frames)[0]?.data).toMatchObject({ type: 'notice', data: { text_key: notice } });
      expect(terminal(frames)).toMatchObject({
        event: 'done',
        data: { finish_reason: 'stop', quota_left: 28 },
      });
      await persisted(f, frames, false);
      expect(await usage(f)).toEqual(before.map((n) => n + 1));
      expect(f.searchProducts).not.toHaveBeenCalled();
    });
  },
  120_000,
);

it('[AC-B3-05r#9][BR-AI-15] 有模型入口报价服务端失败：quote_failed notice 后正常答复、stop，计数 +1', async () => {
  await withScenario(
    'member',
    true,
    async ({ f, before, complete, submit }) => {
      f.readProduct.mockRejectedValue(upstreamFailure('timeout'));
      const frames = await submit();
      expect(f.readProduct.mock.calls.map(([key]) => key)).toEqual([ENTRY_KEY]);
      expect(cards(frames)).toHaveLength(1);
      expect(cards(frames)[0]?.data).toMatchObject({
        type: 'notice',
        data: { text_key: 'agent.notice.quote_failed' },
      });
      expect(complete).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(complete?.mock.calls[0]?.[0].messages)).toContain(QUESTION);
      const textFrames = frames.filter((frame) => frame.event === 'text.delta');
      expect(textFrames.map((frame) => frame.data['delta']).join('')).toBe(ANSWER);
      expect(frames.indexOf(cards(frames)[0]!)).toBeLessThan(frames.indexOf(textFrames[0]!));
      expect(terminal(frames)).toMatchObject({
        event: 'done',
        // D10-1506 夹具机械修：不发种子消息，本轮是当日第 1 次计数，余量 29（原 28 含种子那 1 次）。
        data: { finish_reason: 'stop', quota_left: 29 },
      });
      await persisted(f, frames, false);
      expect(await usage(f)).toEqual(before.map((n) => n + 1));
    },
    // D10-1506 夹具机械修：在没有先前报价卡的新会话里跑，避免既有的 title_based 提示多出一张卡。
    { seed: false },
  );
}, 120_000);

it('[AC-B3-05r#10][BR-AI-15] 入口报价失败且主备模型均失败、没有产出：notice 不算出卡，50401 并退回 1 条', async () => {
  await withScenario('member', true, async ({ f, before, complete, submit }) => {
    f.readProduct.mockRejectedValue(upstreamFailure('timeout'));
    // The model gateway's exhausted-primary-and-backup outcome; no live model calls.
    complete!.mockResolvedValue({ kind: 'degraded', reason: 'models_failed', attempts: [] });
    const frames = await submit();
    expect(f.readProduct.mock.calls.map(([key]) => key)).toEqual([ENTRY_KEY]);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(cards(frames)).toHaveLength(1);
    expect(cards(frames)[0]?.data).toMatchObject({
      type: 'notice',
      data: { text_key: 'agent.notice.quote_failed' },
    });
    expect(frames.filter((frame) => frame.event === 'text.delta')).toEqual([]);
    expect(terminal(frames)).toMatchObject({
      event: 'error',
      data: { code: 50401, retryable: false },
    });
    expect(f.searchProducts).not.toHaveBeenCalled();
    await persisted(f, frames, true);
    expect(await usage(f)).toEqual(before);
  });
}, 120_000);
