// B1-04zgb（FU-TB-ARCHIVE-EDGE ①）订单详情：上游正文同一对象里出现重复键时，订单详情请求的归档存的是按
// JSON.parse 语义（后出现者胜）重新序列化、再按推广位删别家行的报文——被覆盖那一份的单号、推广位与其它内容都
// 不在 gunzip 后的 payload 里，也没有重复键；数字原文、外层字段、读不出推广位的行照旧。listOrders 的条目与告警
// 和「只含后出现那一份」的正常报文一样。走真实 createArchivingTransport + 淘宝适配器，报文全部手写合成。
import { expect, it } from 'vitest';
import {
  FOREIGN_ADZONE,
  ORDER_PATH,
  OTHER_FOREIGN_ADZONE,
  OUR_ADZONE,
  PLAIN,
  RETIRED_ADZONE,
  answer,
  expectArchivedAs,
  foreign,
  foreignCounts,
  idOf,
  num,
  onlyArchiveOf,
  orderBody,
  ours,
  payloadText,
  resolvedPage,
  win,
  wire,
} from '../taobao-order-archive/kit.ts';
import {
  array,
  dtoList,
  duplicateKeys,
  expectNoDuplicateKeys,
  expectNoneOf,
  member,
  object,
  orderDataText,
  orderEnvelope,
  orderRowWith,
  orderTexts,
  str,
} from './kit.ts';

/** listOrders on a body without duplicate keys: the page and the warnings it gives. */
async function plainRun(body: string) {
  const c = wire(() => answer(body));
  const page = await resolvedPage(() => c.adapter.listOrders(win, {}, PLAIN));
  return { c, page };
}

it('[AC-B1-04zgb#1] 订单：data 里 results 键出现两次（前一份有别家行与自家行，后一份只有自家行）：归档是后一份按解析语义重写的报文，前一份的单号与别家推广位一个字也没有，也没有重复键；对照：没有重复键的同页报文逐字节原样存，listOrders 条目与告警两者一样', async () => {
  const kept = [ours(1), ours(2, RETIRED_ADZONE)];
  const body = orderEnvelope(
    member(
      'data',
      orderDataText(
        member('results', dtoList(...orderTexts([foreign(50), ours(9)]))),
        member('results', dtoList(...orderTexts(kept))),
      ),
    ),
  );
  const normal = orderEnvelope(
    member('data', orderDataText(member('results', dtoList(...orderTexts(kept))))),
  );
  expect(duplicateKeys(body), 'the fixture repeats results').toEqual(['results']);
  const h = wire(() => answer(body));

  const page = await resolvedPage(() => h.adapter.listOrders(win, {}, PLAIN));

  expect(page.items.map((order) => order.order_id)).toEqual([idOf(1), idOf(2)]);
  expect(foreignCounts(h), 'the parsed page holds no foreign row').toEqual([]);
  expect(h.database.inserted, 'one archive row for the one upstream page').toHaveLength(1);
  const text = expectArchivedAs(onlyArchiveOf(h.database, ORDER_PATH), orderBody(kept));
  expectNoneOf(text, [idOf(50), idOf(9), FOREIGN_ADZONE]);
  expectNoDuplicateKeys(text);

  const { c, page: plainPage } = await plainRun(normal);
  expect(payloadText(onlyArchiveOf(c.database, ORDER_PATH)), 'no duplicate key: as received').toBe(
    normal,
  );
  expect(page).toEqual(plainPage);
  expect(h.orderWarn.mock.calls).toEqual(c.orderWarn.mock.calls);
});

