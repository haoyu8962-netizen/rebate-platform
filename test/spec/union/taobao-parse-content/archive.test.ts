import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import { createArchivingTransport } from '../../../../apps/api/src/modules/union/infra/archive.ts';
import type { UnionTransport } from '../../../../apps/api/src/modules/union/infra/replay.ts';
import {
  expectRedacted,
  instant,
  queryFields,
  response,
  sent,
  setup as setupDataoke,
} from '../dataoke-core/kit.ts';
import { ctx, detailSetup, unionFailure } from '../taobao-goods/kit.ts';
import { archiveDatabase, onlyArchiveOf, payloadText } from '../taobao-order-archive/kit.ts';
import { enableThirdPartyParse } from './settings.ts';

const parsePath = '/api/tb-service/parse-content';
const goodsId = '9007199254740993123';
const itemId = 'Synthetic-ArchiveItem01';
const contentParts = ['合成归档分享前缀', 'ArchiveToken01', '合成归档分享后缀'];
const content = `${contentParts[0]} ￥${contentParts[1]}￥ ${contentParts[2]}`;
const contentMarkers = [
  content,
  'ArchiveToken',
  'Token01',
  ...contentParts,
  ...contentParts.map(encodeURIComponent),
];
const promotionFields = {
  pid: 'synthetic-archive-pid',
  commissionRate: 'synthetic-archive-rate',
  commissionType: 'synthetic-archive-type',
  url: 'https://promotion.invalid/archive-probe',
  originInfo: { activityId: 'synthetic-archive-activity' },
};

function setup(parseReply: ReturnType<typeof response>) {
  const database = archiveDatabase();
  const clock = new FixedClock(instant);
  const upstream = vi.fn<UnionTransport>().mockResolvedValue(parseReply);
  const transport = createArchivingTransport(upstream, {
    db: database.db,
    clock,
    logger: { warn: vi.fn(), error: vi.fn() },
  });
  const dataoke = setupDataoke({ clock, transport });
  const taobao = detailSetup([{ item_id: itemId }], {
    orderSource: dataoke.client,
    ...enableThirdPartyParse(ctx.appId),
  });
  return { database, upstream, taobao };
}

function expectPrivateArchive({ database, upstream }: ReturnType<typeof setup>) {
  expect(upstream).toHaveBeenCalledTimes(1);
  expect(queryFields(sent(upstream))).toHaveProperty('content', content);
  expect(database.unexpected).toEqual([]);
  const row = onlyArchiveOf(database, parsePath);
  expect(row.values).toMatchObject({ app_id: ctx.appId, kind: 'query' });
  const summary = row.values['request_summary'];
  const summaryText = typeof summary === 'string' ? summary : JSON.stringify(summary);
  expect(summaryText).not.toMatch(/"content"\s*:/u);
  expectRedacted(summary, contentMarkers);
  return payloadText(row);
}

it('[AC-B1-04zzzzo#8] 淘口令解析成功归档移除请求原文和应答推广字段，保留 goodsId', async () => {
  const data = { goodsId, ...promotionFields, echoedContent: content };
  const harness = setup(response({ code: 0, msg: content, data }));

  const result = await harness.taobao.adapter
    .resolveLink(content, ctx)
    .catch((error: unknown) => error);
  expect(result).toStrictEqual({
    item: { platform: 'taobao', item_id: itemId },
  });

  const body = expectPrivateArchive(harness);
  expectRedacted(body, [
    ...contentMarkers,
    promotionFields.pid,
    promotionFields.commissionRate,
    promotionFields.commissionType,
    promotionFields.url,
    promotionFields.originInfo.activityId,
  ]);
  expect(body).not.toMatch(/"(?:pid|commission[^"]*|url|activityId|echoedContent)"\s*:/u);
  expect(() => JSON.parse(body)).not.toThrow();
  expect(JSON.parse(body)).toHaveProperty('data', { goodsId });
});

it('[AC-B1-04zzzzo#9] 淘口令解析 25003 仍归档且移除请求原文和应答回显', async () => {
  const harness = setup(response({ code: 25003, msg: content, data: null }));

  await unionFailure(() => harness.taobao.adapter.resolveLink(content, ctx), 'link_unrecognized');

  const body = expectPrivateArchive(harness);
  expectRedacted(body, contentMarkers);
  expect(harness.taobao.transport).not.toHaveBeenCalled();
});
