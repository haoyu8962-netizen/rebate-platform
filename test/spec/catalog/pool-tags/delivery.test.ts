// CT-07e (D10-1758; 规划/04 §3.2): the filter is the server's. The page configuration delivered to the
// apps and H5 (getPage, content's PageReader.read) carries no tag field in a product_pool data source,
// everything else of the section as stored; the section that listPageSectionItems reads on the
// server (PageReader.section) still has the tags, and serving a page never strips them from the
// stored or cached version. The App's HomePreview (previewPage, content's PagePreviewService.read)
// is a /v1 delivery too: its sections carry no tag field either, and the stored version is untouched.
import { expect, it } from 'vitest';
import {
  PageReader,
  type PageStore,
  type PageVersion,
} from '../../../../apps/api/src/modules/content/application/page-reader.ts';
import {
  PagePreviewService,
  type PagePreviewStore,
} from '../../../../apps/api/src/modules/content/application/page-preview.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';

const APP = 'app_ct07e';
const guest = { loggedIn: false, platform: 'ios', appVersion: '2.0.0' };
const IOS = { platform: 'ios', appVersion: '2.0.0' };

const TAGGED = {
  id: 'pool_tagged',
  type: 'product_grid',
  version: 1,
  props: { columns: 2, title: '今日上新' },
  data_source: { kind: 'product_pool', pool_id: 'pool_demo_daily', limit: 20, tags: ['新品'] },
};
const PLAIN = {
  id: 'pool_plain',
  type: 'product_scroll',
  version: 1,
  props: {},
  data_source: { kind: 'product_pool', pool_id: 'pool_demo_hot', limit: 10 },
};
const MATERIAL = {
  id: 'feed',
  type: 'product_grid',
  version: 1,
  data_source: {
    kind: 'union_material',
    channels: [{ platform: 'taobao', channel_id: 'synthetic_tb_sales' }],
  },
};

function reader(sections: readonly Record<string, unknown>[]) {
  const version: PageVersion = { status: 'published', sections };
  const store: PageStore = {
    pointer: () => Promise.resolve({ currentVersion: 1, grayVersion: null, grayPercent: 0 }),
    version: () => Promise.resolve(version),
  };
  return new PageReader(store, new FixedClock('2026-11-16T10:00:00+08:00'));
}

function withoutTags(section: typeof TAGGED) {
  const { tags, ...source } = section.data_source;
  expect(tags).toEqual(['新品']);
  return { ...section, data_source: source };
}

it('[CT-07e][D10-1758] 下发的页面配置里 product_pool 数据源不带 tags，其余字段与存储一致', async () => {
  const pages = reader([TAGGED, PLAIN, MATERIAL].map((section) => structuredClone(section)));

  const page = await pages.read(APP, 'home', 'device-1', guest);

  expect(page?.sections).toEqual([withoutTags(TAGGED), PLAIN, MATERIAL]);
  expect(JSON.stringify(page)).not.toContain('"tags"');
});

it('[CT-07e][D10-1758] 服务端读卡片仍拿到 tags；下发页面不改动存储与缓存里的版本，读几次都一样', async () => {
  const stored = structuredClone(TAGGED);
  const pages = reader([stored, structuredClone(PLAIN)]);

  const first = await pages.read(APP, 'home', null, guest);
  const section = await pages.section(APP, 'home', 'pool_tagged', null, IOS);
  const second = await pages.read(APP, 'home', null, guest);

  expect(first?.sections[0]).toEqual(withoutTags(TAGGED));
  expect(second?.sections[0]).toEqual(withoutTags(TAGGED));
  expect(section).toEqual(TAGGED);
  expect(stored).toEqual(TAGGED);
});

/** previewPage (/v1, the App's HomePreview): one saved version, opened by a live token. */
function previewer(sections: unknown[]) {
  const store: PagePreviewStore = {
    transaction: () => Promise.reject(new Error('preview read issues nothing')),
    consume: () => Promise.resolve(3),
    sections: (appId, pageKey, version) =>
      Promise.resolve(appId === APP && pageKey === 'home' && version === 3 ? sections : undefined),
  };
  return new PagePreviewService({ store, clock: new FixedClock('2026-11-16T10:00:00+08:00') });
}

it('[CT-07e][D10-1758] 预览页（previewPage）下发的 product_pool 数据源同样不带 tags，其余与存储一致，不改动存储的版本', async () => {
  const stored = [TAGGED, PLAIN, MATERIAL].map((section) => structuredClone(section));
  const previews = previewer(stored);

  const first = await previews.read(APP, 'home', 'token-1');
  const second = await previews.read(APP, 'home', 'token-1');

  for (const preview of [first, second]) {
    expect(preview.page_key).toBe('home');
    expect(preview.version).toBe(3);
    expect(preview.sections).toEqual([withoutTags(TAGGED), PLAIN, MATERIAL]);
    expect(JSON.stringify(preview)).not.toContain('"tags"');
  }
  expect(stored).toEqual([TAGGED, PLAIN, MATERIAL]);
});
