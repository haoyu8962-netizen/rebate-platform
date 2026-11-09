// B1-05zo: adminSearchPoolCandidates drops blocked-category products as the search tab does
// (D10-860 rules over the app's active rows, after the search cache, so a changed list applies to
// the next request).
import { expect, it } from 'vitest';
import {
  candidates,
  searchAnswers,
  setup,
  stableId,
  success,
  useHarness,
  type CandidateList,
} from '../product-pool-admin/kit.ts';
import { BLOCKED, blockRule, goods, KEYWORD, OPEN } from './fixtures.ts';

const h = useHarness();

const keysOf = (list: CandidateList) => list.items.map((row) => row.product_key).sort();

it('[AC-B1-05zo#16] 选品候选不出现禁售类目商品（与搜索 Tab 同口径）：命中类目的、无类目但标题含关键词的滤掉，其余照出；别的 App 的规则不滤，名单下一次请求即生效', async () => {
  const f = await setup(h);
  const [blocked, keyword, open, plain, empty] = ['Blk', 'Kw', 'Open', 'Plain', 'Empty'].map(
    (prefix) => stableId(prefix),
  ) as [string, string, string, string, string];
  searchAnswers([
    [
      goods(f, blocked, BLOCKED),
      goods(f, keyword, null, { title: `合成商品 ${KEYWORD} ${keyword}` }),
      goods(f, open, OPEN),
      goods(f, plain, null),
      goods(f, empty, ''),
    ],
  ]);
  await blockRule(h, f, { category: BLOCKED, appId: `${f.appId}_other` });
  const q = { q: `合成${stableId('q')}` };
  const all = [blocked, keyword, open, plain, empty].map((stable) => `tb:${stable}`).sort();
  expect(keysOf(await success<CandidateList>(await candidates(f, q)))).toEqual(all);

  await blockRule(h, f, { category: BLOCKED });
  await blockRule(h, f, { category: OPEN, keyword: KEYWORD });
  const kept = [open, plain, empty].map((stable) => `tb:${stable}`).sort();
  expect(keysOf(await success<CandidateList>(await candidates(f, q)))).toEqual(kept);
});
