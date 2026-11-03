// B1-08za: the rule table of taobao (see index.ts). Values are the taobao branches before the
// refactor.
import type { PlatformRules } from './types.ts';

export const rules: PlatformRules = {
  // BR-ATTR-07：走 relation_id 绑定，不解析 attr_code。
  attribution: { kind: 'relation_id' },
  // BR-ATTR-15 lk：淘宝订单参数里没有 lk。
  parseLinkCode: () => null,
  sceneParamFallback: false,
  // BR-CALC-03：N 在适配器按服务费金额算净额（B1-04zz，D10-105）；服务费缺失不得按 0 处理。
  serviceFeeDeducted: true,
  // BR-CALC-19：推广位场景（淘礼金）决定返利模式；场景取不到时补偿重试 skip pid_scene_unknown。
  taolijinPidScene: true,
  orderNoStripHyphens: false,
  // 拍板第二批 TRADE-09：绑定 active 且 relation_id 可用。
  claimAuth: 'relation_id',
  pushesProductKey: true,
  // TODO(规划/11 §4.5): 淘宝增量窗口上限与 scene 分路 — blocked on CAP-TB-07
  syncWindowCapMs: null,
  itemIdField: 'item_id',
};
