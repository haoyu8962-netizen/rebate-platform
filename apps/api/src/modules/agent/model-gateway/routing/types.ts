// ModelGateway 第三段：路由、时限、熔断与同意闸（05 B3-02c）。
// 依据：08 BR-AI-14 细则「路由顺序」「无模型降级」触发条件、跨厂商兜底关闭（取值只在 08）；
// BR-AI-21 路由与快照只经仓库 PR，后台只在已评测条目之间切换或切到无模型；BR-AI-16 预算用完即降级（只收布尔信号）；
// 02 §14 千问行（备用 → 无模型；熔断与单次时限复用 platform 的 createGovernor，每个路由条目一个 Governor，重试 0 次）。
// 失败分流：timeout / rate_limited / server / network / malformed → 下一个条目，全部失败 → degraded(models_failed)；
// content_refused → refused，不换模型；auth / bad_request → onAlert 并 degraded(vendor_misconfigured)，不换模型；
// 本 run 累计时限用尽 → degraded(model_timeout)；调用方 signal 中止 → aborted，不再尝试。
// 协议错误（ModelProtocolError）带 usage 时由本段交给 meter 计量（成功调用由 VendorGateway 计量，不重复）；usage 为 null 不记；
// 非计费传输不记，评测端口已认领的错误不记（同一错误只记一次，见 billing.ts）。
// 档位约束：主位只能是 Flash 档、备位只能是 Plus 档，否则剔除为 tier_mismatch（BR-AI-14 路由顺序）。
// 时间只取注入的 Scheduler（单调毫秒）与 Clock（计量时刻）。规则测试在 test/spec/agent/model-routing/。
// 不在本段：路由文件与同意厂商清单文件及其 CI 校验、done / error 帧（B3-03）、日预算记账（B3-09）。
import type { BreakerPolicy, Clock, Scheduler } from '../../../platform/index.ts';
import type { ModelPrices } from '../../budget/index.ts';
import type { UsageSink, VendorGateway, VendorId, VendorUsage } from '../vendors/index.ts';
import type { ChatInput, ModelErrorKind, ModelEvent } from '../openai-compat/index.ts';
import type { DegradeReason } from '../degraded/index.ts';

export interface RouteEvaluation {
  /** 全量评测报告路径（BR-AI-21）。 */
  readonly report: string;
  /** 负责人已签字。 */
  readonly signed: boolean;
}

export interface RouteEntry {
  readonly id: string;
  readonly vendor: VendorId;
  readonly tier: 'flash' | 'plus';
  /** 锁定的日期快照。 */
  readonly model: string;
  readonly evaluation: RouteEvaluation | null;
}

/** 仓库文件，只经 PR 修改（BR-AI-21）。crossVendor 为跨厂商兜底槽位的条目 id，槽位保持关闭。 */
export interface RouteTable {
  readonly entries: readonly RouteEntry[];
  readonly crossVendor: readonly string[];
}

/** 后台能切的只有这一部分（agent.model_route 的选择）。 */
export type RouteSelection =
  | { readonly mode: 'models'; readonly primary: string; readonly backup: string | null }
  | { readonly mode: 'no_model' };

export type RouteDropReason =
  | 'unknown_entry'
  | 'vendor_not_online'
  | 'vendor_not_consented'
  | 'model_not_pinned'
  | 'not_evaluated'
  | 'cross_vendor_closed'
  /** 主位不是 Flash 档或备位不是 Plus 档（BR-AI-14 路由顺序）。 */
  | 'tier_mismatch';

export interface RouteDrop {
  readonly id: string;
  readonly reason: RouteDropReason;
}

export interface ResolvedRoute {
  readonly mode: 'models' | 'no_model';
  /** 依次尝试：主、备。 */
  readonly attempts: readonly RouteEntry[];
  readonly dropped: readonly RouteDrop[];
}

export interface RouteGates {
  /** specs/agent-consent-vendors（与 AgentConsent 当前版本一致）。 */
  readonly consentVendors: readonly string[];
}

/** 本 run 等待模型的累计时限（agent.model_timeout_ms，取值见 BR-AI-14）。 */
export interface RunModelClock {
  remainingMs(): number;
  charge(ms: number): void;
}

export interface AttemptRecord {
  readonly entryId: string;
  readonly result: 'ok' | ModelErrorKind | 'circuit_open';
  readonly elapsedMs: number;
}

export type ModelOutcome =
  | {
      readonly kind: 'model';
      readonly entryId: string;
      readonly model: string;
      readonly events: readonly ModelEvent[];
      readonly usage: VendorUsage;
      readonly attempts: readonly AttemptRecord[];
    }
  | {
      readonly kind: 'refused';
      readonly entryId: string;
      readonly attempts: readonly AttemptRecord[];
    }
  | {
      readonly kind: 'degraded';
      readonly reason: DegradeReason;
      readonly attempts: readonly AttemptRecord[];
    }
  | { readonly kind: 'aborted'; readonly attempts: readonly AttemptRecord[] };

export interface RouterAlert {
  readonly kind: 'auth' | 'bad_request' | 'route_dropped';
  readonly entryId: string | null;
}

export interface ModelRouterConfig {
  /** 单次尝试时限（代理自定的实现值，放配置）。 */
  readonly attemptTimeoutMs: number;
  readonly breaker: BreakerPolicy;
}

export interface ModelRouterOptions {
  readonly gateway: VendorGateway;
  /** 每次 complete 读一次，后台切换随之生效。 */
  readonly route: () => ResolvedRoute;
  /** B3-09 提供。 */
  readonly budgetExhausted: () => boolean;
  readonly config: ModelRouterConfig;
  readonly scheduler: Scheduler;
  /** 兼容旧接线；成功和失败用量统一由 VendorGateway 的计量去处记录。 */
  readonly meter: UsageSink;
  /** 兼容旧接线；计量时刻取 VendorGateway 的 Clock。 */
  readonly clock: Clock;
  /**
   * 兼容旧接线；与 createMeteredVendorGateway 登记值矛盾则构造即拒绝。
   * 是否计量由 VendorGateway 的 transport.billable 决定。
   */
  readonly billable?: boolean;
  readonly onAlert?: (alert: RouterAlert) => void;
}

export type RouterChatInput = Omit<ChatInput, 'vendor' | 'model'>;

export interface RunCallBudget {
  readonly reserveMfen: bigint;
  readonly prices: ModelPrices;
  spentMfen: bigint;
  calls: number;
}

export interface RouterContext {
  readonly clock: RunModelClock;
  readonly signal: AbortSignal;
  readonly budget?: RunCallBudget;
}

export interface ModelRouter {
  complete(input: RouterChatInput, ctx: RouterContext): Promise<ModelOutcome>;
  breakerState(entryId: string): 'closed' | 'open';
}
