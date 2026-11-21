// B3-05f · BR-AI-01 细则「判定顺序」②: the server-side check of the model's classification.
// The model labels the message; between the personal queries, page_guide and rule_qa the server's
// reading of the user's own text decides whenever it is clear (personal data, a generic rule
// question, or a page location with a known target). Only an unclear reading keeps the model's
// label. Whether the text contains 「我」/「我的」 is not a criterion on its own (R2-01): it only
// cancels a generic marker such as 「一般」 when it points at the user's own data.
//
// Order versus earnings: a demonstrative or measure word (这笔 / 那笔) is not evidence of an
// order. An order needs an order noun (订单, 单号, 下单, 买的, 那单 …); account wording (提现,
// 余额, 收益, 可提, 钱包) in the same sentence makes it earnings even next to an order noun.
//
// Page location first: a location or entry word (在哪 / 哪里看 / 怎么找 / 入口 / 哪个页面) makes
// the message a page_guide question even when it names 提现 or 订单; it is never raised to a
// personal query that asks a guest to log in. A sentence-final particle (呢 / 吗 / 啊 / 呀 / 吧 /
// 嘛 …) is never evidence of a progress question; only a bare amount noun with a particle
// (余额呢, 上一单的返利呢) asks about own data.

/** Regular-expression sources (compiled with the `u` flag), applied to the user's text with
 * white space and trailing punctuation removed. Returned fresh by a function, not a constant. */
export interface IntentTextPatterns {
  /** Order nouns (订单 / 单号 / 下单 / 买的 / 那单 / an order number) → order_query. */
  readonly orderNoun: string;
  /** Account wording that wins over order nouns → earnings_query. */
  readonly earningsStrong: string;
  /** Amount wording → earnings_query only without an order noun. */
  readonly earningsWeak: string;
  /** Rebate wording: personal with `progress`, order or earnings from context. */
  readonly rebateNoun: string;
  /** Asking for an amount, a time or a state (personal data together with a noun). 多久 is
   * also a generic marker: it asks about own data only when `generic` is cancelled. */
  readonly progress: string;
  /** Asking whether a rebate arrived; personal on its own (那返了吗). */
  readonly rebateProgress: string;
  /** The whole sentence is an amount noun plus a particle (余额呢, 上一单的返利呢): asks about own
   * data. Page nouns (钱包呢, 提现记录呢) and particles alone are not. */
  readonly ellipticalAmount: string;
  /** Asking about withdrawal progress → topic withdrawal_progress. */
  readonly withdrawalProgress: string;
  /** Generic wording (一般 / 规则 / 多久 / 怎么算 …) → rule_qa unless it points at own data. */
  readonly generic: string;
  /** Points at the user's own data (我的余额 …); cancels `generic`. */
  readonly selfPointer: string;
  /** Points at one specific item (这笔 / 那单 / an order number); cancels `generic` but does not
   * decide between order and earnings. */
  readonly specificRef: string;
  /** Asking where a page or an entry is. 到哪 / 在哪一步 / 在哪了 (progress) are not. */
  readonly location: string;
  /** Asking how to start an operation (怎么提现) → an entry page. */
  readonly howTo: string;
}

export function intentTextPatterns(): IntentTextPatterns {
  return {
    orderNoun: '订单|单号|下单|下的单|买的|购买的|那单|这单|上一单|(?<!\\d)\\d{10,}(?!\\d)',
    earningsStrong: '提现|余额|可提|收益|钱包',
    earningsWeak: '多少钱|钱',
    rebateNoun: '返利|返现',
    progress:
      '多少|几块|几元|到哪|哪一步|哪个环节|哪个阶段|进度|到账|结算|返了|返没返|没返|还没|什么时候|啥时候|多会儿|多久',
    rebateProgress: '返了[吗没么]?|返没返|没返|还没返|到账了[吗没么]?',
    ellipticalAmount:
      '^(?:那|那个|还有|我的?|我那)?(?:(?:上一|那|这)[单笔]的?)?(?:余额|收益|可提现?|返利|返现)(?:呢|嘞|咧)$',
    withdrawalProgress:
      '提现.*(?:到哪|哪一步|哪个环节|哪个阶段|进度|到账|审核|什么时候|啥时候|还没|怎么样)',
    generic:
      '一般|通常|规则|多久|几天|怎么算|如何计算|最低|最少|最高|最多|上限|下限|门槛|规定|标准|手续费',
    selfPointer:
      '我(?:的|那|这)?(?:返利|收益|余额|钱|提现|订单|那单|这单)|我(?:还|现在)?(?:有|能提|可以提|可提)',
    specificRef: '那单|这单|那笔|这笔|上一单|上一笔|单号|(?<!\\d)\\d{10,}(?!\\d)',
    location:
      '在哪(?!一步|步|个环节|个阶段|(?:里|儿)?了)|(?<![到在])哪(?:里|儿)(?!了)|(?<!到)哪(?:看|找|查)|哪个(?:页面|入口|地方)|哪一页|入口|从哪',
    howTo: '(?:怎么|如何|怎样)(?:才能|可以|能)?(?:提现|查看|看|找|打开|进入|进|邀请|授权|绑定)',
  };
}

