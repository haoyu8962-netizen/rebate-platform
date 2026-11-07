// B2-04zze rule tests: the Taobao violation text → PUNISH sub-reason table (08 BR-TEXT-05「子原因
// reason_sub」细则「写入来源 ①」: 淘宝（含大淘客）处罚记录 violation_type 文本按上表 desc 逐字匹配，「订单虚假交易」
// 映射 FAKE_TRADE；对不上任何一项 → PUNISH_ORDER 并告警; orchestrator D10-862 ①: the table is
// specs/reason-sub-map/taobao.csv, read once at start and matched exactly, as specs/order-status-map).
// The csv is read here the way the assembly reads it (its text, or null when the file is absent) and
// handed to orders' pure loader; the expected codes are copied by hand from the 08 table. The
// loader's result comes from the csv text only (header violation_type,reason_sub,source,verified,
// note as order-status-map's); a bad table (non-PUNISH or unknown code, repeated violation_type,
// wrong header) is refused at load. Pure functions, no database. Top-level it() only; the property
// runs with propParams().
import { existsSync, readFileSync } from 'node:fs';
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  loadReasonSubMap,
  mapViolationType,
  type ReasonSubMap,
} from '../../../../apps/api/src/modules/orders/domain/reason-sub.ts';
import { order_reason_sub } from '../../../../packages/contracts-ts/src/index.ts';

const TABLE = new URL('../../../../specs/reason-sub-map/taobao.csv', import.meta.url);

/** The Taobao table as the assembly hands it over (null: no file). */
function taobaoMap(): ReasonSubMap {
  return loadReasonSubMap('taobao', existsSync(TABLE) ? readFileSync(TABLE, 'utf8') : null);
}

/** 08 BR-TEXT-05 子原因表, parent PUNISH: [desc as the user reads it, SUB] (PUNISH_ORDER is the fallback). */
const PUNISH_DESC: readonly (readonly [string, string])[] = [
  ['违规推广', 'VIOLATION_PROMO'],
  ['店铺淘宝客', 'SHOP_TK'],
  ['站内推广', 'INSITE_PROMO'],
  ['违规代购', 'PROXY_BUY'],
  ['虚假交易', 'FAKE_TRADE'],
  ['站内二次售卖', 'INSITE_RESALE'],
  ['累计超出上限', 'OVER_LIMIT'],
  ['扰乱市场秩序', 'MARKET_DISRUPT'],
  ['多笔交易异常', 'MULTI_TRADE_ABNORMAL'],
  ['单笔交易异常', 'SINGLE_TRADE_ABNORMAL'],
  ['风险订单', 'RISK_ORDER'],
];

/** The 12 sub-reasons of parent PUNISH (contracts/enums/order.yaml order_reason_sub). */
const PUNISH_SUBS: readonly string[] = [...PUNISH_DESC.map(([, sub]) => sub), 'PUNISH_ORDER'];

it.each([
  ['订单虚假交易', 'FAKE_TRADE'],
  ['店铺淘宝客', 'SHOP_TK'],
] as const)(
  '[AC-B2-04zze#1] 淘宝文档列出的违规类型「%s」逐字对上 → %s（08「订单虚假交易」映射 FAKE_TRADE）',
  (raw, sub) => {
    const map = taobaoMap();
    expect(map.platform).toBe('taobao');
    expect(mapViolationType(map, raw)).toEqual({ kind: 'mapped', sub });
  },
);

it.each(PUNISH_DESC)('[AC-B2-04zze#2] 违规文本恰为 08 子原因表的 desc「%s」→ %s', (raw, sub) => {
  expect(mapViolationType(taobaoMap(), raw)).toEqual({ kind: 'mapped', sub });
});

it.each([
  ['编码形态 1', '1'],
  ['编码形态 2', '2'],
  ['空串', ''],
  ['前有空格', ' 订单虚假交易'],
  ['后有空格', '订单虚假交易 '],
  ['全角空格', '店铺淘宝客　'],
  ['结尾换行', '店铺淘宝客\n'],
  ['多一个标点', '虚假交易。'],
  ['子原因编码本身', 'FAKE_TRADE'],
  ['只含部分文字', '虚假'],
  ['未录制的合成文本', '合成违规类型-甲'],
] as const)(
  '[AC-B2-04zze#3] 违规文本对不上（%s）→ unmapped，原值原样带回，不 trim、不猜',
  (_name, raw) => {
    expect(mapViolationType(taobaoMap(), raw)).toEqual({ kind: 'unmapped', raw });
  },
);

