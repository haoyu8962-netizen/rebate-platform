// CT-07f (D10-1986): what App / H5 receive carries no tags. getPage (GET /v1/pages/{page_key}) and
// the preview (adminCreatePagePreviewToken → previewPage) send every product_pool data source
// without its `tags` key and everything else as stored: the server filters before it sends, so the
// clients and H5 need no change. Neither answer changes the stored version or the caches: the same
// read again still has no tags, and the section the items endpoint reads (PageReader.section, the
// port app.module hands to catalog) still has them, also after a getPage of that version was cached.
// A key named `tags` elsewhere (a static item of a banner) is not a product_pool data source and
// is sent as stored. Real admin and api entries, one database and one injected Clock (F1-09e kit).
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { PageReader } from '../../../../apps/api/src/modules/content/application/page-reader.ts';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  contentSnapshot,
  issue,
  issued,
  previewed,
  read as readPreview,
  seedVersion,
  setup,
  type Setup,
} from '../../content/pages-preview/kit.ts';
import { validate as validatePage } from '../../content/pages-read/kit.ts';
import {
  CONFIG_POOL_ID,
  bannerWithItemTags,
  expectNoPoolTags,
  gridSection,
  poolSource,
  scrollSection,
  withoutPoolTags,
} from './kit.ts';

const h = useHarness();

const SECTIONS: Record<string, unknown>[] = [
  bannerWithItemTags('promo_banner'),
  gridSection('pool_grid', poolSource(CONFIG_POOL_ID, ['新品', '618 大促'], 6)),
  scrollSection('pool_scroll', poolSource(CONFIG_POOL_ID, undefined, 4)),
  {
    id: 'feed',
    type: 'feed_infinite',
    version: 1,
    data_source: {
      kind: 'union_material',
      channels: [{ platform: 'taobao', channel_id: 'synthetic_tb_sales' }],
    },
  },
];
const DELIVERED = withoutPoolTags(SECTIONS);
const VIEWER = { platform: 'ios', appVersion: '2.0.0' } as const;

/** Version 1 of home, published and fully released. */
async function publishHome(f: Setup): Promise<void> {
  await seedVersion(h, f, 1, 'published', 'home', SECTIONS);
  await sql`UPDATE app.pages SET current_version = 1, gray_version = NULL, gray_percent = 0
    WHERE app_id = ${f.appId} AND page_key = 'home'`.execute(h.db);
}

function getPage(f: Setup) {
  return f.api.inject({
    method: 'GET',
    url: '/v1/pages/home',
    headers: {
      'x-app-id': f.appId,
      'x-platform': VIEWER.platform,
      'x-app-version': VIEWER.appVersion,
    },
    remoteAddress: '127.0.0.1',
  });
}

async function delivered(f: Setup): Promise<unknown> {
  const response = await getPage(f);
  expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
  expect(response.json()).toMatchObject({ code: 0 });
  await validatePage(response);
  return response.json<{ data: { sections: unknown } }>().data.sections;
}

function readerOf(f: Setup): PageReader {
  return (f.api as unknown as { get<T>(token: abstract new (...args: never[]) => T): T }).get(
    PageReader,
  );
}

it('[CT-07f][D10-1986] 正式下发 getPage：product_pool 数据源不带 tags，其余字段和别的卡片原样（横幅静态项里的 tags 键照发）；再读一次也不带；存储不变', async () => {
  const f = await setup(h);
  await publishHome(f);
  const before = await contentSnapshot(h, f.appId);

  const first = await delivered(f);
  const second = await delivered(f);

  expectNoPoolTags(first);
  expect(first).toEqual(DELIVERED);
  expect(second).toEqual(DELIVERED);
  expect(await contentSnapshot(h, f.appId)).toEqual(before);
});

it('[CT-07f][D10-1986] 下发去掉 tags 不改缓存：getPage 之后同一版本的卡片（列表接口读的 PageReader.section）仍带存储里的 tags，之后的 getPage 仍不带', async () => {
  const f = await setup(h);
  await publishHome(f);

  expectNoPoolTags(await delivered(f));
  const section = await readerOf(f).section(f.appId, 'home', 'pool_grid', null, VIEWER);
  const again = await delivered(f);

  expect(section).toEqual(SECTIONS[1]);
  expect(again).toEqual(DELIVERED);
});

it('[CT-07f][D10-1986] 预览下发：product_pool 数据源不带 tags，其余原样；同一个令牌再读一次也不带；草稿版本存储不变', async () => {
  const f = await setup(h);
  await seedVersion(h, f, 1, 'draft', 'home', SECTIONS);
  const { token } = await issued(await issue(f, 1));
  const before = await contentSnapshot(h, f.appId);

  const first = await previewed(await readPreview(f, token));
  const second = await previewed(await readPreview(f, token));

  expectNoPoolTags(first.sections);
  expect(first.sections).toEqual(DELIVERED);
  expect(second.sections).toEqual(DELIVERED);
  expect(await contentSnapshot(h, f.appId)).toEqual(before);
});