// B3-08t · 判定顺序② 本人订单 without a progress word (编排 D10-2368: 只落核对过的；宁可漏判留空，不可
// 误判): a fixed list of positive expressions, no pattern guessing. A message is an own-order query
// only when, after trimming and folding full-width punctuation to half-width, it is exactly one of
// OWN_ORDER_REQUESTS, optionally followed by one closing courtesy (OWN_ORDER_ENDINGS, after nothing,
// a comma or a space) and closing punctuation (OWN_ORDER_CLOSING). Anything else is not decided here.

/** Pointing at the user's own order (指向本人 + 订单名词). */
const OWN_ORDER_OBJECTS: readonly string[] = [
  '我的订单',
  '我那订单',
  '我这订单',
  '我的那单',
  '我的这单',
  '我那单',
  '我这单',
  '我的单子',
  '我那单子',
  '我这单子',
];
/** Look-up verbs (查询动词). */
const OWN_ORDER_VERBS: readonly string[] = ['查', '查一下', '查查', '查询', '看', '看一下', '看看'];
/** Opening courtesies (句首客套), only before a verb. */
const OWN_ORDER_OPENINGS: readonly string[] = ['', '帮我', '麻烦', '请', '给我'];
/** Closing courtesies (句尾客套), longest first. */
const OWN_ORDER_ENDINGS: readonly string[] = ['谢谢你', '谢谢', '谢了', '呢', '吧', '啊'];
/** What may separate the request and its closing courtesy (after punctuation folding). */
const OWN_ORDER_SEPARATORS: readonly string[] = [',', ' '];
/** Closing punctuation (after folding), any number of them. */
const OWN_ORDER_CLOSING = new Set(['.', '?', '!', '~', '…']);
/** Negations of looking up and rule wording: a message with any of them is never an own-order query. */
const OWN_ORDER_EXCLUDED: readonly string[] = [
  '别查',
  '别看',
  '不用查',
  '不用看',
  '不要查',
  '不要看',
  '不是查',
  '不是看',
  '规则',
  '怎么算',
  '是什么',
  '怎么来的',
];

/** The positive list: object alone, or opening + verb + object (e.g. 帮我查一下我的订单). */
export const OWN_ORDER_REQUESTS: readonly string[] = Object.freeze([
  ...OWN_ORDER_OBJECTS,
  ...OWN_ORDER_OPENINGS.flatMap((opening) =>
    OWN_ORDER_VERBS.flatMap((verb) => OWN_ORDER_OBJECTS.map((object) => opening + verb + object)),
  ),
]);
const OWN_ORDER_SET: ReadonlySet<string> = new Set(OWN_ORDER_REQUESTS);

const FULL_WIDTH_PUNCTUATION: Readonly<Record<string, string>> = {
  '，': ',',
  '。': '.',
  '？': '?',
  '！': '!',
  '～': '~',
  '\u3000': ' ',
};

/** Trim, then full-width punctuation (and the ideographic space) as half-width; nothing else. */
function foldOwnOrderText(input: string): string {
  let text = '';
  for (const char of input.trim()) text += FULL_WIDTH_PUNCTUATION[char] ?? char;
  return text;
}

/**
 * B3-08t: the message is exactly a listed own-order request (OWN_ORDER_REQUESTS), with at most one
 * closing courtesy and closing punctuation; a negation or rule wording anywhere excludes it.
 */
