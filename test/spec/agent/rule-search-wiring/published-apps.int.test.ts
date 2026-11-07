// B3-08l 同步的 app 来源：content 的只读入口 createPublishedArticleAppsReader（content/index.ts 导出，
// apps/api/src/modules/content/application/published-articles.ts 文件头是契约）。apps() 只列有「当前修订」为
// 已发布 help / rule 文章的 app（与 createPublishedArticlesReader.list 同一当前修订口径），每个 app 一次、
// 按 app id 升序，每次调用现读（无缓存）。Real PG as couli_app; time: a FixedClock. Other rows a fresh
// database may hold are ignored: only this test's synthetic app ids are compared.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { createPublishedArticleAppsReader } from '../../../../apps/api/src/modules/content/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { usePgEach } from '../stream-mount/kit.ts';
import { NOW, appIdOf, insertArticle, setArticleStatus } from './kit.ts';

const pg = usePgEach(createTestDatabase);

it('[AC-B3-08l#4][BR-AI-07] content 只读入口 apps()：只列 category ∈ help / rule、当前修订 status = published 且已到发布时间的 app，去重、升序；公告、协议、草稿、未到发布时间、已下线的不列；每次现读', async () => {
  const clock = new FixedClock(NOW);
  const helpAndRule = appIdOf('a');
  const ruleOnly = appIdOf('b');
  const noneListed = appIdOf('c');
  const olderPublished = appIdOf('d');
  const offline = appIdOf('e');

  await insertArticle(pg.db, { appId: helpAndRule, category: 'help', texts: ['甲一。'] });
  await insertArticle(pg.db, { appId: helpAndRule, category: 'help', texts: ['甲二。'] });
  await insertArticle(pg.db, { appId: helpAndRule, category: 'rule', texts: ['甲三。'] });
  const rule = await insertArticle(pg.db, { appId: ruleOnly, category: 'rule', texts: ['乙。'] });
  await insertArticle(pg.db, { appId: noneListed, category: 'notice', texts: ['公告'] });
  await insertArticle(pg.db, { appId: noneListed, category: 'agreement', texts: ['协议'] });
  await insertArticle(pg.db, { appId: noneListed, category: 'help', status: 'draft' });
  await insertArticle(pg.db, {
    appId: noneListed,
    category: 'rule',
    publishedAt: new FixedClock('2026-10-28T00:00:00.000Z').now(),
  });
  const first = await insertArticle(pg.db, { appId: olderPublished, category: 'help' });
  await insertArticle(pg.db, {
    appId: olderPublished,
    id: first.id,
    version: 2,
    category: 'help',
    status: 'draft',
  });
  const gone = await insertArticle(pg.db, { appId: offline, category: 'help' });
  await setArticleStatus(pg.db, gone.id, 'offline');

  const mine = new Set([helpAndRule, ruleOnly, noneListed, olderPublished, offline]);
  const reader = createPublishedArticleAppsReader({ db: pg.db, clock });

  const all = await reader.apps();
  expect(new Set(all).size, 'each app once').toBe(all.length);
  expect(all, 'ascending app id order').toEqual([...all].sort());
  expect(all.filter((appId) => mine.has(appId))).toEqual(
    [helpAndRule, ruleOnly, olderPublished].sort(),
  );

  // Read fresh: taking the only rule article offline drops its app on the next call.
  await setArticleStatus(pg.db, rule.id, 'offline');
  const again = await reader.apps();
  expect(again.filter((appId) => mine.has(appId))).toEqual([helpAndRule, olderPublished].sort());
}, 120_000);
