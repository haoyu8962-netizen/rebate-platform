// B1-08za: the rule table of jd (see index.ts). Values are the jd branches before the refactor.
import type { PlatformRules } from './types.ts';
import { JD_SUB_UNION } from './params.ts';

export const rules: PlatformRules = {
  // BR-ATTR-06：只看 sub_union_id 整串，第 1 组为 attr_code。
  attribution: {
    kind: 'attr_code',
    parseAttrCode: (params) => {
      const sub = params.sub_union_id;
      if (typeof sub !== 'string') return null;
      return JD_SUB_UNION.exec(sub)?.[1] ?? null;
    },
  },
  // BR-ATTR-15 lk：sub_union_id 第 2 组。
  parseLinkCode: (params) => {
    const sub = params.sub_union_id;
    if (typeof sub !== 'string') return null;
    return JD_SUB_UNION.exec(sub)?.[2] ?? null;
  },
  sceneParamFallback: false,
  serviceFeeDeducted: false,
  taolijinPidScene: false,
  orderNoStripHyphens: false,
  claimAuth: null,
  // TODO(规划/11 §4.5): 京东订单商品键的 jdMode — blocked on 京东订单映射
  // 端口入参没有 App，读不到 App 级 product_key.jd.mode，不猜模式：京东不推商品键（跳过 ②）。
  pushesProductKey: false,
  missingLinkBuyTypeBasis: null,
  // 02 §7.1、CAP-JD-07：单窗 ≤1 小时，不按 scene 分路。
  syncWindowCapMs: 60 * 60_000,
  itemIdField: 'itemId',
};
