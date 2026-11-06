import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { normalizeItemImages } from '../../../../apps/api/src/modules/union/domain/item-images.ts';
import { mapPddGoods } from '../../../../apps/api/src/modules/union/infra/pdd/goods.ts';
import { epoch, instant } from '../pdd-goods/kit.ts';
import {
  beijing,
  expectNoScores,
  has,
  LOGO,
  MALL_ID,
  MAX_URL_LENGTH,
  pddDetail,
  pddDetailRow,
  SALES,
  scoresOf,
} from './kit.ts';

// 拼多多 pdd.ddk.goods.detail（S09c，D10-736）：coupon_end_at 取所选券（即 coupon_fen 那张）的
// coupon_end_time（秒）按 +08:00 表示；sales_text = sales_tip 原样；shop_logo = mall_img_url
// （与 normalizeItemImages 单项同口径）；shop_scores = desc_txt / serv_txt / lgst_txt；
// shop_ref = mall_id。缺失或不合格一律缺省。每条用例先过一次「有值」对照，再看缺省。

// pdd-goods 默认行：券 619 分，有效期 epoch ± 90 秒，取数时刻 2032-04-05T06:07:08Z。
const DEFAULT_END = '2032-04-05T14:08:38+08:00';

it('[AC-B1-04zzm#1] 拼多多详情：可用券的 coupon_end_time（秒）按北京时间 +08:00 写成 coupon_end_at', async () => {
  const detail = await pddDetail(pddDetailRow());
  expect(detail.coupon_fen).toBe(619n);
  expect(detail.coupon_end_at).toBe(DEFAULT_END);
  expect(beijing((epoch + 90) * 1000)).toBe(DEFAULT_END);
  // UTC 16:30 已是北京次日 00:30：日期按 +08:00 进位。
  const lateEnd = Date.parse('2032-04-05T16:30:00.000Z') / 1000;
  const late = await pddDetail(pddDetailRow({ coupon_end_time: lateEnd }));
  expect(late.coupon_fen).toBe(619n);
  expect(late.coupon_end_at).toBe('2032-04-06T00:30:00+08:00');
});

it('[AC-B1-04zzm#2] 拼多多映射：秒 1760111999 → 2025-10-10T23:59:59+08:00', () => {
  const item = mapPddGoods(
    pddDetailRow({ coupon_start_time: 1_759_000_000, coupon_end_time: 1_760_111_999 }),
    'detail',
    new Date('2025-10-01T00:00:00.000Z'),
    () => undefined,
  );
  expect(item.price_status).toBe('ok');
  expect(item.coupon_fen).toBe(619n);
  expect(item.coupon_end_at).toBe('2025-10-10T23:59:59+08:00');
});

it('[AC-B1-04zzm#3] 拼多多映射：任意可用券的结束秒都按 +08:00 原样换算，不取整到天', () => {
  const now = new Date(instant);
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 20 * 365 * 86_400 }), (ahead) => {
      const end = epoch + ahead;
      const item = mapPddGoods(
        pddDetailRow({ coupon_end_time: end }),
        'detail',
        now,
        () => undefined,
      );
      expect(item.coupon_fen).toBe(619n);
      expect(item.coupon_end_at).toBe(beijing(end * 1000));
      return true;
    }),
    propParams(),
  );
});

it.each([
  ['券面额为 0', { coupon_discount: 0 }],
  ['券已结束（结束时刻 = 取数时刻）', { coupon_end_time: epoch }],
  ['券已过期', { coupon_start_time: epoch - 900, coupon_end_time: epoch - 1 }],
  ['券未开始', { coupon_start_time: epoch + 1 }],
  ['余量为 0', { coupon_remain_quantity: 0 }],
  ['门槛高于拼团价', { coupon_min_order_amount: 4288 }],
  ['价格异常（缺 min_group_price）', { min_group_price: undefined }],
  ['价格异常（缺结束时间）', { coupon_end_time: undefined }],
])(
  '[AC-B1-04zzm#4] 拼多多详情：%s → coupon_fen 为 0，不出 coupon_end_at',
  async (_label, patch) => {
    const control = await pddDetail(pddDetailRow());
    expect(control.coupon_end_at).toBe(DEFAULT_END);
    const detail = await pddDetail(pddDetailRow(patch));
    expect(detail.coupon_fen).toBe(0n);
    expect(has(detail, 'coupon_end_at')).toBe(false);
  },
);