it('[AC-B1-04zgb#2] 订单：results 里 publisher_order_dto 键出现两次（前一份是别家行与已停用推广位的自家行，后一份一行自家行）：归档只剩后一份，前一份的单号与推广位都不在，也没有重复键；对照：没有重复键而有别家行的报文照旧只删别家行', async () => {
  const kept = [ours(3)];
  const body = orderEnvelope(
    member(
      'data',
      orderDataText(
        member(
          'results',
          object(
            member(
              'publisher_order_dto',
              array(
                ...orderTexts([foreign(51, OTHER_FOREIGN_ADZONE, true), ours(8, RETIRED_ADZONE)]),
              ),
            ),
            member('publisher_order_dto', array(...orderTexts(kept))),
          ),
        ),
      ),
    ),
  );
  expect(duplicateKeys(body), 'the fixture repeats publisher_order_dto').toEqual([
    'publisher_order_dto',
  ]);
  const h = wire(() => answer(body));

  const page = await resolvedPage(() => h.adapter.listOrders(win, {}, PLAIN));

  expect(page.items.map((order) => order.order_id)).toEqual([idOf(3)]);
  expect(foreignCounts(h)).toEqual([]);
  const text = expectArchivedAs(onlyArchiveOf(h.database, ORDER_PATH), orderBody(kept));
  expectNoneOf(text, [idOf(51), idOf(8), OTHER_FOREIGN_ADZONE, RETIRED_ADZONE]);
  expectNoDuplicateKeys(text);

  const mixedRows = orderTexts([foreign(51, OTHER_FOREIGN_ADZONE, true), ours(3)]);
  const mixed = orderEnvelope(
    member('data', orderDataText(member('results', dtoList(...mixedRows)))),
  );
  const { c } = await plainRun(mixed);
  const contrast = expectArchivedAs(onlyArchiveOf(c.database, ORDER_PATH), orderBody(kept));
  expect(contrast).not.toContain(idOf(51));
  expect(foreignCounts(c), 'the foreign row is counted when it is parsed').toEqual([1]);
});

it('[AC-B1-04zgb#3] 订单：行内重复键（别家行后面再写一遍 trade_id 与自家 adzone_id、同名备注写两遍、alimm_share_info_dto 里服务费写两遍）：归档里每行只有后出现的值，被覆盖的单号、别家推广位、备注与服务费原文都不在，也没有重复键；listOrders 与只含后出现值的正常报文一样', async () => {
  const fourth = orderRowWith(
    foreign(60),
    member('trade_id', str(idOf(4))),
    member('adzone_id', OUR_ADZONE),
  );
  const fifth = orderRowWith(
    ours(5, OUR_ADZONE, { synthetic_note: '被覆盖-0005' }),
    member('synthetic_note', str('保留-0005')),
  );
  const sixth = orderRowWith(
    ours(6, OUR_ADZONE, { alimm_share_info_dto: undefined }),
    member(
      'alimm_share_info_dto',
      object(
        member('alimm_tech_service_fee', '0.31415'),
        member('alimm_tech_service_fee', '1'),
        member('alimm_tech_service_pre_fee', '0.5'),
        member('alimm_tech_service_rate', '10'),
      ),
    ),
  );
  const body = orderEnvelope(
    member(
      'data',
      orderDataText(member('results', dtoList(...orderTexts([ours(1)]), fourth, fifth, sixth))),
    ),
  );
  const expected = [
    ours(1),
    ours(4),
    ours(5, OUR_ADZONE, { synthetic_note: '保留-0005' }),
    ours(6),
  ];
  expect(duplicateKeys(body), 'the fixture repeats members inside rows').toEqual([
    'trade_id',
    'adzone_id',
    'synthetic_note',
    'alimm_tech_service_fee',
  ]);
  const h = wire(() => answer(body));

  const page = await resolvedPage(() => h.adapter.listOrders(win, {}, PLAIN));

  expect(page.items.map((order) => order.order_id)).toEqual([idOf(1), idOf(4), idOf(5), idOf(6)]);
  const text = expectArchivedAs(onlyArchiveOf(h.database, ORDER_PATH), orderBody(expected));
  expectNoneOf(text, [idOf(60), FOREIGN_ADZONE, '被覆盖-0005', '0.31415']);
  expectNoDuplicateKeys(text);

  const { c, page: plainPage } = await plainRun(orderBody(expected));
  expect(page).toEqual(plainPage);
  expect(h.orderWarn.mock.calls).toEqual(c.orderWarn.mock.calls);
});

