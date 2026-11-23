import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { createAgentStreamAssembly } from '../../../../apps/api/src/modules/agent/stream/mount/index.ts';
import { productionRunTexts } from '../../../../apps/api/src/modules/agent/stream/mount/production.ts';
import { fixture } from '../stream-assembly/kit.ts';
import {
  fileText,
  framesOf,
  message,
  openSession,
  runsOf,
  send,
  usePgEach,
} from '../stream-mount/kit.ts';

const pg = usePgEach(createTestDatabase);
const NOTICE_KEY = 'no_rebate.notice';

it('[AC-B3-05w#3][BR-AI-15] 无模型的商品情境入口仅出无返利提示，正常结束并计一条，不登记链接', async () => {
  const f = await fixture(pg.db);
  f.quote.mockResolvedValue({
    rebateMinFen: 0n,
    rebateMaxFen: 0n,
    estNetPriceFen: null,
    rebateBasis: 'no_rebate',
  });
  const texts = productionRunTexts(async () => [], f.logs.logger);
  const rig = f.mount(createAgentStreamAssembly({ ...f.deps, texts }));
  try {
    const sessionId = await openSession(rig, f.caller);
    const productKey = f.state.row.ref.productKey;
    const reply = await send(rig, f.caller, sessionId, {
      ...message('这个值得买吗'),
      context: { product_key: productKey },
    });
    const frames = framesOf(reply.chunks);

    expect(f.readProduct.mock.calls.map(([key]) => key)).toEqual([productKey]);
    const endings = frames.filter(({ event }) => event === 'done' || event === 'error');
    expect(endings).toMatchObject([
      { event: 'done', data: { finish_reason: 'stop', quota_left: 29 } },
    ]);
    const runs = await runsOf(pg.db, sessionId);
    expect(runs).toMatchObject([
      { end_reason: 'stop', settle_result: 'counted', card_delivered: false },
    ]);
    expect(await pg.db.selectFrom('links').select('link_id').execute()).toEqual([]);
    expect(frames.filter(({ event }) => event === 'card')).toMatchObject([
      {
        data: {
          type: 'notice',
          data: { text_key: NOTICE_KEY },
          fallback_text: fileText(NOTICE_KEY),
        },
      },
    ]);
  } finally {
    await rig.runtime.close();
  }
}, 120_000);