it('[AC-B2-04zze#4] 违规文本为空值（null）→ unmapped，原值 null', () => {
  expect(mapViolationType(taobaoMap(), null)).toEqual({ kind: 'unmapped', raw: null });
});

it('[AC-B2-04zze#5] 表里的每一行都只映射到父编码 PUNISH 的子原因（不会出现 IN_SALE / AFTER_SETTLE / AFTER_SALE），且覆盖 08 的 11 个 desc 与「订单虚假交易」', () => {
  const map = taobaoMap();
  expect(PUNISH_SUBS).toHaveLength(12);
  for (const sub of PUNISH_SUBS) expect(order_reason_sub).toContain(sub);
  for (const [raw, sub] of map.entries) {
    expect(PUNISH_SUBS, raw).toContain(sub);
  }
  for (const [raw, sub] of [...PUNISH_DESC, ['订单虚假交易', 'FAKE_TRADE'] as const]) {
    expect(map.entries.get(raw), raw).toBe(sub);
  }
  expect(map.entries.has('1')).toBe(false);
  expect(map.entries.has('2')).toBe(false);
  expect(map.entries.has('')).toBe(false);
});

it('[AC-B2-04zze#6] 任意已知文本前后加任意空白都对不上（精确匹配）；任意文本的结果与表一致：表内 → 表里的子原因，表外 → unmapped 带原值', () => {
  const map = taobaoMap();
  const known = [...PUNISH_DESC.map(([raw]) => raw), '订单虚假交易'];
  const blank = fc
    .array(fc.constantFrom(' ', '\t', '\n', '\r', '　', ' '), { minLength: 1, maxLength: 3 })
    .map((chars) => chars.join(''));
  expect(() =>
    fc.assert(
      fc.property(
        fc.constantFrom(...known),
        blank,
        fc.boolean(),
        fc.string({ maxLength: 12 }),
        (raw, pad, before, other) => {
          const padded = before ? `${pad}${raw}` : `${raw}${pad}`;
          expect(mapViolationType(map, padded)).toEqual({ kind: 'unmapped', raw: padded });
          const sub = map.entries.get(other);
          expect(mapViolationType(map, other)).toEqual(
            sub === undefined ? { kind: 'unmapped', raw: other } : { kind: 'mapped', sub },
          );
          return true;
        },
      ),
      propParams(),
    ),
  ).not.toThrow();
}, 900_000);

/** The fixed header of specs/reason-sub-map/<platform>.csv (as specs/order-status-map/). */
const HEADER = 'violation_type,reason_sub,source,verified,note';

/** A synthetic table: the header and the given data rows. */
function csv(...rows: readonly string[]): string {
  return `${[HEADER, ...rows].join('\n')}\n`;
}

it('[AC-B2-04zze#26] 映射表来自 specs/reason-sub-map/taobao.csv：文件存在，表头恰为 violation_type,reason_sub,source,verified,note；表里「订单虚假交易」一行映射 FAKE_TRADE', () => {
  expect(existsSync(TABLE), 'specs/reason-sub-map/taobao.csv').toBe(true);
  const text = readFileSync(TABLE, 'utf8');
  const lines = text.split(/\r?\n/).filter((line) => line !== '');
  expect(lines[0]).toBe(HEADER);
  const rows = lines.slice(1).map((line) => line.split(','));
  expect(rows.filter((row) => row[0] === '订单虚假交易').map((row) => row[1])).toEqual([
    'FAKE_TRADE',
  ]);
});

