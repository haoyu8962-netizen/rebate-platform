import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { createInputCheck } from '../../../../apps/api/src/modules/agent/preprocess/input/index.ts';
import {
  createAgentStreamAssembly,
  createAgentStreamRuntime,
} from '../../../../apps/api/src/modules/agent/stream/mount/index.ts';
import { productionRunTexts } from '../../../../apps/api/src/modules/agent/stream/mount/production.ts';
import type { RunBodyResult } from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import { fixture, LINK } from '../stream-assembly/kit.ts';
import {
  contentReaderFor,
  framesOf,
  LEVEL,
  message,
  newGuest,
  openSession,
  send,
  usePgEach,
  type Frame,
} from '../stream-mount/kit.ts';
import { DAY, fileErrorMsg, proc, runRow, sendLive, sessionRow } from '../stream-recovery/kit.ts';
import { upstreamFailure } from './faults.ts';

const pg = usePgEach(createTestDatabase);
const OTHER_LINK = 'https://demo.invalid/taobao/another-synthetic-item';
type Fixture = Awaited<ReturnType<typeof fixture>>;

function mountWithInputCheck(f: Fixture) {
  const { clock, scheduler } = f.time;
  const { logger } = f.logs;
  const texts = productionRunTexts(async () => [], logger);
  const assembly = createAgentStreamAssembly({ ...f.deps, texts });
  const inputCheck = createInputCheck({ review: { review: async () => 'pass' }, scheduler, texts });
  const runtime = createAgentStreamRuntime(
    {
      db: pg.db,
      clock,
      logger,
      contentReader: contentReaderFor(pg.db, clock),
      consentReader: f.consentReader,
      assembly: () => assembly,
    },
    { inputCheck, schedule: scheduler },
  );
  return { runtime, time: f.time, logs: f.logs };
}

async function usage({ caller }: Fixture): Promise<number[]> {
  const subjects = caller.phoneBound
    ? [['member', caller.userId]]
    : [
        ['device', caller.deviceHash],
        ['ip', caller.ipKey],
      ];
  return Promise.all(
    subjects.map(async (subject) => {
      const key = JSON.stringify(subject);
      const result = await sql<{ n: string }>`SELECT count(*) AS n FROM app.agent_runs
        WHERE app_id = ${caller.appId} AND ${key} = ANY(quota_subjects)
          AND (accepted_at AT TIME ZONE 'Asia/Shanghai')::date = ${DAY}::date
          AND settle_result IS DISTINCT FROM 'refunded'`.execute(pg.db);
      return Number(result.rows[0]!.n);
    }),
  );
}

function terminal(frames: readonly Frame[]): Frame {
  const endings = frames.filter(({ event }) => event === 'done' || event === 'error');
  expect(endings).toHaveLength(1);
  expect(frames.at(-1)).toEqual(endings[0]);
  return endings[0]!;
}

async function validDemoUrl(f: Fixture): Promise<string> {
  const sample = await f.demo.searchItems(
    { keyword: '演示商品' },
    { appId: f.caller.appId, requestId: f.caller.traceId, purpose: 'online' },
  );
  const itemId = sample.items[0]?.item_id;
  expect(itemId).toBeTypeOf('string');
  return `https://demo.invalid/taobao/${encodeURIComponent(itemId!)}`;
}

const serverTerminal = {
  event: 'error',
  data: { code: 50401, retryable: false, fallback: null, fallback_q: null },
};

