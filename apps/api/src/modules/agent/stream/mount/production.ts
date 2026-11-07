// B3-03j: the stream entry's production business assembly. app.module passes
// createProductionStreamAssembly as AgentStreamModuleOptions.assembly and provides
// agentStreamPortsToken() (union / catalog / linking / parsing, assembled there: agent imports
// none of their providers and never identity). This file adds agent's own parts: the content
// configuration reader, the prohibited query words, the page_guide route whitelist and the copy.
// B3-03m: the input check and the sentence review come from createStreamReview over
// context.safety (the composition root's review configuration); without it, or outside staging /
// prod, or without the AccessKey pair, both stay fail-closed with no network request. Model
// routing (B3-03k) is not part of it.
// B3-03n: the input review budget is agent.safety.timeout_ms of each request's app through the same
// content reader (createStreamReview's config), and the one result store is the PG version
// (agent/store/results createPgResultSetStore over context.db), shared by every runtime instance.
// B3-08g (rule tests: test/spec/agent/stream-assembly-orders/**): with the ports' orders,
// claimEntries and dailyCounter, the registry also holds handoff_to_human, prefill_claim,
// list_my_orders and explain_order, each behind agent.tools.<name>.enabled through the same content
// reader; card_id references read agent_cards (createOrderCardRefs over context.db) and the
// by-number budget is createOrderNoQuota over ports.dailyCounter (./orders.ts).
// B3-08k (D10-294; rule tests: test/spec/agent/foreign-db-handoff/**): "the content configuration
// reader" above is context.contentReader (app.module's, through the runtime): the search platform
// switches, the page_guide routes, the tool switches, the review budget and the order budget are
// read through it; no content reader is built from context.db.
// B3-08m (rule tests: test/spec/agent/rule-search-wiring/**): search_rules is registered too
// (registered = specs/agent-tools.allowlist exactly, with the order ports), over the caller's
// app's active rows of app.agent_rule_chunks (agent's own table, createActiveRuleChunksReader over
// context.db) and agent.rag.min_score through the same content reader (code default 0.2 when unset
// or invalid, tools/rules), behind agent.tools.search_rules.enabled.
import { bridge, display_status as displayStatusEnum } from '@couli/contracts-ts';
import type { ContentReader } from '../../../content/index.ts';
import { systemScheduler } from '../../../platform/index.ts';
import type { AgentRunTexts } from '../../orchestrator/index.ts';
import { createActiveRuleChunksReader } from '../../rag/chunks/index.ts';
import { createPgResultSetStore } from '../../store/results/index.ts';
import {
  createKeywordMatcher,
  inputKeywordLists,
  normalizeForKeywords,
} from '../../preprocess/input/keywords.ts';
import {
  createAgentStreamAssembly,
  type AgentOrderToolPorts,
  type AgentStreamAssembly,
  type AgentStreamAssemblyContext,
  type AgentStreamProvidedPorts,
} from './assembly.ts';
import { createOrderCardRefs, createOrderNoQuota } from './orders.ts';
import { agentDefaultTexts, agentText, agentTextIfPresent, platformDisplayName } from './texts.ts';
import { createStreamReview } from './review.ts';
import { createToolStatusDisplay, type ToolStatusTextsDeps } from './tool-status.ts';

const PORTS = Symbol('AGENT_STREAM_PORTS');

/** DI token of AgentStreamProvidedPorts; provided by app.module on the stream entry only. */
export function agentStreamPortsToken(): symbol {
  return PORTS;
}

const PAGE_GUIDE_ROUTES = 'agent.page_guide.routes';

/**
 * B3-08m · BR-AI-07 T5 / BR-TEXT-22: the package defaults of the order summaries the core may write
 * when contracts/texts.default.json has no such key. 08 (12_TEXT BR-TEXT-22 细则): 「其余
 * order_status.<display_status>.summary 与全部 order_reason.<CODE>.summary 的包内默认 =
 * 「{BR-TEXT-02 状态文案或 BR-TEXT-05 标题}，详情见卡片。」」 (BR-AI-07: 并记告警
 * agent.template_missing). The titles below are BR-TEXT-05's default titles and the status texts
 * BR-TEXT-02's 映射表, word for word (SPEC_REF).
 */
