// B2-04zze rule test: the punish.window job hands each punishment's violation_type to the writer as
// delivered (orchestrator D10-862: 原值经 RightsSyncItem / RightsRecordInput 透传到 settlement 的入参，不落库;
// 08 BR-TEXT-05 细则「写入来源 ①」淘宝 / 大淘客违规按 violation_type 映射). The handler fixture is the
// B1-04zza one (fakes only: no database, no network); punishments are synthetic UnionPunish shapes.
// The raw text travels in the writer's third argument (RightsSyncExtras), never on the write item:
// the item keeps the six fields the frozen [AC-B1-04zza] handler tests compare field by field
// (test/spec/orders/taobao-rights-sync/handler.test.ts; orchestrator, attempt 3).
import { expect, it } from 'vitest';
import { handlePunishWindow } from '../../../../apps/api/src/modules/orders/jobs/rights-sync.ts';
import {
  PUNISH_JOB,
  fixture,
  job,
  punishWindow,
  punishment,
} from '../../orders/taobao-rights-sync/kit.ts';

it('[AC-B2-04zze#7] 违规同步：每条处罚的 violation_type 原样（含编码形态、空值）经 writer 的第三个参数交给 rights.record 的入参；写入项本身不带 violation_type，类型、状态、单号照旧', async () => {
  const f = fixture({
    punishPages: [
      [
        punishment(1, { violation_type: '订单虚假交易' }),
        punishment(2, { violation_type: '1' }),
        punishment(3, { violation_type: null }),
      ],
      [punishment(4, { violation_type: '店铺淘宝客' })],
    ],
  });

  await handlePunishWindow(job(PUNISH_JOB, punishWindow()), f.handler);

  const calls = f.write.mock.calls;
  expect(calls.map((call) => call[2]?.violation_type)).toEqual([
    '订单虚假交易',
    '1',
    null,
    '店铺淘宝客',
  ]);
  const items = calls.map((call) => call[1]);
  expect(items.map((item) => Object.keys(item).includes('violation_type'))).toEqual([
    false,
    false,
    false,
    false,
  ]);
  expect(items.map((item) => 'violation_type' in item)).toEqual([false, false, false, false]);
  expect(items.map((item) => [item.type, item.status, item.platform_rights_no])).toEqual([
    ['PUNISH', 'SUCCEEDED', punishment(1).punishment_id],
    ['PUNISH', 'SUCCEEDED', punishment(2).punishment_id],
    ['PUNISH', 'SUCCEEDED', punishment(3).punishment_id],
    ['PUNISH', 'SUCCEEDED', punishment(4).punishment_id],
  ]);
});
