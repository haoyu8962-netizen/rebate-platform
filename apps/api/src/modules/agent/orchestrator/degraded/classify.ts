// B3-05n · BR-AI-14 细则「无模型降级」: the no-model path's own, strict reading of a message.
// Server code only, no model. It deliberately does not reuse intents/classify.ts: that reading only
// checks a label the model already gave and, used alone, sends shopping questions elsewhere.
// Order (the first step with a result wins): sort phrase → ⑥; ① page location; ② general rules;
// ③ own orders; ④ own earnings (and the elliptical 「返了吗」, decided by the previous run);
// ⑤ handoff; else ⑥ keyword search. Anything unclear is a search (拿不准按找货).
// The word lists live here, like BR-AI-18's keyword lists; changes need rule tests (degraded-routing).
import { unwrapUntrusted } from '../../guard/index.ts';

export type GuideRoute = 'Wallet' | 'WithdrawRecords' | 'OrderList';
export type EarningsTopic = 'summary' | 'withdrawal_progress';

export type DegradedReading =
  | { readonly kind: 'page'; readonly route: GuideRoute }
  | { readonly kind: 'rule' }
  | { readonly kind: 'order' }
  | { readonly kind: 'earnings'; readonly topic: EarningsTopic }
  /** 「返了吗」「到账了吗」 alone: the previous run's intent decides (order, else earnings). */
  | { readonly kind: 'elliptical' }
  | { readonly kind: 'handoff' }
  | { readonly kind: 'search' };

/** The two forms of one message's redacted text the path works on. */
export interface MessageText {
  /** User's own words: untrusted blocks dropped, placeholders kept, NFKC, no whitespace. */
  readonly trusted: string;
  /** The same with whitespace kept, not normalized (search_rules' question). */
  readonly trustedRaw: string;
  /** The same NFKC with whitespace kept (order numbers: white space never joins, B3-05o r2). */
  readonly trustedSpaced: string;
  /** Every block's text unwrapped, no delimiter tag, no placeholder, no angle bracket, NFKC. */
  readonly free: string;
}

const UNTRUSTED_BLOCK = /<untrusted>[\s\S]*?<\/untrusted>/gu;
const DELIMITER = /<\/?untrusted>/gu;
const PLACEHOLDER = /<num_[1-9]\d*>/gu;

function unwrapBlock(block: string): string {
  try {
    return unwrapUntrusted(block);
  } catch {
    return block;
  }
}

export function readMessage(modelText: string): MessageText {
  const own = modelText.replace(UNTRUSTED_BLOCK, ' ').replace(DELIMITER, ' ');
  const unwrapped = modelText.replace(UNTRUSTED_BLOCK, (block) => ` ${unwrapBlock(block)} `);
  return {
    trusted: own.normalize('NFKC').replace(/\s+/gu, ''),
    trustedRaw: own.trim(),
    trustedSpaced: own.normalize('NFKC'),
    free: cleanSearchText(unwrapped),
  };
}

/** Keyword text without delimiter tags, placeholders or angle brackets, whitespace runs as one
 * space (the corrections apply with routing on or off). */
export function cleanSearchText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(DELIMITER, ' ')
    .replace(PLACEHOLDER, ' ')
    .replace(/[<>]/gu, ' ')
    .replace(/\s+/gu, ' ');
}

// ------------------------------------------------------------------------------------------------
// Word lists (BR-AI-14 细则 ①–⑥; BR-AI-09 sort phrases; BR-AI-08 price phrases).

type SearchSort = 'relevance' | 'rebate_desc' | 'final_price_asc' | 'sales_desc';

/** BR-AI-09: the only phrases that change the sort; 最划算 and the rest stay relevance. */
const SORT_PHRASES: readonly (readonly [RegExp, SearchSort])[] = [
  [/返利最高|返得最多|佣金最高/u, 'rebate_desc'],
  [/最便宜|价格最低/u, 'final_price_asc'],
  [/销量最高|卖得最多/u, 'sales_desc'],
];

