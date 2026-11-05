// FU-DETAIL-SHOP-NAME：全部自拟合成值；字段来源以任务书为准，不读取私有录制。
// 同一用例比较有值、缺失、null、空串、纯空白及第二家店，防止恒空和跨商品串值。
export const wireNames = [
  ' \t合成青叶  Home旗舰店（东区）\u3000',
  undefined,
  null,
  '',
  ' \t\r\n\u3000',
  '合成松果店',
] as const;

export const dtoNames = [
  '合成青叶  Home旗舰店（东区）',
  undefined,
  undefined,
  undefined,
  undefined,
  '合成松果店',
];

export const decoys = {
  nick: '合成昵称不能作店名',
  seller_nick: '合成卖家昵称不能作店名',
  mall_id: '99887766',
  shop_name: '合成同名键不能直接透传',
};
