// B1-08za: the rule table of pdd (see index.ts). Values are the pdd branches before the refactor.
import type { PlatformRules } from './types.ts';
import { LINK_CODE, PDD_UID, parseJsonObject } from './params.ts';

export const rules: PlatformRules = {
  // BR-ATTR-06：只看 custom_parameters（JSON 对象、app==="n"、uid 为 8 位字符串，uid 是 number 算失败）。
  attribution: {
    kind: 'attr_code',
    parseAttrCode: (params) => {
      const obj = parseJsonObject(params.custom_parameters);
      if (obj === null) return null;
      if (obj['app'] !== 'n') return null;
      const uid = obj['uid'];
      if (typeof uid !== 'string' || !PDD_UID.test(uid)) return null;
      return uid;
    },
  },
  // BR-ATTR-15 lk：custom_parameters 的 lk，须是 1–16 位 [0-9a-z] 字符串。
  parseLinkCode: (params) => {
    const lk = parseJsonObject(params.custom_parameters)?.['lk'];
    return typeof lk === 'string' && LINK_CODE.test(lk) ? lk : null;
  },
  // BR-ATTR-08 ②：推广位 fallback 时读 custom_parameters.sc。
  sceneParamFallback: true,
  // BR-ATTR-08 拼多多单推广位（D10-2970 第 6 条；过渡口径 D10-3278）：带 lk 按登记的 link 判；完全缺 lk 时
  // 按推广位判（pid），实现 ② 切为 self。
  missingLinkBuyTypeBasis: 'pid',
  // BR-CALC-03：promotion_amount 含软件服务费，N = 佣金 − 服务费；服务费缺失不得按 0 处理（D10-42 / D10-66）。
  serviceFeeDeducted: true,
  taolijinPidScene: false,
  // order_sn 原样存储（含连字符），比较时两侧去掉全部连字符。
  orderNoStripHyphens: true,
  // 拍板第二批 TRADE-09 / 待裁定 6：active 的备案行即授权。
  claimAuth: 'filing',
  pushesProductKey: true,
  // 02 §7.1：增量窗口上限 30 分钟。
  syncWindowCapMs: 30 * 60_000,
  itemIdField: 'goods_sign',
};