it('[AC-B1-04zgb#4] 订单：顶层 data 与 request_id 各出现两次（前一份 data 全是别家行）：归档只有后一份 data 与后一个 request_id，别家单号、推广位、被覆盖的 data 成员与 request_id 都不在，也没有重复键', async () => {
  const foreignRows = orderTexts([foreign(50), foreign(52, FOREIGN_ADZONE, true)]);
  const body = orderEnvelope(
    member('request_id', str('synthetic-overwritten-request-0004')),
    member(
      'data',
      orderDataText(
        member('results', dtoList(...foreignRows)),
        member('synthetic_note', str('被覆盖的 data')),
      ),
    ),
    member('data', orderDataText(member('results', dtoList(...orderTexts([ours(1)]))))),
    member('request_id', str('synthetic-kept-request-0004')),
  );
  const expected = orderBody([ours(1)], { top: { request_id: 'synthetic-kept-request-0004' } });
  expect(duplicateKeys(body), 'the fixture repeats data and request_id').toEqual([
    'data',
    'request_id',
  ]);
  const h = wire(() => answer(body));

  const page = await resolvedPage(() => h.adapter.listOrders(win, {}, PLAIN));

  expect(page.items.map((order) => order.order_id)).toEqual([idOf(1)]);
  expect(foreignCounts(h)).toEqual([]);
  const text = expectArchivedAs(onlyArchiveOf(h.database, ORDER_PATH), expected);
  expectNoneOf(text, [
    idOf(50),
    idOf(52),
    FOREIGN_ADZONE,
    'synthetic-overwritten-request-0004',
    '被覆盖的 data',
  ]);
  expect(text).toContain('synthetic-kept-request-0004');
  expectNoDuplicateKeys(text);
});

it('[AC-B1-04zgb#5] 订单：重复键报文重写后数字原文保真（长整型单号、0.29999999999999999、7.10、1E-7、超 2^53 的外层整数）、外层字段保留、读不出推广位的坏行（缺 adzone_id、整行不是对象）照样在；被覆盖那一份的小数与外层时间戳都不在', async () => {
  const mine = ours(1, OUR_ADZONE, {
    trade_parent_id: num('2900000000000000123'),
    income: num('0.29999999999999999'),
    price_by_one: num('7.10'),
    income_by_one: num('1E-7'),
  });
  const unreadable = ours(7, OUR_ADZONE, { adzone_id: undefined });
  const notObject = num('2900000000000001999');
  const retired = ours(2, RETIRED_ADZONE, { item_num: num('12') });
  const kept = [mine, unreadable, notObject, retired];
  const overwritten = { ...foreign(50), income: num('0.10000000000000001') };
  const body = orderEnvelope(
    member('server_time', '1793600000999'),
    member('cache', 'false'),
    member(
      'data',
      orderDataText(
        member('total_results', '9007199254740993'),
        member('synthetic_note', str('合成外层字段')),
        member('results', dtoList(...orderTexts([overwritten]))),
        member('results', dtoList(...orderTexts(kept))),
      ),
    ),
    member('server_time', '1793600000123'),
  );
  const options = {
    top: { server_time: num('1793600000123'), cache: false },
    data: { total_results: num('9007199254740993'), synthetic_note: '合成外层字段' },
  };
  expect(duplicateKeys(body), 'the fixture repeats results and server_time').toEqual([
    'results',
    'server_time',
  ]);
  const h = wire(() => answer(body));

  const page = await resolvedPage(() => h.adapter.listOrders(win, {}, PLAIN));

  expect(page.items.map((order) => order.order_id)).toEqual([idOf(1), idOf(2)]);
  const text = expectArchivedAs(onlyArchiveOf(h.database, ORDER_PATH), orderBody(kept, options));
  for (const literal of [
    '0.29999999999999999',
    '2900000000000000123',
    '9007199254740993',
    '1793600000123',
    '7.10',
    '1E-7',
    '2900000000000001999',
    idOf(7),
  ]) {
    expect(text, `literal ${literal} kept as written`).toContain(literal);
  }
  expectNoneOf(text, [idOf(50), '0.10000000000000001', '1793600000999', FOREIGN_ADZONE]);
  expectNoDuplicateKeys(text);

  const { c, page: plainPage } = await plainRun(orderBody(kept, options));
  expect(page).toEqual(plainPage);
  expect(h.orderWarn.mock.calls).toEqual(c.orderWarn.mock.calls);
});
