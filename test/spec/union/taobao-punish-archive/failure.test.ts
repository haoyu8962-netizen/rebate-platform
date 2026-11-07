// B1-04zzp（D10-793 ①）：违规报文不是 JSON（改写读不了）时，既有归档包装照样插入一行：payload 存空串（不留
// 可能夹着别家行的原文），记 error_code——上游有码（非 2xx 的 http_<status>）取上游的，否则
// archive_body_rewrite_failed；不放弃插入，listPunishments 仍以 UnionError 失败。报文全部合成。
import { expect, it } from 'vitest';
import { UnionError } from '../../../../apps/api/src/modules/union/domain/types.ts';
import { ARCHIVE_BODY_FAILED } from '../../../../apps/api/src/modules/union/infra/archive.ts';
import {
  PLAIN,
  PUNISH_PATH,
  answer,
  onlyArchiveOf,
  payloadBytes,
  payloadText,
  refusal,
  sha256Hex,
  visible,
  win,
  wire,
} from '../taobao-order-archive/kit.ts';
import { FOREIGN_ADZONE, punishOf } from '../taobao-refunds/kit.ts';
import { punishBody, punishIdOf } from './kit.ts';

const CASES: readonly {
  readonly label: string;
  readonly status: number;
  readonly body: string;
  readonly code: string;
}[] = [
  {
    label: '200 纯文本',
    status: 200,
    body: 'synthetic punish gateway hiccup: not json at all',
    code: ARCHIVE_BODY_FAILED,
  },
  {
    label: '200 截断的 JSON（夹着别家行）',
    status: 200,
    body: punishBody([punishOf(1), punishOf(50, FOREIGN_ADZONE)]).slice(0, -9),
    code: ARCHIVE_BODY_FAILED,
  },
  {
    label: '502 纯文本（上游有码）',
    status: 502,
    body: 'synthetic punish upstream outage: not json either',
    code: 'http_502',
  },
];

it.each(CASES)(
  '[AC-B1-04zzp#6] $label：违规归档照样插入一行，payload 是空串的 gzip（content_hash 对得上），error_code 是 $code；listPunishments 仍以 UnionError 失败',
  async ({ status, body, code }) => {
    const h = wire(() => answer(body, status));

    const error = await refusal(() => h.adapter.listPunishments(win, PLAIN));

    expect(error).toBeInstanceOf(UnionError);
    expect(error).toMatchObject({ platform: 'taobao' });
    expect(h.upstream).toHaveBeenCalledTimes(1);
    expect(h.database.inserted, 'the archive row is still inserted').toHaveLength(1);
    const row = onlyArchiveOf(h.database, PUNISH_PATH);
    expect(row.values['kind']).toBe('order');
    expect(payloadText(row)).toBe('');
    expect(row.values['content_hash']).toBe(sha256Hex(payloadBytes(row)));
    expect(row.values['error_code']).toBe(code);
    const logs = visible([h.logger.warn.mock.calls, h.logger.error.mock.calls]);
    for (const index of [1, 50]) expect(logs).not.toContain(punishIdOf(index));
    expect(logs).not.toContain(body);
  },
);
