// B1-08zza：首次入库第 ④ 步 buy_type / scene_basis（BR-ATTR-08）。规则表 missingLinkBuyTypeBasis 非 null 的平台
// （拼多多单推广位，D10-2970 第 6 条；四推广位期间过渡口径 D10-3278）且注入了链接读口时：
// - 订单参数带 lk：经读口在本事务按 (app_id, lk) 读一次 link，交 domain 的 classifyBuyTypeByLink 判
//   （scene_basis=link 或 fallback）；lk 不合法不查库、按查不到判。读到的 link 交给 ⑤ 来源回填复用，不再查第二遍。
// - 完全没带 lk：规则表取 pid → 与按推广位判完全相同（classifyBuyType）；取 self → self / fallback。不查库。
// 其余平台、或未注入读口（直接搭流水线的调用方）→ 按推广位判（classifyBuyType），不查库。
// 读口抛错原样抛出（调用方整事务回滚）。商品键只在 goods_sign 对不上时经来源端口推一次（未注入来源端口 → 空）。
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { OrderAttributionLink } from '../../linking/index.ts';
import type { RegisteredPlatform, UnionOrder, UnionOrderAttrParams } from '../../union/index.ts';
import {
  classifyBuyType,
  classifyBuyTypeByLink,
  type BuyTypeDecision,
  type LinkBuyTypeDecision,
} from '../domain/attribution.ts';
import { platformRules } from '../domain/platform-rules/index.ts';
import { carriesLinkCode } from '../domain/platform-rules/params.ts';
import type { OrderPipelineDeps } from './pipeline-types.ts';

export interface BuyTypeStepInput {
  readonly appId: string;
  readonly platform: RegisteredPlatform;
  readonly order: UnionOrder;
  readonly params: UnionOrderAttrParams;
  /** 订单推广位在 union_pids 中的 pid_scene。 */
  readonly pidScene: string;
  /** 本单按 uid 归属的用户；未归因为 null。 */
  readonly userId: string | null;
}

export interface BuyTypeStepResult {
  readonly decision: BuyTypeDecision | LinkBuyTypeDecision;
  /**
   * 按 lk 读到的 link（查不到为 null）；本次没有按 lk 查库时为 undefined（来源回填照旧自己查）。
   */
  readonly link: OrderAttributionLink | null | undefined;
}

const SELF_FALLBACK: LinkBuyTypeDecision = { buy_type: 'self', scene_basis: 'fallback' };

export async function decideBuyType(
  trx: Transaction<DB>,
  deps: Pick<OrderPipelineDeps, 'readBuyTypeLink' | 'buyTypeRules' | 'sources'>,
  input: BuyTypeStepInput,
): Promise<BuyTypeStepResult> {
  const { platform, params } = input;
  const rules = (deps.buyTypeRules ?? platformRules)(platform);
  const missingBasis = rules.missingLinkBuyTypeBasis;
  const read = deps.readBuyTypeLink;
  const byPid = (): BuyTypeStepResult => ({
    decision: classifyBuyType(platform, input.pidScene, params.custom_parameters),
    link: undefined,
  });
  if (missingBasis === null || read === undefined) return byPid();
  if (!carriesLinkCode(params)) {
    return missingBasis === 'pid' ? byPid() : { decision: SELF_FALLBACK, link: undefined };
  }
  const lk = rules.parseLinkCode(params);
  if (lk === null) return { decision: SELF_FALLBACK, link: null };
  const link = await read(trx, { appId: input.appId, lk });
  const goodsSign = input.order[rules.itemIdField] ?? null;
  const productKey =
    link !== null &&
    link.product_key !== null &&
    (goodsSign === null || link.raw_item_id !== goodsSign) &&
    deps.sources !== undefined
      ? await deps.sources.productKey({ platform, order: input.order })
      : null;
  const decision = classifyBuyTypeByLink(
    {
      user_id: input.userId,
      platform,
      goods_sign: goodsSign,
      product_key: productKey,
      // 预售：尾款时刻；只付了定金时取定金时刻（更早，对 link 时序更严）。
      paid_at: input.order.paid_at ?? input.order.deposit_paid_at ?? null,
    },
    link,
  );
  return { decision, link };
}