it('[AC-B2-04zze#27] loadReasonSubMap 的结果只由给定 csv 文本决定：同一函数喂两份不同的合成表得到不同映射，表外文本（含 08 的 desc）一律 unmapped', () => {
  const first = loadReasonSubMap(
    'taobao',
    csv('合成违规-甲,FAKE_TRADE,doc,false,合成', '合成违规-乙,SHOP_TK,doc,false,合成'),
  );
  const second = loadReasonSubMap(
    'taobao',
    csv('合成违规-甲,RISK_ORDER,doc,true,合成', '合成违规-丙,OVER_LIMIT,doc,false,合成'),
  );
  expect(first.platform).toBe('taobao');
  expect(second.platform).toBe('taobao');
  expect(new Map(first.entries)).toEqual(
    new Map([
      ['合成违规-甲', 'FAKE_TRADE'],
      ['合成违规-乙', 'SHOP_TK'],
    ]),
  );
  expect(new Map(second.entries)).toEqual(
    new Map([
      ['合成违规-甲', 'RISK_ORDER'],
      ['合成违规-丙', 'OVER_LIMIT'],
    ]),
  );
  const outcomes = [
    [first, '合成违规-甲', { kind: 'mapped', sub: 'FAKE_TRADE' }],
    [second, '合成违规-甲', { kind: 'mapped', sub: 'RISK_ORDER' }],
    [first, '合成违规-丙', { kind: 'unmapped', raw: '合成违规-丙' }],
    [second, '合成违规-乙', { kind: 'unmapped', raw: '合成违规-乙' }],
    [first, '订单虚假交易', { kind: 'unmapped', raw: '订单虚假交易' }],
    [second, '订单虚假交易', { kind: 'unmapped', raw: '订单虚假交易' }],
    [first, '店铺淘宝客', { kind: 'unmapped', raw: '店铺淘宝客' }],
    [second, '店铺淘宝客', { kind: 'unmapped', raw: '店铺淘宝客' }],
  ] as const;
  for (const [map, raw, expected] of outcomes) {
    expect(mapViolationType(map, raw), raw).toEqual(expected);
  }
});

it.each([
  ['非 PUNISH 的子原因 AFTER_SALE', csv('合成违规-甲,AFTER_SALE,doc,false,合成')],
  ['非 PUNISH 的子原因 IN_SALE', csv('合成违规-甲,IN_SALE,doc,false,合成')],
  ['非 PUNISH 的子原因 AFTER_SETTLE', csv('合成违规-甲,AFTER_SETTLE,doc,false,合成')],
  ['未知编码', csv('合成违规-甲,NOT_A_REASON_SUB,doc,false,合成')],
  ['大小写不同的编码', csv('合成违规-甲,fake_trade,doc,false,合成')],
  [
    '重复的 violation_type（同一子原因）',
    csv('合成违规-甲,FAKE_TRADE,doc,false,合成', '合成违规-甲,FAKE_TRADE,doc,false,合成'),
  ],
  [
    '重复的 violation_type（不同子原因）',
    csv('合成违规-甲,FAKE_TRADE,doc,false,合成', '合成违规-甲,SHOP_TK,doc,false,合成'),
  ],
  [
    '表头是 order-status-map 的',
    'raw_code,event,source,verified,note\n合成违规-甲,FAKE_TRADE,doc,false,合成\n',
  ],
  ['表头缺列', 'violation_type,reason_sub\n合成违规-甲,FAKE_TRADE\n'],
  [
    '表头列序不对',
    'reason_sub,violation_type,source,verified,note\nFAKE_TRADE,合成违规-甲,doc,false,合成\n',
  ],
] as const)(
  '[AC-B2-04zze#28] 加载时拒绝坏表（%s）：loadReasonSubMap 抛错（不是 NotImplemented），不返回半张表；同样写法的好表能加载',
  (_name, bad) => {
    const good = loadReasonSubMap('taobao', csv('合成违规-甲,FAKE_TRADE,doc,false,合成'));
    expect(new Map(good.entries)).toEqual(new Map([['合成违规-甲', 'FAKE_TRADE']]));
    let thrown: unknown;
    try {
      loadReasonSubMap('taobao', bad);
    } catch (error) {
      thrown = error;
    }
    expect(thrown, 'the bad table was accepted').toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toMatch(/NotImplemented/);
  },
);
