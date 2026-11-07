// B1-04zzp（D10-793 ①）：维权 get-order-refund 不在本单范围——同一适配器、同一归档传输上，维权请求的归档仍是
// 收到的原文（连夹带的、违规形状的别家行也不动），违规请求的归档已去掉别家行。报文全部合成。
import { expect, it } from 'vitest';
import {
  PLAIN,
  PUNISH_PATH,
  REFUND_PATH,
  answer,
  expectArchivedAs,
  onlyArchiveOf,
  payloadText,
  regardless,
  win,
  wire,
} from '../taobao-order-archive/kit.ts';
import {
  FOREIGN_ADZONE,
  OTHER_FOREIGN_ADZONE,
  listed,
  num,
  punishOf,
  refundData,
  refundOf,
  reply,
} from '../taobao-refunds/kit.ts';
import { punishBody, punishIdOf } from './kit.ts';

it('[AC-B1-04zzp#9] 维权的归档仍是收到的原文（夹带的别家违规形状行也在），同一适配器的违规归档已去掉别家行', async () => {
  const refundBody = reply({
    ...refundData([{ ...refundOf(1), tk_adzone_id: num(FOREIGN_ADZONE) }, refundOf(2)]),
    results: [punishOf(70, FOREIGN_ADZONE)],
  }).body;
  const punishRows = [
    punishOf(1),
    punishOf(50, FOREIGN_ADZONE),
    punishOf(51, OTHER_FOREIGN_ADZONE),
  ];
  const h = wire((call) =>
    answer(
      call.path === REFUND_PATH
        ? refundBody
        : call.path === PUNISH_PATH
          ? punishBody(punishRows)
          : '{"code":-1,"msg":"synthetic unexpected path"}',
    ),
  );

  await regardless(() => h.adapter.listRefunds(win, PLAIN));
  await listed(h.adapter.listPunishments(win, PLAIN));

  const refundRow = onlyArchiveOf(h.database, REFUND_PATH);
  expect(refundRow.values['kind']).toBe('order');
  expect(payloadText(refundRow)).toBe(refundBody);
  expect(payloadText(refundRow)).toContain(punishIdOf(70));
  const punishRow = onlyArchiveOf(h.database, PUNISH_PATH);
  expect(punishRow.values['kind']).toBe('order');
  const text = expectArchivedAs(punishRow, punishBody([punishOf(1)], { total: punishRows.length }));
  for (const index of [50, 51]) expect(text).not.toContain(punishIdOf(index));
});
