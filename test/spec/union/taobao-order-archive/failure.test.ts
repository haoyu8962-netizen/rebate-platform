// B1-04zzc（D10-776 方案 A）：订单详情报文改写失败（报文不是 JSON）时归档照样插入一行：payload 存空串（不留
// 可能夹着别家行的原文），记 error_code；不放弃插入、不影响调用结果（listOrders 仍是 upstream_unavailable）。
import { expect, it } from 'vitest';
import { UnionError } from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  COLLECT,
  ORDER_PATH,
  answer,
  foreign,
  idOf,
  onlyArchiveOf,
  orderBody,
  ours,
  payloadBytes,
  payloadText,
  refusal,
  sha256Hex,
  win,
  wire,
} from './kit.ts';

const CASES: readonly { readonly label: string; readonly body: string }[] = [
  { label: '纯文本', body: 'synthetic gateway hiccup: not json at all' },
  {
    label: '截断的 JSON（夹着别家行）',
    body: orderBody([ours(1), foreign(50)]).slice(0, -9),
  },
];

it.each(CASES)(
  '[AC-B1-04zzc#10] $label：归档照样插入一行，payload 是空串的 gzip（content_hash 对得上），error_code 有值；listOrders 仍以 upstream_unavailable 失败',
  async ({ body }) => {
    const h = wire(() => answer(body));

    const error = await refusal(() => h.adapter.listOrders(win, {}, COLLECT));

    expect(error).toBeInstanceOf(UnionError);
    expect(error).toMatchObject({ code: 'upstream_unavailable', platform: 'taobao' });
    expect(h.upstream).toHaveBeenCalledTimes(1);
    expect(h.database.inserted, 'the archive row is still inserted').toHaveLength(1);
    const row = onlyArchiveOf(h.database, ORDER_PATH);
    expect(row.values['kind']).toBe('order');
    expect(payloadText(row)).toBe('');
    expect(row.values['content_hash']).toBe(sha256Hex(payloadBytes(row)));
    expect(row.values['error_code']).toEqual(expect.any(String));
    expect(String(row.values['error_code']).trim()).not.toBe('');
    expect(payloadText(row)).not.toContain(idOf(50));
  },
);