export function isOwnOrderRequest(input: string): boolean {
  let text = foldOwnOrderText(input);
  if (OWN_ORDER_EXCLUDED.some((word) => text.includes(word))) return false;
  const stripClosing = (value: string): string => {
    let end = value.length;
    while (end > 0 && OWN_ORDER_CLOSING.has(value[end - 1] ?? '')) end -= 1;
    return value.slice(0, end);
  };
  text = stripClosing(text);
  if (OWN_ORDER_SET.has(text)) return true;
  for (const ending of OWN_ORDER_ENDINGS) {
    if (!text.endsWith(ending)) continue;
    const body = text.slice(0, text.length - ending.length);
    if (OWN_ORDER_SET.has(body)) return true;
    for (const separator of OWN_ORDER_SEPARATORS) {
      if (body.endsWith(separator) && OWN_ORDER_SET.has(body.slice(0, -separator.length))) {
        return true;
      }
    }
    return false;
  }
  return false;
}

/** Degrade targets and text hints named by BR-AI-01 细则「判定顺序」④ / 「页面引导」 examples. The
 * candidate list itself is never read from here: every route still passes configuration ∩
 * contract agent_guide before a card is sent. */
export interface GuideTargets {
  readonly wallet: string;
  readonly withdrawRecords: string;
  readonly orderList: string;
}

export function guideTargets(): GuideTargets {
  return { wallet: 'Wallet', withdrawRecords: 'WithdrawRecords', orderList: 'OrderList' };
}

export type TextClass =
  /** Mentions an order noun → order_query. */
  | { readonly kind: 'order' }
  /** Account amounts / withdrawal progress → earnings_query. */
  | { readonly kind: 'earnings'; readonly withdrawal: boolean }
  /** Personal data without an order or account noun (那返了吗, 我的返利…): from context. */
  | { readonly kind: 'personal'; readonly withdrawal: boolean }
  /** Asks where a page is or how to start an operation; route is a hint or null. */
  | { readonly kind: 'page'; readonly route: string | null }
  /** Generic rule wording, not pointing at the user's data or one specific item. */
  | { readonly kind: 'rule' }
  | { readonly kind: 'unknown' };

export interface TextClassifier {
  classify(text: string): TextClass;
}

export function createTextClassifier(
  patterns: IntentTextPatterns,
  targets: GuideTargets,
): TextClassifier {
  const re = (source: string) => new RegExp(source, 'u');
  const orderNoun = re(patterns.orderNoun);
  const earningsStrong = re(patterns.earningsStrong);
  const earningsWeak = re(patterns.earningsWeak);
  const rebateNoun = re(patterns.rebateNoun);
  const progress = re(patterns.progress);
  const rebateProgress = re(patterns.rebateProgress);
  const ellipticalAmount = re(patterns.ellipticalAmount);
  const withdrawalProgress = re(patterns.withdrawalProgress);
  const generic = re(patterns.generic);
  const selfPointer = re(patterns.selfPointer);
  const specificRef = re(patterns.specificRef);
  const location = re(patterns.location);
  const howTo = re(patterns.howTo);
  const routeHint = (text: string): string | null => {
    if (/提现(?:记录|明细|历史)/u.test(text)) return targets.withdrawRecords;
    if (/钱包|余额|提现/u.test(text)) return targets.wallet;
    if (/订单/u.test(text)) return targets.orderList;
    return null;
  };
  return {
    classify(input) {
      const text = input.replace(/\s+/gu, '').replace(/[?？!！。.,，~～…]+$/u, '');
      if (text === '') return { kind: 'unknown' };
      // A location or entry question is a page_guide question first (BR-AI-01 「页面引导」).
      if (location.test(text) || howTo.test(text)) return { kind: 'page', route: routeHint(text) };
      const pointsAtOwn = selfPointer.test(text) || specificRef.test(text);
      const isGeneric = generic.test(text) && !pointsAtOwn;
      const asksProgress =
        progress.test(text) || rebateProgress.test(text) || ellipticalAmount.test(text);
      if (!isGeneric && asksProgress) {
        const withdrawal = withdrawalProgress.test(text);
        if (earningsStrong.test(text)) return { kind: 'earnings', withdrawal };
        if (orderNoun.test(text)) return { kind: 'order' };
        if (earningsWeak.test(text)) return { kind: 'earnings', withdrawal };
        if (rebateProgress.test(text) || rebateNoun.test(text)) {
          return { kind: 'personal', withdrawal };
        }
      }
      // B3-08t 本人订单 without a progress word: only a message on the fixed positive list
      // (isOwnOrderRequest: 查一下我的订单, 帮我查一下我的订单，谢谢, 我的订单, 我那单); a negation or
      // a rule question (订单返利规则是什么？别查我的订单) is never on it and keeps the reading below.
      if (isOwnOrderRequest(input)) return { kind: 'order' };
      if (isGeneric) return { kind: 'rule' };
      return { kind: 'unknown' };
    },
  };
}