const REASON_TITLES: Readonly<Record<string, string>> = {
  REFUND: '订单已退款或取消',
  PART_REFUND: '部分退款',
  RIGHTS: '发起售后维权，返利取消',
  PUNISH: '订单被联盟判定违规',
  PRICE_COMPARE: '比价订单',
  PRICE_PROTECT: '商家价保退差',
  SETTLE_DIFF: '结算金额调整',
  NOT_TRACKED: '未找到这笔订单的返利记录',
  EXPIRED_CLICK: '下单时链接已过期',
  RELATION_INVALID: '淘宝授权未完成或已失效',
  OTHER_TLJ: '订单归其他推广者',
  BLACKLIST: '订单未通过安全校验',
  PRESALE_UNPAID: '预售尾款未付',
  COMMISSION_ZERO: '返利已取消',
  OTHER: '其他原因',
};

/**
 * BR-TEXT-02 状态文案 by display_status. CREDITED_PART_CLAWED (「已结算（部分扣回 {z}）」) is left
 * out: its text carries an amount, which a summary must not (BR-AI-07), so 08 gives no usable
 * default for it. A display_status outside the contract enum is BR-TEXT-02's 「未知编码」 row.
 */
const STATUS_TEXTS: Readonly<Record<string, string>> = {
  DEPOSIT_PAID: '已付定金',
  PAID: '已付款，返利待确认',
  WAITING: '已收货，等待联盟结算',
  CREDITING: '入账核对中',
  RIGHTS_PENDING: '售后处理中，入账暂停',
  REVIEWING: '入账核对中',
  NO_REBATE: '本单无返利',
  CREDITED: '已结算',
  INVALID: '已失效',
  CLAWED_BACK: '已扣回',
};
const UNKNOWN_STATUS_TEXT = '状态更新中';
const KNOWN_STATUSES: readonly string[] = displayStatusEnum;
const SUMMARY_SUFFIX = '，详情见卡片。';
/** The one-order wording of the list summary, for a summary 08 gives no default for. */
const LIST_SUMMARY = 'order_list.summary';

