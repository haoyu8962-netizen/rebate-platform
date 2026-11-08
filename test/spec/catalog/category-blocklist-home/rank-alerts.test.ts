// B1-04zzzz (D10-860 ④ ⑦): alerts of the hot list's category blocklist, the same codes as the search
// tab (catalog_category_missing / catalog_category_blocked). Items without a category are counted per
// platform; dropped items per platform, only when something was dropped. An alert carries the event
// code, the platform and the count, nothing else. Counts are summed over the request's warn calls,
// so one alert per page or one per request are both accepted; the message text is not pinned.
import { expect, it } from 'vitest';
import {
  APP,
  BLOCKED_EVENT,
  JD_CHANNEL,
  MISSING_EVENT,
  TB_CHANNEL,
  alerts,
  channel,
  hotFixture,
  rankTitles,
  ranked,
  titleOf,
  total,
} from './home-kit.ts';

function expectShape(list: readonly Record<string, unknown>[], platform: string): void {
  for (const fields of list) {
    expect(Object.keys(fields).sort()).toEqual(['count', 'event', 'platform']);
    expect(fields['platform']).toBe(platform);
  }
  const text = JSON.stringify(list, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
  expect(text).not.toContain('synthetic');
}

it('[AC-B1-04zzzz#6] 热销榜告警：无类目计 catalog_category_missing、被滤计 catalog_category_blocked，按平台计数，键恰为 event / platform / count', async () => {
  const f = hotFixture();
  f.block(APP, [
    { platform: 'taobao', categoryId: '50', keyword: null },
    { platform: 'taobao', categoryId: '70', keyword: '禁售词' },
  ]);
  f.setPage('taobao', TB_CHANNEL, null, 1, [
    ranked('a', '50'),
    ranked('b', undefined, { title: 'synthetic-b-禁售词' }),
    ranked('c', ''),
    ranked('d', undefined),
    ranked('e', '60'),
  ]);

  const result = await f.run();

  expect(rankTitles(result)).toEqual([
    [3, titleOf('c')],
    [4, titleOf('d')],
    [5, titleOf('e')],
  ]);
  const missing = alerts(f.warn, MISSING_EVENT);
  const blocked = alerts(f.warn, BLOCKED_EVENT);
  expect(total(missing)).toBe(3);
  expect(total(blocked)).toBe(2);
  expectShape(missing, 'taobao');
  expectShape(blocked, 'taobao');
});

it('[AC-B1-04zzzz#7] 热销榜告警：没有被滤项时不记 catalog_category_blocked，类目齐全时无类目计数为 0；名单一生效即按该平台（京东）记', async () => {
  const f = hotFixture();
  f.setChannels([channel('taobao', TB_CHANNEL), channel('jd', JD_CHANNEL)]);
  f.block(APP, [{ platform: 'jd', categoryId: '50', keyword: null }]);
  f.setPage('jd', JD_CHANNEL, null, 1, [
    ranked('jd-a', '60', { platform: 'jd' }),
    ranked('jd-b', '61', { platform: 'jd' }),
  ]);

  await f.run({ platform: 'jd' });
  expect(alerts(f.warn, BLOCKED_EVENT)).toEqual([]);
  expect(total(alerts(f.warn, MISSING_EVENT))).toBe(0);

  f.block(APP, [{ platform: 'jd', categoryId: '61', keyword: null }]);
  const result = await f.run({ platform: 'jd' });

  expect(rankTitles(result)).toEqual([[1, titleOf('jd-a')]]);
  const blocked = alerts(f.warn, BLOCKED_EVENT);
  expect(total(blocked)).toBe(1);
  expectShape(blocked, 'jd');
});
