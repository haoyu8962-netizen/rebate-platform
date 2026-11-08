// B1-04zgb（FU-TB-ARCHIVE-EDGE ①）违规：get-foul-order-list 正文同一对象里出现重复键时，违规请求的归档存的是按
// JSON.parse 语义（后出现者胜）重新序列化、再按 tk_adzone_id 删别家行的报文——被覆盖那一份的单号、推广位与其它
// 内容都不在 gunzip 后的 payload 里，也没有重复键；数字原文、外层字段（total_count 照后出现的值）、读不出推广位的
// 行照旧。listPunishments 的条目与告警和「只含后出现那一份」的正常报文一样。走真实 createArchivingTransport +
// 淘宝适配器，报文全部手写合成。
import { expect, it } from 'vitest';
import {
  PLAIN,
  PUNISH_PATH,
  answer,
  expectArchivedAs,
  onlyArchiveOf,
  payloadText,
  win,
  wire,
} from '../taobao-order-archive/kit.ts';
import {
  FOREIGN_ADZONE,
  OTHER_FOREIGN_ADZONE,
  OUR_ADZONE,
  RETIRED_ADZONE,
  listed,
  num,
  punishOf,
} from '../taobao-refunds/kit.ts';
import {
  afterSalesEnvelope,
  afterSalesRowWith,
  afterSalesTexts,
  array,
  duplicateKeys,
  expectNoDuplicateKeys,
  expectNoneOf,
  member,
  punishDataText,
  punishExpected,
  punishIdOf,
  str,
} from './kit.ts';

/** listPunishments on a body without duplicate keys: the page and the warnings it gives. */
async function plainRun(body: string) {
  const c = wire(() => answer(body));
  const page = await listed(c.adapter.listPunishments(win, PLAIN));
  return { c, page };
}

it('[AC-B1-04zgb#6] 违规：data 里 results 键出现两次（前一份有别家行与自家行，后一份只有自家行）：归档是后一份按解析语义重写的报文，前一份的单号与别家推广位一个字也没有，也没有重复键；对照：没有重复键的同页报文逐字节原样存，listPunishments 条目与告警两者一样', async () => {
  const kept = [punishOf(1), punishOf(2, RETIRED_ADZONE)];
  const overwritten = afterSalesTexts([punishOf(50, FOREIGN_ADZONE), punishOf(9)]);
  const body = afterSalesEnvelope(
    member(
      'data',
      punishDataText(
        member('total_count', '2'),
        member('results', array(...overwritten)),
        member('results', array(...afterSalesTexts(kept))),
      ),
    ),
  );
  const keptRows = afterSalesTexts(kept);
  const normal = afterSalesEnvelope(
    member(
      'data',
      punishDataText(member('total_count', '2'), member('results', array(...keptRows))),
    ),
  );
  expect(duplicateKeys(body), 'the fixture repeats results').toEqual(['results']);
  const h = wire(() => answer(body));

  const page = await listed(h.adapter.listPunishments(win, PLAIN));

  expect(page.items.map((item) => item.order_id)).toEqual([punishIdOf(1), punishIdOf(2)]);
  expect(page.nextCursor).toBeNull();
  expect(h.database.inserted, 'one archive row for the one upstream page').toHaveLength(1);
  const text = expectArchivedAs(onlyArchiveOf(h.database, PUNISH_PATH), punishExpected(kept, 2));
  expectNoneOf(text, [punishIdOf(50), punishIdOf(9), FOREIGN_ADZONE]);
  expectNoDuplicateKeys(text);

  const { c, page: plainPage } = await plainRun(normal);
  expect(payloadText(onlyArchiveOf(c.database, PUNISH_PATH)), 'no duplicate key: as received').toBe(
    normal,
  );
  expect(page).toEqual(plainPage);
  expect(h.punishWarn.mock.calls).toEqual(c.punishWarn.mock.calls);
});