const LOCATION =
  /在哪|哪里看|哪儿看|哪看|哪里查|去哪看|去哪查|从哪|怎么进|怎么打开|怎么找到|如何进入|如何打开|入口/u;
const BUYING = /(在哪|哪里|哪儿|去哪|从哪)(里|儿)?(能|可以)?(有卖|卖|买|购)/u;
const PAGE_WORDS: readonly (readonly [RegExp, GuideRoute])[] = [
  [/提现记录|提现明细/u, 'WithdrawRecords'],
  [/订单列表|订单页|订单/u, 'OrderList'],
  [/钱包|余额|提现/u, 'Wallet'],
];

const RULE_TOPICS = /返利|结算|提现|找回|邀请|账号/u;
const GENERAL_ASK =
  /一般|多久|多长时间|几天|什么时候|怎么算|如何算|怎么计算|怎么|如何|最低|最少|最多|手续费|规则|是什么|条件|门槛|要求|能不能|可以吗/u;
/** Progress forms that make a topic question about the user's own data, never a rule. */
const OWN_PROGRESS = /了吗|了没|还没|没到|到哪了|进度/u;
/** Points at the user (fillers like 帮我 are removed first). */
const PERSONAL = /我|本人|自己/u;
const PERSONAL_FILLERS = /帮我|给我|告诉我|跟我|和我/gu;

/** Order nouns that point at one particular order of the user's (② never takes them as a
 * general question); 「想买的」「要买的」 is shopping, not a past order. The bare 「订单」 is not one.
 * 「单号」 points at one order only with a demonstrative or a word for the user (那个单号、这个单号、
 * 我的单号) or with a long-number placeholder in the same message (the placeholder alternative
 * below); the generic 「单号」 (「订单找回对单号有什么要求」) is a rule question, not one order. */
const SPECIFIC_ORDER =
  /(?:那个|这个|我的|本人的|自己的)单号|那单|这单|(?<!想|要|准备)买的|下的单|下单的|<num_[1-9]\d*>/u;
/** ③'s order nouns: the bare 「单号」 still counts here (only ②'s exclusion is narrowed above). */
const ORDER_NOUNS = new RegExp(`订单|那笔|这笔|单号|${SPECIFIC_ORDER.source}`, 'u');
const ORDER_ASK = /查|返了吗|返了没|还没返|没返|到哪了|到账|进度|状态|了吗|了没/u;

const ACCOUNT_STRONG = /余额|可提现|收益|提现/u;
const ACCOUNT_WEAK = /返利|佣金|奖励/u;
const AMOUNT_ASK = /多少|几块|几元/u;
const PROGRESS_ASK = /到哪|到账|进度|状态|什么时候到|了吗|了没|还没|呢$/u;
const WITHDRAWAL_PROGRESS = /到哪|到账|进度|状态|什么时候到|了吗|了没|还没/u;
const ELLIPTICAL =
  /^(那|那个|这个)?(返了吗|返了没|返了没有|到账了吗|到账了没|到账没|到账了没有|到了吗|结算了吗|返利到了吗)(呢)?$/u;

const HANDOFF =
  /(?:(?:转|接|找|要|联系|呼叫|叫)(?:一下)?(?:人工|客服)|人工客服|人工服务|在线客服|客服电话|客服热线)(?=$|[\p{P}\p{S}]|吧|呢|吗|啊|呀|电话|热线|在哪|怎么|帮)/u;
const HANDOFF_ALONE = /^(人工|客服)$/u;

function bare(text: string): string {
  return text.replace(/[\p{P}\p{S}]/gu, '');
}

export function sortOf(text: string): SearchSort | null {
  for (const [pattern, sort] of SORT_PHRASES) if (pattern.test(text)) return sort;
  return null;
}

function pageRoute(text: string): GuideRoute | null {
  if (!LOCATION.test(text) || BUYING.test(text)) return null;
  for (const [pattern, route] of PAGE_WORDS) if (pattern.test(text)) return route;
  return null;
}

