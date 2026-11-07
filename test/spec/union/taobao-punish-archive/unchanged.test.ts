// B1-04zzp（D10-793 ①）：违规报文里没有可删的行（只有自家行 / 读不出推广位的行 / 空页），或 data.results
// 不是数组（缺失、null、对象，data 本身不是对象）时，归档逐字节就是收到的原文、error_code 为空；同一适配器
// 接着取的混合页，归档已去掉别家行（改写只在有别家行可删时发生）。报文全部合成。
import { expect, it } from 'vitest';
import {
  PLAIN,
  answer,
  expectArchivedAs,
  payloadText,
  regardless,
  win,
  wire,
} from '../taobao-order-archive/kit.ts';
import {
  FOREIGN_ADZONE,
  RETIRED_ADZONE,
  jsonText,
  listed,
  num,
  punishOf,
} from '../taobao-refunds/kit.ts';
import { punishBody, punishIdOf } from './kit.ts';

const MIXED = [punishOf(11), punishOf(60, FOREIGN_ADZONE)];

const CASES: readonly { readonly label: string; readonly body: string }[] = [
  {
    label: '只有自家行（在用与已停用），报文带多余空白',
    body: punishBody([punishOf(1), punishOf(2, RETIRED_ADZONE)]).replace(/,"/g, ', "'),
  },
  {
    label: '只有自家行与读不出推广位的行',
    body: punishBody([
      punishOf(1),
      { ...punishOf(2), tk_adzone_id: undefined },
      { ...punishOf(3), tk_adzone_id: 'synthetic-slot' },
      'synthetic-punish-row-as-text',
    ]),
  },
  { label: '空页', body: punishBody([]) },
  { label: 'data.results 缺失', body: punishBody([], { data: { results: undefined } }) },
  { label: 'data.results 是 null', body: punishBody([], { total: 0, data: { results: null } }) },
  {
    label: 'data.results 是对象（里面夹着别家推广位的行）',
    body: punishBody([], {
      total: 1,
      data: { results: { list: [punishOf(61, FOREIGN_ADZONE)] } },
    }),
  },
  {
    label: 'data 不是对象（数组里夹着别家推广位的行）',
    body: jsonText({
      time: num('1793433600000'),
      code: num('0'),
      msg: '成功',
      data: [punishOf(62, FOREIGN_ADZONE)],
    }),
  },
];

it.each(CASES)(
  '[AC-B1-04zzp#5] $label：违规归档逐字节就是收到的原文、error_code 为空；同一适配器接着取的混合页归档已去掉别家行',
  async ({ body }) => {
    let served = 0;
    const h = wire(() => {
      served += 1;
      return answer(served === 1 ? body : punishBody(MIXED));
    });

    await regardless(() => h.adapter.listPunishments(win, PLAIN));
    const page = await listed(h.adapter.listPunishments(win, PLAIN));

    expect(h.upstream).toHaveBeenCalledTimes(2);
    expect(h.database.inserted, 'one archive row per upstream page').toHaveLength(2);
    const [first, second] = h.database.inserted;
    expect(payloadText(first!), 'nothing to drop: the body as received').toBe(body);
    expect(first!.values['error_code']).toBeNull();
    expect(page.items.map((item) => item.order_id)).toEqual([punishIdOf(11)]);
    const text = expectArchivedAs(second!, punishBody([punishOf(11)], { total: MIXED.length }));
    expect(text).not.toContain(punishIdOf(60));
    expect(second!.values['error_code']).toBeNull();
  },
);
