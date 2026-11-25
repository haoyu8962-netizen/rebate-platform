import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  batch,
  getItem,
  member,
  rejected,
  setup,
  snapshot,
  success,
  update,
  valueInvalid,
  type Item,
} from '../config-items/kit.ts';

const h = useHarness();
const HOLIDAYS = 'calendar.cn_holidays.2028';
const MAKEUP_WORKDAYS = 'calendar.cn_makeup_workdays.2028';
const LEAP_DAY = '2028-02-29';

it('[AC-B1-34s#3] 持 config.general 可单条写入闰日及空数组，写后能读回', async () => {
  const f = await setup(h);
  const { token } = await member(h, f, ['config.general']);
  const caller = { ...f, token };
  for (const [expectedVersion, value] of [[LEAP_DAY], []].entries()) {
    const version = expectedVersion + 1;
    const saved = await success<Item>(
      await update(caller, HOLIDAYS, { value, expected_version: expectedVersion }),
      'update',
    );
    expect(saved).toMatchObject({ key: HOLIDAYS, value, version });
    expect(await getItem(caller, HOLIDAYS)).toMatchObject({ value, version });
  }
});

it('[AC-B1-34s#4] 批量接受两个日历键中各自合法的数组，包括同一日期出现在两键', async () => {
  const f = await setup(h);
  const { token } = await member(h, f, ['config.general']);
  const caller = { ...f, token };
  const keys = [HOLIDAYS, MAKEUP_WORKDAYS];
  const value = [LEAP_DAY];
  const result = await success<{ items: Item[] }>(
    await batch(caller, {
      items: keys.map((key) => ({ key, value, expected_version: 0 })),
    }),
    'batch',
  );
  expect(result.items).toMatchObject(keys.map((key) => ({ key, value, version: 1 })));
  for (const key of keys) {
    expect(await getItem(caller, key)).toMatchObject({ value, version: 1 });
  }
});

it('[AC-B1-34s#5] 单条写入日历坏值返回 20001 和 fields=[value]，且不落库', async () => {
  const f = await setup(h);
  const before = await snapshot(h, f.appId);
  for (const value of [
    { date: LEAP_DAY },
    [LEAP_DAY, 1],
    ['2028-2-29'],
    ['2028-02-30'],
    ['2027-02-28'],
    [LEAP_DAY, LEAP_DAY],
  ]) {
    const response = await update(f, MAKEUP_WORKDAYS, { value, expected_version: 0 });
    await valueInvalid(response, 'update');
  }
  expect(await snapshot(h, f.appId)).toStrictEqual(before);
});

it('[AC-B1-34s#6] 批量写入日历坏值返回 20001，字段列出坏键且整批不落库', async () => {
  const f = await setup(h);
  const before = await snapshot(h, f.appId);
  const response = await batch(f, {
    items: [
      { key: 'calendar.cn_holidays.2027', value: ['2027-12-31'], expected_version: 0 },
      { key: HOLIDAYS, value: ['2028-02-30'], expected_version: 0 },
      { key: MAKEUP_WORKDAYS, value: [LEAP_DAY, LEAP_DAY], expected_version: 0 },
    ],
  });
  await rejected(response, 'batch', 20001);
  const fields = response.json().data?.fields;
  expect(fields).toEqual(expect.arrayContaining([HOLIDAYS, MAKEUP_WORKDAYS]));
  expect(fields).toHaveLength(2);
  expect(await snapshot(h, f.appId)).toStrictEqual(before);
});
