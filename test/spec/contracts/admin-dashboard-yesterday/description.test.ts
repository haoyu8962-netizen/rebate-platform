// CT-24zzk adminGetDashboard 描述里 `yesterday` 那一条（任务书第 9 节第 5 条，D10-1403 ③）：写明没有任何
// 聚合行时为 null，以及取「不晚于昨天的最新一行」、date 与 as_of 如实。只用稳定关键词断言，不逐字钉整句；
// 静态读 contracts，不连库、不 listen。
import { expect, it } from 'vitest';
import { contract } from '../admin-order-actions/kit.ts';
import { operation, operationId, yesterdayBullet } from './kit.ts';

// 没有行的条件（一行聚合都没有 / 从未聚合成功）。
const noRow =
  /\b(no|none|never|nothing|without)\b[^.。;；]{0,80}(\brows?\b|aggregat)|没有任何?聚合|从未聚合|一行都没有|无聚合/i;
// 取最新一行。
const latest = /latest|most recent|newest|最新/i;
// 不晚于昨天（Asia/Shanghai 会计日）。
const notAfterYesterday =
  /(not|no) later than yesterday|on or before yesterday|at or before yesterday|up to (and including )?yesterday|≤\s*yesterday|不晚于昨天/i;
// date 与 as_of 如实，可能早于昨天。
const asIs = /earlier|早于|as[- ]is|truthful|actual|如实|that row|该行|那一行/i;

it('[AC-CT-24zzk#5] adminGetDashboard 描述的 yesterday 一条写明没有任何聚合行时为 null，取不晚于昨天的最新一行，date 与 as_of 如实', () => {
  const doc = contract();
  expect(operation(doc)['operationId']).toBe(operationId);
  const bullet = yesterdayBullet(doc);
  expect(bullet).toMatch(/\bnull\b/);
  expect(bullet).toMatch(noRow);
  expect(bullet).toMatch(latest);
  expect(bullet).toMatch(notAfterYesterday);
  expect(bullet).toContain('`date`');
  expect(bullet).toContain('as_of');
  expect(bullet).toMatch(asIs);
});
