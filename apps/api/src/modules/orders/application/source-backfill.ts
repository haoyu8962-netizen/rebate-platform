// B1-08j：来源回填用例（BR-ATTR-15；BR-ATTR-01 ⑤）。只经注入的只读端口取数据，判定全在
// domain/source-backfill.ts 的纯函数里；端口抛错原样抛出（调用方整事务回滚、本页重试）。
// 首次入库（pipeline-port 的 fresh）与未归因重跑成功（update-step）在本事务的判定阶段调用；
// 找回通过、管理员改派（B1-10）复用本函数，旧值审计由调用方负责。
// 端口在 orders 声明；生产实现见 source-ports.ts（B1-08q：linking 按 (app_id, user_id, platform, created_at
// 区间) 取 link_logs、catalog 的 key_prefix、content 的 config_items），由 app.module 经 worker 装配注入。
import type { RegisteredPlatform, UnionOrder, UnionOrderAttrParams } from '../../union/index.ts';
import { instantAt } from '../domain/sync-window.ts';
import {
  DEFAULT_BACKFILL_WINDOW_HOURS,
  matchExactLink,
  matchOrderSource,
  parseLinkCode,
  type ExactLink,
  type LinkLogCandidate,
  type OrderSourceMatch,
} from '../domain/source-backfill.ts';

export interface OrderSourcePorts {
  /** link_logs 原始行：app_id、user_id、platform 相同，created_at ∈ [from, to]（两端闭）。 */
  linkLogs(input: {
    appId: string;
    userId: string;
    platform: RegisteredPlatform;
    from: Date;
    to: Date;
  }): Promise<readonly LinkLogCandidate[]>;
  // TODO(规划/11 §4.5): links.lk 按短码反查 — blocked on links.lk 迁移与 lk 发号
  linkByCode?(input: {
    appId: string;
    platform: RegisteredPlatform;
    lk: string;
  }): Promise<ExactLink | null>;
  /** 订单的 product_key（@couli/domain deriveProductKey 口径）；推不出 → null（跳过 ②）。 */
  productKey(input: { platform: RegisteredPlatform; order: UnionOrder }): Promise<string | null>;
  /** 配置 attr.click_code.<platform>（缺省 false）。注入 sourceConfig 时不调用。 */
  clickCode?(platform: RegisteredPlatform): boolean;
  /** 配置 attr.backfill_window_hours（缺省 360，BR-ATTR-13 ③）。注入 sourceConfig 时不调用。 */
  windowHours?(): number;
  /**
   * D10-76：按 App 取本次回填的两项配置（attr.click_code.<platform> 缺省 false；attr.backfill_window_hours
   * 缺省 360）。注入时每次回填先调用一次（exact 之前），不再调用 clickCode / windowHours；抛错原样抛出。
   */
  sourceConfig?(
    appId: string,
    platform: RegisteredPlatform,
  ): OrderSourceConfig | Promise<OrderSourceConfig>;
}

/** 一次来源回填用的配置（D10-76）：exact 开关与 W_backfill 小时数。 */
export interface OrderSourceConfig {
  readonly clickCodeEnabled: boolean;
  readonly backfillWindowHours: number;
}

export interface BackfillOrderSourceInput {
  readonly appId: string;
  readonly platform: RegisteredPlatform;
  readonly userId: string;
  readonly attrAt: Date;
  /** 订单推广位的 pid_scene；null = 推广位场景未知 → 只做 ① exact，不取商品键与外跳日志（② / ③ 不匹配）。 */
  readonly pidScene: string | null;
  readonly order: UnionOrder;
  /**
   * ③ shop 用的店铺；null → 跳过 ③。首次入库取本次报文（UnionOrder.shop_id，B1-08p），重跑取库内值，
   * 库内为空再取本次报文。是否把 none 留作待补由调用方判定（domain/source-shop.ts），本函数语义不变。
   */
  readonly shopId: string | null;
  /**
   * B1-08zza：调用方已在本事务按订单 lk 读过的 link（属于其他平台或查不到为 null）。给出时 ① exact 用它、不再调
   * linkByCode（开关关着时照旧不看 exact）；未给（undefined）时照旧按开关自己反查。
   */
  readonly exactLink?: ExactLink | null;
}

const NO_PARAMS: UnionOrderAttrParams = {
  relation_id: null,
  custom_parameters: null,
  sub_union_id: null,
};

const HOUR_MS = 3_600_000;

/**
 * 按当时的 userId 重新匹配来源：开关 attr.click_code.<platform> 打开、订单参数解析出 lk、且注入了
 * linkByCode → 先反查 exact 候选；exact 命中（link 属于订单 user_id）即返回，不再取商品键、窗口配置与
 * link_logs（BR-ATTR-15 命中即停：后续读取的故障不得回滚已命中的 exact）。注入 sourceConfig 时开关与窗口
 * 由它一次给出（在 exact 之前读）。exact 未命中且推广位场景已知时
 * 再取 product_key、取窗口内 link_logs，交给 matchOrderSource。推广位场景未知（pidScene=null）不跨场景
 * 匹配：不调 productKey / linkLogs，exact 未命中即 none。
 */
export async function backfillOrderSource(
  ports: OrderSourcePorts,
  input: BackfillOrderSourceInput,
): Promise<OrderSourceMatch> {
  const { appId, platform } = input;
  // D10-76：注入了按 App 的配置端口就只用它（一次读取，exact 之前）；否则照 B1-08j 的两个同步口子。
  const config =
    ports.sourceConfig === undefined ? null : await ports.sourceConfig(appId, platform);
  const clickCodeEnabled =
    config === null ? (ports.clickCode?.(platform) ?? false) : config.clickCodeEnabled;
  let exactLink: ExactLink | null = null;
  const lookup = ports.linkByCode;
  if (clickCodeEnabled && input.exactLink !== undefined) {
    exactLink = input.exactLink;
  } else if (clickCodeEnabled && lookup !== undefined) {
    const lk = parseLinkCode(platform, input.order.attr_params ?? NO_PARAMS);
    if (lk !== null) exactLink = await lookup.call(ports, { appId, platform, lk });
  }
  const exact = matchExactLink(exactLink, input.userId);
  if (exact !== null) return exact;
  const windowHours =
    config === null
      ? (ports.windowHours?.() ?? DEFAULT_BACKFILL_WINDOW_HOURS)
      : config.backfillWindowHours;
  let productKey: string | null = null;
  let candidates: readonly LinkLogCandidate[] = [];
  if (input.pidScene !== null) {
    productKey = await ports.productKey({ platform, order: input.order });
    const toMs = input.attrAt.getTime();
    candidates = await ports.linkLogs({
      appId,
      userId: input.userId,
      platform,
      from: instantAt(input.attrAt, toMs - windowHours * HOUR_MS),
      to: instantAt(input.attrAt, toMs),
    });
  }
  return matchOrderSource({
    userId: input.userId,
    platform,
    productKey,
    shopId: input.shopId,
    pidScene: input.pidScene,
    attrAt: input.attrAt,
    windowHours,
    exactLink,
    candidates,
  });
}

/** orders 上的四个来源列（与 OrderSourceMatch 同名同值）；随本次 INSERT / CAS UPDATE 一起写。 */
export function sourceColumns(source: OrderSourceMatch): OrderSourceMatch {
  return {
    source_match: source.source_match,
    link_id: source.link_id,
    source_scene: source.source_scene,
    agent_session_id: source.agent_session_id,
  };
}