function own(table: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/**
 * The package default of an order summary key missing from the contract copy; undefined for any
 * other key. Never the key itself: a code 08 has no default for (an order_reason without a
 * BR-TEXT-05 title, e.g. CANCELLED; CREDITED_PART_CLAWED) gets the contract's one-order list
 * summary (order_list.summary with n = 1), which says only that the details are on the card.
 */
function templateFallback(key: string): string | undefined {
  const match = /^(order_reason|order_status)\.([A-Z][A-Z0-9_]*)\.summary$/u.exec(key);
  if (match === null) return undefined;
  const [, family, code] = match as unknown as [string, string, string];
  const head =
    family === 'order_reason'
      ? own(REASON_TITLES, code)
      : (own(STATUS_TEXTS, code) ??
        (KNOWN_STATUSES.includes(code) ? undefined : UNKNOWN_STATUS_TEXT));
  if (head !== undefined) return head + SUMMARY_SUFFIX;
  return agentText(LIST_SUMMARY).replaceAll('{n}', '1');
}

/**
 * Copy from contracts/texts.default.json. An error key without its own text takes the error
 * message (errorMsg); any other missing key shows the key itself, as the search card's
 * fallback_text does. Tool status texts never show a key (tool-status.ts, D10-151). The local
 * evaluation (B3-05m) uses the same copy over its tool catalog's search platforms.
 * TODO(规划/11 §2.3): Agent 草稿键与多平台工具状态文案（agent.suggest.clarify.*、agent.notice.platform_unrecognized、agent.guest_login_to_view.*、agent.tool_status.search_products.<阶段>.multi）进字典 — blocked on content 文案线 B3-13（D10-135）
 */
export function productionRunTexts(
  searchPlatforms: ToolStatusTextsDeps['searchPlatforms'],
  logger: ToolStatusTextsDeps['logger'],
): AgentRunTexts {
  const errors = agentDefaultTexts();
  const lookup = (key: string): string => {
    try {
      return agentText(key);
    } catch {
      const missing = templateFallback(key);
      if (missing !== undefined) {
        // BR-AI-07 / BR-TEXT-22: an unconfigured summary uses the package default, with a warning.
        logger.warn({ key }, 'agent.template_missing');
        return missing;
      }
      const code = /^error\.(\d+)$/u.exec(key);
      return code === null ? key : errors.errorMsg(Number(code[1]));
    }
  };
  return {
    text: async (_appId, key) => lookup(key),
    toolDisplay: createToolStatusDisplay({
      text: agentTextIfPresent,
      searchPlatforms,
      platformName: platformDisplayName,
      logger,
    }),
  };
}

/**
 * B3-08g: the order tools' ports, all three provided or none (the B3-03j / B3-03n assemblies
 * without them keep the two product tools). A partial set is a wiring error, never a silent
 * subset of tools.
 */
function orderToolPorts(
  context: AgentStreamAssemblyContext,
  ports: AgentStreamProvidedPorts,
  config: Pick<ContentReader, 'configValue'>,
): AgentOrderToolPorts | undefined {
  const { orders, claimEntries, dailyCounter } = ports;
  if (orders === undefined && claimEntries === undefined && dailyCounter === undefined) {
    return undefined;
  }
  if (orders === undefined || claimEntries === undefined || dailyCounter === undefined) {
    throw new Error('Agent order tool ports are incomplete (orders, claimEntries, dailyCounter)');
  }
  return {
    orders,
    claimEntries,
    refs: createOrderCardRefs(context.db),
    quota: createOrderNoQuota({
      counter: dailyCounter,
      clock: context.clock,
      config: async (appId, key) => (await config.configValue(appId, key))?.value,
    }),
  };
}

export function createProductionStreamAssembly(
  context: AgentStreamAssemblyContext,
): AgentStreamAssembly {
  const ports = context.ports;
  if (ports === undefined) throw new Error('Agent stream business ports are not provided');
  // B3-08k: content's reads come from app.module (through the runtime); none is built here.
  const config = context.contentReader;
  const keywords = createKeywordMatcher(inputKeywordLists());
  // BR-PROD-10, the same switches search_products queries with: explicit true only; missing or
  // unreadable is off.
  const searchPlatforms = async (appId: string): Promise<readonly string[]> => {
    const flags = await Promise.all(
      ports.platforms.map(async (platform) => {
        try {
          return (await config.configValue(appId, `search.enabled.${platform}`))?.value === true;
        } catch {
          return false;
        }
      }),
    );
    return ports.platforms.filter((_, index) => flags[index]);
  };
  const orderTools = orderToolPorts(context, ports, config);
  const scheduler = context.scheduler ?? systemScheduler();
  const texts = productionRunTexts(searchPlatforms, context.logger);
  const safety = createStreamReview({
    ...(context.safety === undefined ? {} : { options: context.safety }),
    clock: context.clock,
    scheduler,
    logger: context.logger,
    texts,
    config,
  });
  const assembly = createAgentStreamAssembly({
    results: createPgResultSetStore({ db: context.db }),
    db: context.db,
    clock: context.clock,
    logger: context.logger,
    config,
    scheduler,
    texts,
    routes: {
      // BR-AI-01 页面引导: only the configured whitelist (intersected with the contract's routes by
      // the intent port); unreadable or malformed configuration is no route at all.
      async configured(appId) {
        try {
          const value = (await config.configValue(appId, PAGE_GUIDE_ROUTES))?.value;
          return Array.isArray(value)
            ? value.filter((route): route is string => typeof route === 'string')
            : [];
        } catch {
          return [];
        }
      },
      contract: () => bridge.routes,
    },
    ports: {
      search: {
        platforms: ports.platforms,
        searchProducts: ports.searchProducts,
        // BR-AI-18: the same prohibited words as the input check, on the model's keyword.
        prohibited: async (_appId, q) => keywords.hits('prohibited', normalizeForKeywords(q)),
        // TODO(规划/11 §2.3): 结果层禁售类目黑名单 — blocked on 联盟 DTO 提供类目 ID（UnionItem 目前没有类目字段）
        categoryAllowed: async () => true,
      },
      readProduct: ports.readProduct,
      parsing: ports.parsing,
      cards: ports.cards,
      ...(orderTools === undefined ? {} : { orders: orderTools }),
      rules: {
        activeChunks: createActiveRuleChunksReader(context.db),
        config: async (appId, key) => (await config.configValue(appId, key))?.value,
      },
    },
  });
  return { ...assembly, safety };
}
