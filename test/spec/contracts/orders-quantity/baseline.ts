// CT-04b / D10-43：固定任务开始时的结构，运行时不从待测契约推导期望值。
// 说明文字不参与结构比较；其余约束（包括嵌套 required / not / oneOf）全部保留。
const commonRequired = [
  'order_id',
  'platform',
  'title',
  'image_url',
  'pay_amount_fen',
  'quantity',
  'display_status',
  'reason',
  'est_rebate_fen',
  'paid_at',
  'is_other_product',
];

const commonProperties = {
  order_id: { $ref: '#/components/schemas/Id' },
  platform: { $ref: '#/components/schemas/PlatformCode' },
  title: { type: ['string', 'null'] },
  image_url: { type: ['string', 'null'], format: 'uri' },
  pay_amount_fen: { $ref: '#/components/schemas/NullableFen' },
  order_no: { type: 'string', minLength: 1 },
  masked_order_no: { type: 'string', minLength: 1 },
  display_status: { $ref: '#/components/schemas/OrderDisplayStatus' },
  reason: { anyOf: [{ $ref: '#/components/schemas/OrderReasonCode' }, { type: 'null' }] },
  est_rebate_fen: { $ref: '#/components/schemas/NullableFen' },
  paid_at: { type: ['string', 'null'], format: 'date-time' },
  is_other_product: { type: 'boolean' },
};

// CT-26p（D10-664 S-04）：列表项新增可选的 is_price_compare，不进 required（contracts/README 第 8 条）。
const summaryProperties = {
  is_price_compare: { type: ['boolean', 'null'] },
};

const detailProperties = {
  product_key: { anyOf: [{ $ref: '#/components/schemas/ProductKey' }, { type: 'null' }] },
  reason_action: { type: 'array', items: { type: 'string' } },
  timeline: { type: 'array', items: { $ref: '#/components/schemas/OrderTimelineItem' } },
  expected_credit_period: {
    type: ['string', 'null'],
    pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$',
  },
  credit_overdue: { type: 'boolean' },
  actual_fen: { $ref: '#/components/schemas/NullableFen' },
  clawback_fen: { $ref: '#/components/schemas/NullableFen' },
  appeal_pending: { type: 'boolean' },
  is_price_compare: { type: ['boolean', 'null'] },
};

function stringBranch(name: string) {
  return { type: 'object', properties: { [name]: { type: 'string' } }, required: [name] };
}

export function baselineWithoutQuantity(name: 'OrderSummary' | 'OrderDetail') {
  const detail = name === 'OrderDetail';
  return {
    type: 'object',
    additionalProperties: false,
    required: detail ? [...commonRequired, ...Object.keys(detailProperties)] : commonRequired,
    properties: detail
      ? { ...commonProperties, ...detailProperties }
      : { ...commonProperties, ...summaryProperties },
    not: {
      type: 'object',
      additionalProperties: true,
      properties: { is_other_product: { const: true } },
      required: ['is_other_product'],
      anyOf: (detail
        ? ['title', 'image_url', 'order_no', 'product_key']
        : ['title', 'image_url', 'order_no']
      ).map(stringBranch),
    },
    oneOf: ['order_no', 'masked_order_no'].map(stringBranch),
  };
}