function personal(text: string): boolean {
  return PERSONAL.test(text.replace(PERSONAL_FILLERS, ''));
}

function earningsTopic(text: string): EarningsTopic {
  return /提现/u.test(text) && WITHDRAWAL_PROGRESS.test(text) ? 'withdrawal_progress' : 'summary';
}

/** BR-AI-14 细则「无模型降级」: the step a message goes to; `trusted` is MessageText.trusted. */
export function classifyDegraded(trusted: string): DegradedReading {
  const text = trusted;
  if (sortOf(text) !== null) return { kind: 'search' };
  const route = pageRoute(text);
  if (route !== null) return { kind: 'page', route };
  const own = personal(text);
  const ruleAsk = RULE_TOPICS.test(text) && GENERAL_ASK.test(text);
  const specificOrder = SPECIFIC_ORDER.test(text);
  if (ruleAsk && !own && !specificOrder && !OWN_PROGRESS.test(text)) return { kind: 'rule' };
  // 「那单返利什么时候结算」: a rule-style question about one particular order asks its progress.
  if (ORDER_NOUNS.test(text) && (own || ORDER_ASK.test(text) || (ruleAsk && specificOrder))) {
    return { kind: 'order' };
  }
  if (
    (ACCOUNT_STRONG.test(text) && (own || AMOUNT_ASK.test(text) || PROGRESS_ASK.test(text))) ||
    (ACCOUNT_WEAK.test(text) && (own || OWN_PROGRESS.test(text)))
  ) {
    return { kind: 'earnings', topic: earningsTopic(text) };
  }
  const plain = bare(text);
  if (ELLIPTICAL.test(plain)) return { kind: 'elliptical' };
  if (HANDOFF.test(text) || HANDOFF_ALONE.test(plain)) return { kind: 'handoff' };
  return { kind: 'search' };
}

/** BR-AI-01 细则「意图兜底与不空回复」: the string around the first placeholder, with the digits,
 * letters and hyphens right next to it; null without a placeholder. Read on the whitespace-kept
 * text (MessageText.trustedSpaced): characters across white space are not next to it (B3-05o r2;
 * the intent fallback and degraded step ③ alike). */
export function orderNumberOf(message: MessageText, maxLength: number): string | null {
  const match = /[A-Za-z0-9-]*<num_[1-9]\d*>[A-Za-z0-9-]*/u.exec(message.trustedSpaced);
  if (match === null) return null;
  if ([...match[0]].length <= maxLength) return match[0];
  return /<num_[1-9]\d*>/u.exec(match[0])?.[0] ?? null;
}

// ------------------------------------------------------------------------------------------------
// Greetings (BR-AI-14 ⑥: only greetings → agent.welcome, never a search).

/** Greetings dropped from a longer message's keywords (never part of a product word). */
const DROPPED_GREETINGS =
  '你好呀|你好啊|你好|您好|哈喽|在吗|在不在|谢谢你|谢谢您|谢谢啦|谢谢|多谢|谢啦';
/** The others count only for a message made of greetings (never cut out of a word). */
const GREETING_WORDS =
  `${DROPPED_GREETINGS}|感谢|早上好|中午好|下午好|晚上好|早安|晚安|嗨|` +
  'hello|hi|hey|thanks|thank you';

/** Only greetings (你好、在吗、谢谢一类), punctuation and symbols; at least one greeting. */
export function greetingOnly(text: string): boolean {
  const lower = text.toLowerCase();
  if (!new RegExp(GREETING_WORDS, 'u').test(lower)) return false;
  const rest = lower.replace(new RegExp(GREETING_WORDS, 'gu'), '');
  return rest.replace(/[\s\p{P}\p{S}]/gu, '') === '';
}

/** Greetings inside a longer message are not product words. */
export function withoutGreetings(text: string): string {
  return text.replace(new RegExp(DROPPED_GREETINGS, 'gu'), ' ');
}