it.each([
  { ac: 1, guest: false, remaining: 'server', withLimit: false, label: '会员全部服务端失败' },
  { ac: 2, guest: true, remaining: 'server', withLimit: false, label: '游客全部服务端失败' },
  { ac: 3, guest: false, remaining: 'quote', withLimit: false, label: '部分服务端失败、其余出卡' },
  {
    ac: 4,
    guest: false,
    remaining: 'no_rebate',
    withLimit: false,
    label: '部分服务端失败、其余无返利',
  },
  {
    ac: 5,
    guest: false,
    remaining: 'server',
    withLimit: true,
    label: '有输入超限提示、每次报价都是服务端失败',
  },
] as const)(
  '[AC-B3-05u#8#$ac] $label，经真实 SSE 和 PG 结算',
  async ({ guest, remaining, withLimit }) => {
    const f = await fixture(pg.db, guest ? await newGuest(pg.db) : undefined);
    const refunded = remaining === 'server';
    const secondLink = refunded ? OTHER_LINK : await validDemoUrl(f);
    const attempted = [LINK, secondLink];
    if (withLimit) attempted.push('https://demo.invalid/taobao/third-synthetic-item');
    let charged: number[] | undefined;
    f.resolveLink.mockImplementationOnce(async () => {
      charged = await usage(f);
      throw upstreamFailure('timeout');
    });
    if (refunded) f.resolveLink.mockRejectedValue(upstreamFailure('5xx'));
    if (remaining === 'no_rebate') {
      f.quote.mockResolvedValue({
        rebateMinFen: 0n,
        rebateMaxFen: 0n,
        estNetPriceFen: null,
        rebateBasis: 'no_rebate',
      });
    }

    const r = mountWithInputCheck(f);
    try {
      const sessionId = await openSession(r, f.caller);
      const dropped = withLimit ? ['https://demo.invalid/taobao/fourth-synthetic-item'] : [];
      const body = message([...attempted, ...dropped].join(' '));
      const before = await usage(f);
      expect(before).toEqual(guest ? [0, 0] : [0]);
      const reply = await send(r, f.caller, sessionId, body);
      expect(reply.jsons).toEqual([]);
      const frames = framesOf(reply.chunks);
      expect(f.resolveLink.mock.calls.map(([raw]) => raw)).toEqual(attempted);
      expect(charged).toEqual(before.map((count) => count + 1));
      const end = terminal(frames);
      const cards = frames.filter(({ event }) => event === 'card');
      const quoted = remaining === 'quote';
      if (refunded) {
        expect(end).toMatchObject(serverTerminal);
        expect(end.data['msg']).toBe(fileErrorMsg(50401));
        expect(cards.map(({ data }) => data)).toEqual(
          withLimit
            ? [
                expect.objectContaining({
                  type: 'notice',
                  data: expect.objectContaining({ text_key: 'agent.notice.link_limit' }),
                }),
              ]
            : [],
        );
        expect(
          frames.filter(({ event }) => event === 'tool.status').map(({ data }) => data['phase']),
        ).toEqual(attempted.flatMap(() => ['start', 'failed']));
        expect(r.logs.all().filter(({ level }) => level === LEVEL.error)).toHaveLength(
          attempted.length,
        );
      } else {
        expect(end).toMatchObject({
          event: 'done',
          data: { finish_reason: 'stop', quota_left: 29 },
        });
        expect(cards.map(({ data }) => data)).toEqual([
          expect.objectContaining({
            type: 'notice',
            data: expect.objectContaining({ text_key: 'agent.notice.quote_failed' }),
          }),
          quoted
            ? expect.objectContaining({ type: 'rebate_quote' })
            : expect.objectContaining({
                type: 'notice',
                data: expect.objectContaining({ text_key: 'no_rebate.notice' }),
              }),
        ]);
      }

      expect(frames[0]).toMatchObject({ event: 'meta', data: { run_id: expect.any(String) } });
      const runId = frames[0]!.data['run_id'] as string;
      expect(await runRow(pg.db, runId)).toMatchObject({
        end_reason: refunded ? 'server_error' : 'stop',
        settle_result: refunded ? 'refunded' : 'counted',
        card_delivered: quoted,
        final_event: { type: end.event, data: end.data },
      });
      const after = before.map((count) => count + (refunded ? 0 : 1));
      expect(await usage(f)).toEqual(after);

      if (refunded) {
        const replay = framesOf((await send(r, f.caller, sessionId, body)).chunks);
        expect(replay.map(({ event }) => event)).toEqual(['meta', 'error']);
        expect(replay[0]?.data).toMatchObject({ run_id: runId, duplicate: true });
        expect(terminal(replay).data).toEqual(end.data);
        expect(f.resolveLink).toHaveBeenCalledTimes(attempted.length);
        expect(await usage(f)).toEqual(after);
      }
    } finally {
      await r.runtime.close();
    }
  },
  120_000,
);

it('[AC-B3-05u#9] 报价全部失败、终止原因尚未落库时中断，后续请求接管并退还一次', async () => {
  const f = await fixture(pg.db);
  f.resolveLink.mockRejectedValue(upstreamFailure('circuit_open'));
  const assembly = f.build();
  const completed = Promise.withResolvers<RunBodyResult>();
  const resume = Promise.withResolvers<void>();
  const r = f.mount({
    ...assembly,
    deterministic: {
      async run(input, ctx) {
        const result = await assembly.deterministic.run(input, ctx);
        completed.resolve(result);
        // 模拟进程停在路径已返回、RunManager 尚未记录终止原因的位置。
        await resume.promise;
        return result;
      },
    },
  });
  try {
    const sessionId = await openSession(r, f.caller);
    const body = message(`${LINK} ${OTHER_LINK}`);
    const before = await usage(f);
    const oldRequest = send(r, f.caller, sessionId, body);
    try {
      const outcome = await Promise.race([completed.promise, oldRequest.then(() => null)]);
      expect(outcome).toMatchObject({ kind: 'error', error: { code: 50401, retryable: false } });
      expect(f.resolveLink.mock.calls.map(([raw]) => raw)).toEqual([LINK, OTHER_LINK]);
      expect(await usage(f)).toEqual(before.map((count) => count + 1));
      const session = await sessionRow(pg.db, sessionId);
      expect(session['run_lock_run_id']).toBeTypeOf('string');
      const runId = session['run_lock_run_id'] as string;
      expect(await runRow(pg.db, runId)).toMatchObject({
        end_reason: null,
        final_event: null,
        settle_result: null,
        card_delivered: false,
      });

      const { runMaxMs, lockGraceMs } = r.runtime.timings;
      const later = proc(pg.pool(), f.time.clock.now().getTime() + runMaxMs + lockGraceMs + 1_000);
      const reply = await sendLive(later, f.caller, sessionId, body);
      expect(reply.jsons).toEqual([]);
      const frames = framesOf(reply.chunks);
      expect(frames.map(({ event }) => event)).toEqual(['meta', 'error']);
      expect(frames[0]?.data).toMatchObject({ run_id: runId, duplicate: true });
      const recovered = terminal(frames);
      expect(recovered.data).toMatchObject({ code: 50001 });
      expect(await runRow(pg.db, runId)).toMatchObject({
        end_reason: 'server_error',
        settle_result: 'refunded',
        card_delivered: false,
        final_event: { type: recovered.event, data: recovered.data },
      });
      expect(await usage(f)).toEqual(before);
      expect((await sessionRow(pg.db, sessionId))['run_lock_run_id']).toBeNull();

      const replay = await sendLive(later, f.caller, sessionId, body);
      expect(terminal(framesOf(replay.chunks)).data).toEqual(recovered.data);
      expect(await usage(f)).toEqual(before);
    } finally {
      resume.resolve();
      await oldRequest;
    }
  } finally {
    await r.runtime.close();
  }
}, 120_000);