it('[AC-B1-04zzm#5] 拼多多详情：价格异常时券结束时间不出，其余四个字段照常', async () => {
  const detail = await pddDetail(pddDetailRow({ min_group_price: undefined }));
  expect(detail.price_status).toBe('anomaly');
  expect(has(detail, 'coupon_end_at')).toBe(false);
  expect(detail.sales_text).toBe(SALES);
  expect(detail.shop_logo).toBe(LOGO);
  expect(detail.shop_ref).toBe(String(MALL_ID));
  expect(scoresOf(detail)).toEqual({ desc: '高', serv: '中', lgst: '低' });
});

it.each([
  ['10万+', '10万+'],
  ['已拼3.2万件', '已拼3.2万件'],
  ['合成 999+ 件', '合成 999+ 件'],
  ['1', '1'],
])(
  '[AC-B1-04zzm#6] 拼多多详情：sales_tip「%s」原样作 sales_text，不计算不改写',
  async (raw, text) => {
    const detail = await pddDetail(pddDetailRow({ sales_tip: raw, sales_volume: 123_456 }));
    expect(detail.sales_text).toBe(text);
  },
);

it.each([
  ['缺失', undefined],
  ['null', null],
  ['空串', ''],
])('[AC-B1-04zzm#7] 拼多多详情：sales_tip %s → 不出 sales_text', async (_label, raw) => {
  const control = await pddDetail(pddDetailRow());
  expect(control.sales_text).toBe(SALES);
  const detail = await pddDetail(pddDetailRow({ sales_tip: raw }));
  expect(has(detail, 'sales_text')).toBe(false);
});

const logoAt2048 = `https://img.synthetic.invalid/${'a'.repeat(MAX_URL_LENGTH - 30)}`;

it('[AC-B1-04zzm#8] 拼多多详情：mall_img_url 合格时原样作 shop_logo（含恰 2048 个字符）', async () => {
  expect(logoAt2048.length).toBe(MAX_URL_LENGTH);
  const detail = await pddDetail(pddDetailRow());
  expect(detail.shop_logo).toBe(LOGO);
  const odd = 'https://img.synthetic.invalid/m/%E5%BA%97.png?x=1&y=Ab#f';
  expect((await pddDetail(pddDetailRow({ mall_img_url: odd }))).shop_logo).toBe(odd);
  expect((await pddDetail(pddDetailRow({ mall_img_url: logoAt2048 }))).shop_logo).toBe(logoAt2048);
});

const badLogos: readonly [string, unknown][] = [
  ['http', 'http://img.synthetic.invalid/mall/logo.png'],
  ['协议相对', '//img.synthetic.invalid/mall/logo.png'],
  ['大写协议', 'HTTPS://img.synthetic.invalid/mall/logo.png'],
  ['无主机', 'https:///mall/logo.png'],
  ['相对路径', '/mall/logo.png'],
  ['含空格', 'https://img.synthetic.invalid/mall/lo go.png'],
  ['首尾空白', ' https://img.synthetic.invalid/mall/logo.png'],
  ['含全角空格', 'https://img.synthetic.invalid/mall/logo　.png'],
  ['含换行', 'https://img.synthetic.invalid/mall/logo.png\n'],
  ['含 C0 控制字符', 'https://img.synthetic.invalid/mall/\u0007logo.png'],
  ['含 DEL', 'https://img.synthetic.invalid/mall/logo\u007F.png'],
  ['含 C1 控制字符', 'https://img.synthetic.invalid/mall/logo\u0085.png'],
  ['超过 2048', `${logoAt2048}b`],
  ['空串', ''],
  ['数字', 12_345],
  ['数组', [LOGO]],
  ['null', null],
  ['缺失', undefined],
];

it.each(badLogos)(
  '[AC-B1-04zzm#9] 拼多多详情：mall_img_url %s → 不出 shop_logo',
  async (_label, raw) => {
    const control = await pddDetail(pddDetailRow());
    expect(control.shop_logo).toBe(LOGO);
    const detail = await pddDetail(pddDetailRow({ mall_img_url: raw }));
    expect(has(detail, 'shop_logo')).toBe(false);
  },
);

it('[AC-B1-04zzm#10] 拼多多详情：shop_logo 与 normalizeItemImages 单项同口径，主图不顶替店铺 logo', async () => {
  const candidates: unknown[] = [LOGO, logoAt2048, ...badLogos.map(([, raw]) => raw)];
  for (const raw of candidates) {
    const expected = normalizeItemImages({ main_image_url: raw }).main_image_url;
    const detail = await pddDetail(
      pddDetailRow({
        mall_img_url: raw,
        goods_image_url: 'https://img.synthetic.invalid/goods/main.jpg',
      }),
    );
    expect(detail.shop_logo, String(raw)).toBe(expected);
    expect(has(detail, 'shop_logo'), String(raw)).toBe(expected !== undefined);
  }
});

