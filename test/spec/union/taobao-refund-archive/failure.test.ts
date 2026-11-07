// B1-04zzu（D10-796 ② 甲）：
// - 自家订单查询失败（端口抛错）：归档照样插入一行，存收到的原文（不是空串），error_code 记新码
//   archive_body_lookup_failed（与 archive_body_rewrite_failed 不同）；listRefunds 的结果不受影响；日志不带单号、
//   维权号、金额，也不带查询错误的原文。
// - 注入查询而维权正文不是 JSON：仍是既有行为——payload 存空串，error_code 上游有码取上游的（http_<status>），
//   否则 archive_body_rewrite_failed；listRefunds 仍以 UnionError 失败。报文全部合成。
import { expect, it } from 'vitest';
import { UnionError } from '../../../../apps/api/src/modules/union/domain/types.ts';
import { ARCHIVE_BODY_FAILED } from '../../../../apps/api/src/modules/union/infra/archive.ts';
import {
  answer,
  onlyArchiveOf,
  payloadBytes,
  payloadText,
  refusal,
  sha256Hex,
  win,
  wire,
} from '../taobao-order-archive/kit.ts';
import { listed, refundOf } from '../taobao-refunds/kit.ts';
import {
  AMOUNTS,
  LOOKUP_FAILED,
  PLAIN,
  REFUND_PATH,
  failingOwnOrders,
  loggedText,
  ownOrders,
  refundBody,
  suitIdOf,
  tradeIdOf,
  wireRefunds,
} from './kit.ts';

const LOOKUP_ERRORS: readonly { readonly label: string; readonly error: unknown }[] = [
  {
    label: '普通 Error（消息里带单号）',
    error: new Error(`synthetic own-order lookup outage at ${tradeIdOf(50)}`),
  },
  {
    label: 'UnionError（无数据库）',
    error: new UnionError(
      'adapter_unimplemented',
      `synthetic: no database to read own orders (${tradeIdOf(51)})`,
      'taobao',
    ),
  },
];

it.each(LOOKUP_ERRORS)(
  '[AC-B1-04zzu#9] 自家订单查询失败（$label）：维权归档照样插入一行、存收到的原文（content_hash 对得上），error_code 是 archive_body_lookup_failed；listRefunds 的结果与不注入查询时相同；日志不带单号、维权号、金额与错误原文',
  async ({ error }) => {
    const rows = [refundOf(1), refundOf(50), refundOf(51)];
    const body = refundBody(rows, { hasNext: true, position: 'synthetic-refund-position-0009' });
    const reader = failingOwnOrders(error);
    const h = wireRefunds(() => answer(body), { ownOrders: reader });
    const plain = wire(() => answer(body));

    const page = await listed(h.adapter.listRefunds(win, PLAIN));
    const before = await listed(plain.adapter.listRefunds(win, PLAIN));

    expect(page.items).toEqual(before.items);
    expect(page.items.map((item) => item.refund_id)).toEqual(
      [1, 50, 51].map((suit) => suitIdOf(suit)),
    );
    expect(page.nextCursor).toBe(before.nextCursor);
    expect(reader).toHaveBeenCalled();
    expect(h.database.inserted, 'the archive row is still inserted').toHaveLength(1);
    const row = onlyArchiveOf(h.database, REFUND_PATH);
    expect(row.values['kind']).toBe('order');
    expect(payloadText(row), 'the body as received, not an empty one').toBe(body);
    expect(row.values['content_hash']).toBe(sha256Hex(payloadBytes(row)));
    expect(LOOKUP_FAILED).not.toBe(ARCHIVE_BODY_FAILED);
    expect(row.values['error_code']).toBe(LOOKUP_FAILED);
    const logs = loggedText(h);
    for (const index of [1, 50, 51]) {
      expect(logs).not.toContain(tradeIdOf(index));
      expect(logs).not.toContain(suitIdOf(index));
    }
    for (const amount of AMOUNTS) expect(logs).not.toContain(amount);
    expect(logs).not.toContain('synthetic own-order lookup outage');
    expect(logs).not.toContain('synthetic: no database to read own orders');
  },
);

const NOT_JSON: readonly {
  readonly label: string;
  readonly status: number;
  readonly body: string;
  readonly code: string;
}[] = [
  {
    label: '200 纯文本',
    status: 200,
    body: 'synthetic refund gateway hiccup: not json at all',
    code: ARCHIVE_BODY_FAILED,
  },
  {
    label: '200 截断的 JSON（夹着别家的维权行）',
    status: 200,
    body: refundBody([refundOf(1), refundOf(50)]).slice(0, -9),
    code: ARCHIVE_BODY_FAILED,
  },
  {
    label: '502 纯文本（上游有码）',
    status: 502,
    body: 'synthetic refund upstream outage: not json either',
    code: 'http_502',
  },
];

it.each(NOT_JSON)(
  '[AC-B1-04zzu#10] 注入查询、维权正文不是 JSON（$label）：归档照样插入一行，payload 是空串的 gzip（content_hash 对得上），error_code 是 $code；listRefunds 仍以 UnionError 失败，日志不带单号',
  async ({ status, body, code }) => {
    const own = ownOrders([tradeIdOf(1)]);
    const h = wireRefunds(() => answer(body, status), { ownOrders: own.reader });

    const error = await refusal(() => h.adapter.listRefunds(win, PLAIN));

    expect(error).toBeInstanceOf(UnionError);
    expect(error).toMatchObject({ platform: 'taobao' });
    expect(h.upstream).toHaveBeenCalledTimes(1);
    expect(h.database.inserted, 'the archive row is still inserted').toHaveLength(1);
    const row = onlyArchiveOf(h.database, REFUND_PATH);
    expect(row.values['kind']).toBe('order');
    expect(payloadText(row)).toBe('');
    expect(row.values['content_hash']).toBe(sha256Hex(payloadBytes(row)));
    expect(row.values['error_code']).toBe(code);
    const logs = loggedText(h);
    for (const index of [1, 50]) expect(logs).not.toContain(tradeIdOf(index));
    expect(logs).not.toContain(body);
  },
);
