import { expect, it } from 'vitest';
import { searchProductsDefinition } from '../../../../apps/api/src/modules/agent/tools/search/schema.ts';
import { fixture } from '../tools-search-params/kit.ts';

it('[AC-B3-04k#1] 四个可选参数的声明保持 q 必填、封闭对象和权益枚举', () => {
  expect(searchProductsDefinition(['taobao', 'jd', 'pdd']).parameters).toMatchObject({
    type: 'object',
    required: ['q'],
    additionalProperties: false,
    properties: {
      benefits: {
        type: 'array',
        uniqueItems: true,
        items: { type: 'string', enum: ['coupon', 'taolijin'] },
      },
      brand: { type: 'string' },
      category_hint: { type: 'string' },
      exclude_keywords: {
        type: 'array',
        maxItems: 5,
        items: { type: 'string', minLength: 1, maxLength: 20 },
      },
    },
  });
});

it.each([
  { label: '优惠券', args: { benefits: ['coupon'] } },
  { label: '淘礼金', args: { benefits: ['taolijin'] } },
  { label: '两种权益', args: { benefits: ['coupon', 'taolijin'] } },
  { label: '空权益数组', args: { benefits: [] } },
  { label: '品牌', args: { brand: '合成品牌' } },
  { label: '品类', args: { category_hint: '乳制品' } },
  { label: '排除词下限', args: { exclude_keywords: ['袋'] } },
  {
    label: '排除词数量和字符上限',
    args: { exclude_keywords: ['字'.repeat(20), '甲', '乙', '丙', '丁'] },
  },
  { label: '空排除数组', args: { exclude_keywords: [] } },
])('[AC-B3-04k#2] 注册表接受合法参数：$label', async ({ args }) => {
  const h = fixture();
  h.settings.set('tlj.enabled', false);
  expect((await h.execute({ q: '牛奶', ...args })).kind).toBe('ok');
  expect(h.run).toHaveBeenCalledWith({ q: '牛奶', ...args }, expect.anything());
});

// 每个拒绝项配合法对照，避免旧 schema 拒绝所有新参数也被当作通过。
it.each([
  { label: '补贴', invalid: { benefits: ['subsidy'] }, valid: { benefits: ['coupon'] } },
  { label: '包邮', invalid: { benefits: ['free_shipping'] }, valid: { benefits: ['coupon'] } },
  { label: '旗舰店', invalid: { benefits: ['flagship'] }, valid: { benefits: ['coupon'] } },
  {
    label: '混入未知权益',
    invalid: { benefits: ['coupon', 'other'] },
    valid: { benefits: ['coupon'] },
  },
  {
    label: '权益重复',
    invalid: { benefits: ['coupon', 'coupon'] },
    valid: { benefits: ['coupon'] },
  },
  {
    label: '淘礼金重复',
    invalid: { benefits: ['taolijin', 'taolijin'] },
    valid: { benefits: ['taolijin'] },
  },
  { label: '权益非数组', invalid: { benefits: 'coupon' }, valid: { benefits: ['coupon'] } },
  { label: '权益元素类型', invalid: { benefits: [1] }, valid: { benefits: ['coupon'] } },
  { label: '品牌类型', invalid: { brand: 123 }, valid: { brand: '合成品牌' } },
  { label: '品类类型', invalid: { category_hint: [] }, valid: { category_hint: '乳制品' } },
  {
    label: '排除词非数组',
    invalid: { exclude_keywords: '袋' },
    valid: { exclude_keywords: ['袋'] },
  },
  { label: '排除词类型', invalid: { exclude_keywords: [1] }, valid: { exclude_keywords: ['袋'] } },
  { label: '空排除词', invalid: { exclude_keywords: [''] }, valid: { exclude_keywords: ['袋'] } },
  {
    label: '21字排除词',
    invalid: { exclude_keywords: ['字'.repeat(21)] },
    valid: { exclude_keywords: ['字'.repeat(20)] },
  },
  {
    label: '六个排除词',
    invalid: { exclude_keywords: ['甲', '乙', '丙', '丁', '戊', '己'] },
    valid: { exclude_keywords: ['甲', '乙', '丙', '丁', '戊'] },
  },
  {
    label: '额外字段',
    invalid: { brand: '合成品牌', unknown: true },
    valid: { brand: '合成品牌' },
  },
  {
    label: 'keyword 不能取代 q',
    invalid: { keyword: '牛奶', brand: '合成品牌' },
    valid: { brand: '合成品牌' },
  },
  {
    label: '模型注入身份',
    invalid: { benefits: ['coupon'], app_id: 'other-app' },
    valid: { benefits: ['coupon'] },
  },
])(
  '[AC-B3-04k#3] $label 返回 invalid_args 且零执行，合法对照正常执行',
  async ({ invalid, valid }) => {
    const h = fixture();
    h.settings.set('tlj.enabled', false);
    expect(await h.execute({ q: '牛奶', ...invalid })).toEqual({
      kind: 'rejected',
      modelView: { error: 'invalid_args' },
    });
    expect(h.run).not.toHaveBeenCalled();
    expect(h.searchProducts).not.toHaveBeenCalled();
    expect((await h.execute({ q: '牛奶', ...valid })).kind).toBe('ok');
    expect(h.run).toHaveBeenCalledTimes(1);
  },
);
