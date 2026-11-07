// B1-04zzp（D10-793 ①）：联盟账号与另一家共用，大淘客违规接口返回两边全部违规单。违规请求的归档只存去掉
// 别家行的报文：tk_adzone_id 可读且不在凑狸推广位清单的行不进 payload；自家行（在用与已停用）、读不出推广位
// 的行照样在；外层字段（total_count 不随删行改）与 JSON 数字原文不变。走真实 createArchivingTransport +
// 淘宝适配器，报文全部合成。
import { expect, it } from 'vitest';
import {
  PLAIN,
  PUNISH_PATH,
  answer,
  expectArchivedAs,
  onlyArchiveOf,
  win,
  wire,
} from '../taobao-order-archive/kit.ts';
import {
  FOREIGN_ADZONE,
  OTHER_FOREIGN_ADZONE,
  RETIRED_ADZONE,
  listed,
  num,
  punishOf,
} from '../taobao-refunds/kit.ts';
import { foreignText, punishBody, punishForeignCounts, punishIdOf, punishmentIdOf } from './kit.ts';

it('[AC-B1-04zzp#1] 混合页的违规归档只剩自家推广位（在用与已停用）的行、按上游顺序；别家行（tk_adzone_id 是 JSON 整数或十进制串）在 gunzip 后的报文里一个字也没有', async () => {
  const rows = [
    punishOf(1),
    punishOf(50, FOREIGN_ADZONE),
    punishOf(2, RETIRED_ADZONE),
    foreignText(51, OTHER_FOREIGN_ADZONE),
    punishOf(3),
    punishOf(52, FOREIGN_ADZONE),
  ];
  const h = wire(() => answer(punishBody(rows)));

  const page = await listed(h.adapter.listPunishments(win, PLAIN));

  expect(page.items.map((item) => item.punishment_id)).toEqual(
    [1, 2, 3].map((index) => punishmentIdOf(index)),
  );
  expect(page.nextCursor).toBeNull();
  expect(h.database.inserted, 'one archive row for the one upstream page').toHaveLength(1);
  const row = onlyArchiveOf(h.database, PUNISH_PATH);
  expect(row.values['kind']).toBe('order');
  const text = expectArchivedAs(
    row,
    punishBody([punishOf(1), punishOf(2, RETIRED_ADZONE), punishOf(3)], { total: rows.length }),
  );
  for (const index of [50, 51, 52]) {
    expect(text, `foreign punishment ${index} is not archived`).not.toContain(punishIdOf(index));
  }
  expect(text).not.toContain(FOREIGN_ADZONE);
  expect(text).not.toContain(OTHER_FOREIGN_ADZONE);
  expect(h.database.unexpected).toEqual([]);
});

it('[AC-B1-04zzp#2] 读不出 tk_adzone_id 的行（缺失、非法值、JSON null、空串、整行不是对象）照样在违规归档里，不当别家行删', async () => {
  const bad = [
    { ...punishOf(2), tk_adzone_id: undefined },
    { ...punishOf(3), tk_adzone_id: 'synthetic-slot' },
    { ...punishOf(4), tk_adzone_id: null },
    { ...punishOf(5), tk_adzone_id: '' },
    { ...punishOf(6), tk_adzone_id: num(`${FOREIGN_ADZONE}.5`) },
    { ...punishOf(7), tk_adzone_id: num(`-${FOREIGN_ADZONE}`) },
  ];
  const notObjects = [
    'synthetic-punish-row-as-text',
    num(punishIdOf(8)),
    null,
    [punishOf(9, FOREIGN_ADZONE)],
  ];
  const rows = [
    punishOf(1),
    bad[0],
    punishOf(50, FOREIGN_ADZONE),
    bad[1],
    notObjects[0],
    bad[2],
    foreignText(51),
    bad[3],
    notObjects[1],
    bad[4],
    notObjects[2],
    bad[5],
    notObjects[3],
  ];
  const kept = rows.filter((_row, index) => index !== 2 && index !== 6);
  const h = wire(() => answer(punishBody(rows)));

  const page = await listed(h.adapter.listPunishments(win, PLAIN));

  expect(page.items.map((item) => item.punishment_id)).toEqual([punishmentIdOf(1)]);
  expect(kept).toHaveLength(rows.length - 2);
  const text = expectArchivedAs(
    onlyArchiveOf(h.database, PUNISH_PATH),
    punishBody(kept, { total: rows.length }),
  );
  for (const index of [50, 51]) expect(text).not.toContain(punishIdOf(index));
  for (const index of [2, 3, 4, 5, 6, 7, 8, 9]) expect(text).toContain(punishIdOf(index));
});

it('[AC-B1-04zzp#3] 外层字段与 JSON 数字原文原样：顶层其余键、page_no / page_size、total_count（不随删行改）、data 下其余键都在；长整型与小数的原文不失真', async () => {
  const mine = {
    ...punishOf(1),
    tb_trade_id: num('2900000000000002123'),
    relation_id: num('2700000000000000123'),
    synthetic_rate: num('0.29999999999999999'),
    synthetic_tiny: num('1E-7'),
  };
  const retired = { ...punishOf(2, RETIRED_ADZONE), punish_status: num('2') };
  const options = {
    total: 7,
    top: {
      request_id: 'synthetic-punish-archive-request-0003',
      cache: false,
      server_time: num('1793433600123'),
    },
    data: {
      synthetic_flag: true,
      synthetic_total: num('9007199254740993'),
      synthetic_note: '合成外层字段',
    },
  };
  const rows = [
    { ...punishOf(50, FOREIGN_ADZONE), synthetic_rate: num('0.10000000000000001') },
    mine,
    foreignText(51, OTHER_FOREIGN_ADZONE),
    retired,
  ];
  const h = wire(() => answer(punishBody(rows, options)));

  const page = await listed(h.adapter.listPunishments(win, PLAIN));

  expect(page.items.map((item) => item.order_id)).toEqual(['2900000000000002123', punishIdOf(2)]);
  expect(page.nextCursor, 'total_count 7 > 4 rows seen: another page follows').toBeTypeOf('string');
  const text = expectArchivedAs(
    onlyArchiveOf(h.database, PUNISH_PATH),
    punishBody([mine, retired], options),
  );
  for (const literal of [
    '0.29999999999999999',
    '2900000000000002123',
    '2700000000000000123',
    '9007199254740993',
    '1793433600123',
    '1E-7',
  ]) {
    expect(text, `literal ${literal} kept as written`).toContain(literal);
  }
  expect(text).not.toContain('0.10000000000000001');
});

it('[AC-B1-04zzp#4] 一整页全是别家行：违规归档里 results 为空数组，其余字段保留；listPunishments 照常给空页，别家计数仍是这一页一条', async () => {
  const rows = [
    punishOf(50, FOREIGN_ADZONE),
    punishOf(51, OTHER_FOREIGN_ADZONE),
    foreignText(52, FOREIGN_ADZONE),
  ];
  const options = {
    top: { request_id: 'synthetic-punish-archive-request-0004' },
    data: { synthetic_note: '整页别家' },
  };
  const h = wire(() => answer(punishBody(rows, options)));

  const page = await listed(h.adapter.listPunishments(win, PLAIN));

  expect(page.items).toEqual([]);
  expect(page.nextCursor).toBeNull();
  const text = expectArchivedAs(
    onlyArchiveOf(h.database, PUNISH_PATH),
    punishBody([], { ...options, total: rows.length }),
  );
  expect(text).toContain('results');
  for (const index of [50, 51, 52]) expect(text).not.toContain(punishIdOf(index));
  expect(punishForeignCounts(h)).toEqual([3]);
});