it('[AC-B1-04zgb#7] 违规：行内重复键（别家行后面再写一遍 tb_trade_id 与自家 tk_adzone_id——键名用 \\u005f 转义也是同一个键、同名备注写两遍、读不出推广位的行里 relation_id 写两遍）：归档里每行只有后出现的值，被覆盖的单号、别家推广位、备注与长整型都不在，也没有重复键；读不出推广位的行照样在', async () => {
  const fourth = afterSalesRowWith(
    punishOf(60, FOREIGN_ADZONE),
    member('tb_trade_id', str(punishIdOf(4))),
    member('tk\\u005fadzone_id', OUR_ADZONE),
  );
  const sixth = afterSalesRowWith(
    { ...punishOf(6), synthetic_note: '被覆盖-0006' },
    member('synthetic_note', str('保留-0006')),
  );
  const seventh = afterSalesRowWith(
    { ...punishOf(7), tk_adzone_id: 'synthetic-slot', relation_id: num('2700000000000000077') },
    member('relation_id', '2700000001'),
  );
  const expected = [
    punishOf(1),
    punishOf(4),
    { ...punishOf(6), synthetic_note: '保留-0006' },
    { ...punishOf(7), tk_adzone_id: 'synthetic-slot' },
  ];
  const body = afterSalesEnvelope(
    member(
      'data',
      punishDataText(
        member('total_count', '4'),
        member('results', array(...afterSalesTexts([punishOf(1)]), fourth, sixth, seventh)),
      ),
    ),
  );
  expect(duplicateKeys(body), 'the fixture repeats members inside rows').toEqual([
    'tb_trade_id',
    'tk_adzone_id',
    'synthetic_note',
    'relation_id',
  ]);
  const h = wire(() => answer(body));

  const page = await listed(h.adapter.listPunishments(win, PLAIN));

  expect(page.items.map((item) => item.order_id)).toEqual([
    punishIdOf(1),
    punishIdOf(4),
    punishIdOf(6),
  ]);
  const text = expectArchivedAs(
    onlyArchiveOf(h.database, PUNISH_PATH),
    punishExpected(expected, 4),
  );
  expectNoneOf(text, [punishIdOf(60), FOREIGN_ADZONE, '被覆盖-0006', '2700000000000000077']);
  expect(text, 'the row whose slot cannot be read stays').toContain(punishIdOf(7));
  expectNoDuplicateKeys(text);

  const { c, page: plainPage } = await plainRun(punishExpected(expected, 4));
  expect(page).toEqual(plainPage);
  expect(h.punishWarn.mock.calls).toEqual(c.punishWarn.mock.calls);
});

it('[AC-B1-04zgb#8] 违规：顶层 data 与 server_time 各出现两次（前一份 data 全是别家行），后一份 data 里 total_count 也写两遍：归档只有后出现的值，别家单号与推广位、被覆盖的 data 成员与时间戳都不在，也没有重复键；数字原文（长整型、0.29999999999999999、1E-7、超 2^53 的整数）保真，外层字段保留', async () => {
  const mine = {
    ...punishOf(1),
    relation_id: num('2700000000000000123'),
    synthetic_rate: num('0.29999999999999999'),
    synthetic_tiny: num('1E-7'),
  };
  const kept = [mine, punishOf(2, RETIRED_ADZONE)];
  const foreignRows = afterSalesTexts([
    punishOf(50, FOREIGN_ADZONE),
    { ...punishOf(51, OTHER_FOREIGN_ADZONE), tk_adzone_id: OTHER_FOREIGN_ADZONE },
    punishOf(52, FOREIGN_ADZONE),
  ]);
  const body = afterSalesEnvelope(
    member('server_time', '1793433600999'),
    member(
      'data',
      punishDataText(
        member('total_count', '3'),
        member('results', array(...foreignRows)),
        member('synthetic_note', str('被覆盖的 data')),
      ),
    ),
    member(
      'data',
      punishDataText(
        member('total_count', '7'),
        member('total_count', '2'),
        member('results', array(...afterSalesTexts(kept))),
        member('synthetic_total', '9007199254740993'),
      ),
    ),
    member('server_time', '1793433600123'),
  );
  const expected = punishExpected(kept, 2, {
    top: { server_time: num('1793433600123') },
    data: { synthetic_total: num('9007199254740993') },
  });
  expect(duplicateKeys(body), 'the fixture repeats data, total_count and server_time').toEqual([
    'data',
    'total_count',
    'server_time',
  ]);
  const h = wire(() => answer(body));

  const page = await listed(h.adapter.listPunishments(win, PLAIN));

  expect(page.items.map((item) => item.order_id)).toEqual([punishIdOf(1), punishIdOf(2)]);
  expect(page.nextCursor).toBeNull();
  const text = expectArchivedAs(onlyArchiveOf(h.database, PUNISH_PATH), expected);
  for (const literal of [
    '2700000000000000123',
    '0.29999999999999999',
    '1E-7',
    '9007199254740993',
    '1793433600123',
  ]) {
    expect(text, `literal ${literal} kept as written`).toContain(literal);
  }
  expectNoneOf(text, [
    punishIdOf(50),
    punishIdOf(51),
    punishIdOf(52),
    FOREIGN_ADZONE,
    OTHER_FOREIGN_ADZONE,
    '被覆盖的 data',
    '1793433600999',
  ]);
  expectNoDuplicateKeys(text);

  const { c, page: plainPage } = await plainRun(expected);
  expect(page).toEqual(plainPage);
  expect(h.punishWarn.mock.calls).toEqual(c.punishWarn.mock.calls);
});