it('[AC-B1-04zzm#11] 拼多多详情：desc_txt / serv_txt / lgst_txt 原样作 shop_scores 的 desc / serv / lgst，不出 level', async () => {
  const detail = await pddDetail(
    pddDetailRow({
      desc_txt: '高',
      serv_txt: '4.86',
      lgst_txt: '合成中等',
      // 同类的百分比字段与店铺等级不入 shop_scores。
      desc_pct: 0.71,
      serv_pct: 0.52,
      lgst_pct: 0.33,
      shop_level: 5,
      shopLevel: 5,
    }),
  );
  expect(scoresOf(detail)).toEqual({ desc: '高', serv: '4.86', lgst: '合成中等' });
  expect(detail.shop_scores).toHaveLength(3);
});

it.each([
  ['缺 serv_txt', { serv_txt: undefined }, { desc: '高', lgst: '低' }],
  ['serv_txt 为 null', { serv_txt: null }, { desc: '高', lgst: '低' }],
  ['desc_txt 为空串', { desc_txt: '' }, { serv: '中', lgst: '低' }],
  ['只有 lgst_txt', { desc_txt: undefined, serv_txt: undefined }, { lgst: '低' }],
])('[AC-B1-04zzm#12] 拼多多详情：%s → 缺的项不出，其余照常', async (_label, patch, scores) => {
  const detail = await pddDetail(pddDetailRow(patch));
  expect(scoresOf(detail)).toEqual(scores);
  expect(detail.shop_scores).toHaveLength(Object.keys(scores).length);
});

it('[AC-B1-04zzm#13] 拼多多详情：三项评分都缺 → shop_scores 缺省或为空数组', async () => {
  const control = await pddDetail(pddDetailRow());
  expect(scoresOf(control)).toEqual({ desc: '高', serv: '中', lgst: '低' });
  for (const patch of [
    { desc_txt: undefined, serv_txt: undefined, lgst_txt: undefined },
    { desc_txt: null, serv_txt: '', lgst_txt: null },
  ]) {
    const detail = await pddDetail(pddDetailRow(patch));
    expectNoScores(detail);
    expect(scoresOf(detail)).toEqual({});
  }
});

it('[AC-B1-04zzm#14] 拼多多详情：mall_id 转十进制字符串作 shop_ref，不拿 goods_id / 店名补', async () => {
  const detail = await pddDetail(pddDetailRow({ mall_id: 73_129 }));
  expect(detail.shop_ref).toBe('73129');
  expect((await pddDetail(pddDetailRow())).shop_ref).toBe(String(MALL_ID));
  const safe = await pddDetail(pddDetailRow({ mall_id: Number.MAX_SAFE_INTEGER }));
  expect(safe.shop_ref).toBe('9007199254740991');
});

it.each([
  ['缺失', undefined],
  ['null', null],
  ['0', 0],
  ['负数', -5],
  ['小数', 731.5],
  ['布尔', true],
  ['对象', { id: MALL_ID }],
])('[AC-B1-04zzm#15] 拼多多详情：mall_id %s → 不出 shop_ref', async (_label, raw) => {
  const control = await pddDetail(pddDetailRow());
  expect(control.shop_ref).toBe(String(MALL_ID));
  const detail = await pddDetail(pddDetailRow({ mall_id: raw, mall_name: '合成店名不是标识' }));
  expect(has(detail, 'shop_ref')).toBe(false);
});

it('[AC-B1-04zzm#16] 拼多多详情：报文里与 DTO 同名的键不透传，只认各自的源字段', async () => {
  const spoof = {
    coupon_end_at: '2099-01-01T00:00:00+08:00',
    sales_text: '合成冒名销量',
    shop_logo: 'https://img.synthetic.invalid/spoof/logo.png',
    shop_scores: [{ key: 'level', value: '合成冒名等级' }],
    shop_ref: 'spoof-shop',
  };
  const mapped = await pddDetail(pddDetailRow(spoof));
  expect(mapped.coupon_end_at).toBe(DEFAULT_END);
  expect(mapped.sales_text).toBe(SALES);
  expect(mapped.shop_logo).toBe(LOGO);
  expect(mapped.shop_ref).toBe(String(MALL_ID));
  expect(scoresOf(mapped)).toEqual({ desc: '高', serv: '中', lgst: '低' });
  const bare = await pddDetail(
    pddDetailRow({
      ...spoof,
      coupon_discount: 0,
      sales_tip: undefined,
      mall_img_url: undefined,
      desc_txt: undefined,
      serv_txt: undefined,
      lgst_txt: undefined,
      mall_id: undefined,
    }),
  );
  for (const name of ['coupon_end_at', 'sales_text', 'shop_logo', 'shop_ref']) {
    expect(has(bare, name), name).toBe(false);
  }
  expectNoScores(bare);
});
