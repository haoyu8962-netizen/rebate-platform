// B1-08za: the shape of one platform's rule table (index.ts re-exports these types). Kept apart from
// index.ts so `<platform>.ts` can name the type without an import cycle (index.ts imports them).
import type { ItemRef, UnionOrderAttrParams } from '../../../union/index.ts';

/**
 * 归因参数解析（BR-ATTR-06 / 07）：attr_code = parse the order's own parameter field (null when it
 * does not parse); relation_id = attribute through the relation_id binding at attr_at, no attr_code.
 */
export type AttributionRule =
  | {
      readonly kind: 'attr_code';
      readonly parseAttrCode: (params: UnionOrderAttrParams) => string | null;
    }
  | { readonly kind: 'relation_id' };

/**
 * 找回授权平台（BR-ATTR-17 / 18, BR-ID-18）：how an auth_declined / auth_failed no-rebate link_log
 * is recovered. relation_id = an active binding with a usable relation_id; filing = the active
 * binding (filing) row alone; null = 08 defines no authorisation here, such rows never count.
 */
export type ClaimAuthRule = 'relation_id' | 'filing' | null;

/** 商品 ID 字段名：the UnionOrder field that carries the platform item id (orders.raw_item_id). */
export type ItemIdField = Exclude<keyof ItemRef, 'platform'>;

export type MissingLinkBuyTypeBasis = 'pid' | 'self';

export interface PlatformRules {
  /** 归因参数解析. */
  readonly attribution: AttributionRule;
  /** 来源短码（BR-ATTR-15 lk）from the order's own parameter field; null when there is none. */
  readonly parseLinkCode: (params: UnionOrderAttrParams) => string | null;
  /** 购买场景回退（BR-ATTR-08 ②）：pid_scene=fallback reads custom_parameters.sc. */
  readonly sceneParamFallback: boolean;
  /** 启用按链接判定的平台配置此字段；值决定订单完全缺少 lk 时的判定依据。 */
  readonly missingLinkBuyTypeBasis?: MissingLinkBuyTypeBasis;
  /** 服务费入基数（BR-CALC-03）：N = commission − the order's service fee (missing fee → pending). */
  readonly serviceFeeDeducted: boolean;
  /** 淘礼金推广位场景：the promotion slot's scene decides the rebate mode (unknown scene → skip). */
  readonly taolijinPidScene: boolean;
  /** 单号规范化：every hyphen is removed from both sides before order numbers are compared. */
  readonly orderNoStripHyphens: boolean;
  /** 找回授权平台. */
  readonly claimAuth: ClaimAuthRule;
  /** 商品键推送：the source backfill derives the order's product key (else ② is skipped). */
  readonly pushesProductKey: boolean;
  /** 同步窗口上限 in ms (02 §7.1); null = no fixed cap, the platform is not scheduled. */
  readonly syncWindowCapMs: number | null;
  /** 商品 ID 字段名. */
  readonly itemIdField: ItemIdField;
}
