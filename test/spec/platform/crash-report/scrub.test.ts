// [AC-QA-13d#2] One controlled exception, reported with extra, contexts, tags, user, breadcrumbs and
// request information: what leaves the process (the envelope bodies the fake fetch received) holds
// the event, readable (its message with personal data replaced, its stack frames), and none of:
// phone number, id number, bank card number, Alipay login id, real name, token / key,
// authorization / cookie / signature headers, request or response body, URL query string, the
// concrete URL path (only the route template may leave), the raw user_id, nickname; nor a promotion
// URL, 口令, 推广位 or relation id (01 F-OBS-01; 02 §13 崩溃行, §12.6「崩溃上报的面包屑与附加信息只记
// link_id、平台、步骤与结果」). The outgoing event is also checked by structure: event.request keeps
// only method and url, and url is at most the given route template; the response body is neither
// in a top-level event.response nor in contexts.response (at most a status code stays); extra and
// breadcrumb data keep only link_id / platform / step / result, so an unknown business field does
// not leave either, and a nested object or list under one of those keys carries no promotion URL,
// 口令, 推广位 or relation id out either.
//
// The user (the specs say only「用户标识最多 user_id 的哈希」, no algorithm): it may be left out; when
// sent it holds at most `id`, and that id is not the plain user_id, phone or nickname, nor a
// reversible encoding of them (Base64, Base64url, hex of the text, hex / Base64 of the UUID bytes,
// changed case or hyphens).
import { expect, it } from 'vitest';
import {
  startCrashReporting,
  type CrashBreadcrumb,
  type CrashCaptureContext,
  type CrashRequest,
} from '../../../../apps/api/src/modules/platform/crash-report/index.ts';
import {
  DSN_VAR,
  FakeProcess,
  configOf,
  dsnFor,
  fakeFetch,
  memoryLogger,
  sentEvents,
  sentText,
  type SentEvent,
  type StackFrame,
} from './kit.ts';

const DSN = dsnFor('glitchtip.example.test');

const USER_ID = '0190f3a2-7c4e-7d1a-9b2c-3d4e5f60718a';
/** The same UUID without hyphens (the hex of its 16 bytes). */
const USER_ID_COMPACT = USER_ID.replaceAll('-', '');
const ORDER_ID = '0190f3a2-0d0d-7e0e-8f0f-a1b2c3d4e5f6';
const PHONE = '13912345678';
const ID_NO = '11010519491231002X';
const CARD = '6222020200112233445';
const ALIPAY = 'qa13d.payee@example.com';
const REAL_NAME = '张qa13d三';
const NICK = 'qa13dNick狸花';
const TOKEN = 'qaThirteenDeeTokenMarkerXyz';
const BEARER = 'eyJqa13dBearer.eyJzdWIi.qa13dSig';
const COOKIE = 'qa13dCookieSessionValue';
const SIGN = 'qa13dXSignValue9f8e7d';
const STEP_UP = 'qa13dStepUpToken5c4b';
const BODY = 'qa13dRequestBodyMarker';
const RESPONSE = 'qa13dResponseBodyMarker';
const QUERY = 'qa13dQueryMarker';
const PROMO_URL = 'https://s.click.taobao.com/t?e=qa13dPromoMarker';
const TKL = '￥Qa13dTkl8x￥';
const PID = 'mm_1234_5678_9013';
const RELATION = 'qa13dRelation2718';
/** Innocent-looking values under keys outside every allowlist (not on any sensitive-key list). */
const EXTRA_UNKNOWN = 'qa13dOrderRemarkPlain';
const CRUMB_UNKNOWN = 'qa13dCrumbNotePlain';
const RESPONSE_UNKNOWN = 'qa13dRespSummaryPlain';
const ROUTE = '/v1/orders/:order_id/claims';

/** 02 §12.6: breadcrumbs and extra record only these. */
const ALLOWED_DATA_KEYS: readonly string[] = ['link_id', 'platform', 'step', 'result'];
/** The fields of a breadcrumb itself (Sentry event payloads, breadcrumbs interface). */
const BREADCRUMB_FIELDS: readonly string[] = [
  'type',
  'category',
  'level',
  'message',
  'timestamp',
  'data',
];

/** Values that must not leave the process, by name (the failure lists the names that did). */
const SECRETS: Readonly<Record<string, string>> = {
  phone: PHONE,
  idNo: ID_NO,
  card: CARD,
  alipayLogonId: ALIPAY,
  realName: REAL_NAME,
  nickname: NICK,
  userId: USER_ID,
  userIdCompact: USER_ID_COMPACT,
  pathId: ORDER_ID,
  token: TOKEN,
  bearer: BEARER,
  cookie: COOKIE,
  signature: SIGN,
  stepUp: STEP_UP,
  requestBody: BODY,
  responseBody: RESPONSE,
  query: QUERY,
  promotionUrl: 'qa13dPromoMarker',
  promotionHost: 's.click.taobao.com',
  tkl: 'Qa13dTkl8x',
  pid: PID,
  relationId: RELATION,
  extraUnknownField: EXTRA_UNKNOWN,
  breadcrumbUnknownField: CRUMB_UNKNOWN,
  responseUnknownField: RESPONSE_UNKNOWN,
};

function leaked(text: string): string[] {
  const names: string[] = [];
  for (const [name, value] of Object.entries(SECRETS)) if (text.includes(value)) names.push(name);
  return names;
}

function controlledError(): Error {
  const cause = new Error(`qa13d-cause card ${CARD} id ${ID_NO}`);
  const error = new Error(`qa13d-boom payee ${ALIPAY} phone ${PHONE} id ${ID_NO}`, { cause });
  Object.assign(error, { token: TOKEN, promotion_url: PROMO_URL, phone: PHONE });
  return error;
}

const EXTRA: Readonly<Record<string, unknown>> = {
  link_id: 'L123',
  platform: 'taobao',
  step: 'open',
  result: 'failed',
  promotion_url: PROMO_URL,
  tkl: TKL,
  pid: PID,
  relation_id: RELATION,
  note: `call ${PHONE} card ${CARD} id ${ID_NO}`,
  token: TOKEN,
  alipay_logon_id: ALIPAY,
  order_remark: EXTRA_UNKNOWN,
};

const USER: Readonly<Record<string, unknown>> = {
  id: USER_ID,
  phone: PHONE,
  username: NICK,
  nickname: NICK,
  email: ALIPAY,
};

const BREADCRUMBS: readonly CrashBreadcrumb[] = [
  {
    category: 'link',
    message: `open ${PROMO_URL} with ${TKL}`,
    data: {
      link_id: 'L123',
      platform: 'taobao',
      url: PROMO_URL,
      pid: PID,
      relation_id: RELATION,
      tkl: TKL,
      coupon_note: CRUMB_UNKNOWN,
    },
  },
  {
    type: 'http',
    category: 'fetch',
    data: { method: 'GET', url: `/v1/orders/${ORDER_ID}?token=${QUERY}`, status_code: 500 },
  },
  { category: 'payout', message: `payee ${ALIPAY} card ${CARD} phone ${PHONE}` },
];

const REQUEST: CrashRequest = {
  method: 'POST',
  url: `https://api.example.test/v1/orders/${ORDER_ID}/claims?token=${QUERY}&phone=${PHONE}`,
  route: ROUTE,
  headers: {
    authorization: `Bearer ${BEARER}`,
    cookie: `sid=${COOKIE}`,
    'x-sign': SIGN,
    'x-step-up-token': STEP_UP,
    'content-type': 'application/json',
  },
  cookies: { sid: COOKIE },
  query_string: `token=${QUERY}&phone=${PHONE}`,
  data: { note: BODY, phone: PHONE, payee_account: ALIPAY },
  response: {
    status_code: 500,
    body: { detail: RESPONSE, token: TOKEN, summary: RESPONSE_UNKNOWN },
  },
};

const FULL_CONTEXT: CrashCaptureContext = {
  extra: EXTRA,
  contexts: {
    payout: { payee_account: ALIPAY, bank_card_no: CARD, id_no: ID_NO, real_name: REAL_NAME },
    link: { url: PROMO_URL, pid: PID, relation_id: RELATION, tkl: TKL },
    auth: { access_token: TOKEN, secret: TOKEN },
  },
  tags: { pid: PID, relation_id: RELATION, phone: PHONE },
  user: USER,
  breadcrumbs: BREADCRUMBS,
  request: REQUEST,
};

const PROMOTION_CONTEXT: CrashCaptureContext = {
  extra: EXTRA,
  contexts: { link: { url: PROMO_URL, pid: PID, relation_id: RELATION, tkl: TKL } },
  tags: { pid: PID, relation_id: RELATION },
  breadcrumbs: BREADCRUMBS,
};

/** Starts reporting on api, captures `error` with `context` once, flushes; what was sent. */
async function reportOnce(
  context: CrashCaptureContext,
  error: Error = controlledError(),
): Promise<{ text: string; events: SentEvent[] }> {
  const { logger } = memoryLogger('api');
  const transport = fakeFetch();
  const reporter = await startCrashReporting({
    entry: 'api',
    config: configOf({ [DSN_VAR]: DSN }),
    logger,
    fetch: transport.fetch,
    process: new FakeProcess(),
  });
  try {
    expect(reporter.enabled).toBe(true);
    expect(typeof reporter.captureException(error, context)).toBe('string');
    await reporter.flush(2_000);
  } finally {
    await reporter.close(1_000);
  }
  const events = await sentEvents(transport.requests);
  return { text: await sentText(transport.requests), events };
}

function exceptionText(event: SentEvent | undefined): string {
  return (event?.exception?.values ?? []).map((value) => value.value ?? '').join('\n');
}

function framesOf(event: SentEvent | undefined): StackFrame[] {
  return (event?.exception?.values ?? []).flatMap((value) => value.stacktrace?.frames ?? []);
}

it('[AC-QA-13d#2] a controlled exception with full context is sent once, and nothing personal or secret leaves', async () => {
  const { text, events } = await reportOnce(FULL_CONTEXT);
  expect(events).toHaveLength(1);
  expect(exceptionText(events[0])).toContain('qa13d-boom');
  expect(leaked(text)).toEqual([]);
});

it('[AC-QA-13d#2] the exception message keeps its text and readable stack but not the personal data in it', async () => {
  const { text, events } = await reportOnce({});
  expect(events).toHaveLength(1);
  const message = exceptionText(events[0]);
  expect(message).toContain('qa13d-boom');
  expect(message).toContain('payee');
  const frames = framesOf(events[0]);
  const own = frames.filter((frame) => (frame.filename ?? '').includes('scrub.test'));
  expect(own.length).toBeGreaterThan(0);
  expect(own.every((frame) => typeof frame.lineno === 'number' && frame.lineno > 0)).toBe(true);
  expect(leaked(text)).toEqual([]);
});

/** The breadcrumbs of an event, whether sent as a list or as { values: [...] }. */
function breadcrumbsOf(event: SentEvent | undefined): Readonly<Record<string, unknown>>[] {
  const crumbs: unknown = event?.breadcrumbs;
  const values: unknown = (crumbs as { values?: unknown } | undefined)?.values;
  if (Array.isArray(crumbs)) return crumbs.map(recordOf);
  if (Array.isArray(values)) return values.map(recordOf);
  return [];
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null) return {};
  return value as Readonly<Record<string, unknown>>;
}

/** `<where>.<key>` for every key of `record` outside `allowed`. */
function keysOutside(
  where: string,
  record: unknown,
  allowed: readonly string[],
): readonly string[] {
  if (record === undefined || record === null) return [];
  if (typeof record !== 'object') return [`${where} (not an object)`];
  return Object.keys(record)
    .filter((key) => !allowed.includes(key))
    .map((key) => `${where}.${key}`);
}

/** Plain values a user id could be read back to. */
const USER_PLAIN: Readonly<Record<string, string>> = {
  userId: USER_ID,
  userIdCompact: USER_ID_COMPACT,
  phone: PHONE,
  nickname: NICK,
};

/** The names of the plain values `id` holds as is or decodes back to (empty: none). */
function reversibleTo(id: string): string[] {
  const decodings = [
    id,
    id.toLowerCase(),
    id.toLowerCase().replaceAll('-', ''),
    Buffer.from(id, 'base64').toString('utf8'),
    Buffer.from(id, 'base64url').toString('utf8'),
    Buffer.from(id, 'hex').toString('utf8'),
    Buffer.from(id, 'base64').toString('hex'),
    Buffer.from(id, 'base64url').toString('hex'),
  ];
  return Object.entries(USER_PLAIN)
    .filter(([, plain]) => decodings.some((decoded) => decoded.includes(plain)))
    .map(([name]) => name);
}

it('[AC-QA-13d#2] the user may be left out; when sent it holds at most an id that is no plain or reversibly encoded user_id, phone or nickname', async () => {
  const { text, events } = await reportOnce({ user: USER });
  expect(events).toHaveLength(1);
  const user: unknown = events[0]?.user;
  expect(keysOutside('user', user, ['id'])).toEqual([]);
  const id: unknown = recordOf(user)['id'];
  expect(['undefined', 'string']).toContain(typeof id);
  expect(reversibleTo(typeof id === 'string' ? id : '')).toEqual([]);
  expect(leaked(text)).toEqual([]);
});

/** A response context the caller hands over, body and headers included. */
const RESPONSE_CONTEXT: Readonly<Record<string, unknown>> = {
  status_code: 500,
  body: { detail: RESPONSE, summary: RESPONSE_UNKNOWN },
  data: { detail: RESPONSE, token: TOKEN },
  headers: { 'set-cookie': `sid=${COOKIE}` },
};

it('[AC-QA-13d#2] request information keeps only method and the route template; no response body in event.response or contexts.response', async () => {
  const { text, events } = await reportOnce({
    request: REQUEST,
    contexts: { response: RESPONSE_CONTEXT },
  });
  expect(events).toHaveLength(1);
  const event = events[0];
  const request = event?.request ?? {};
  expect(keysOutside('request', request, ['method', 'url'])).toEqual([]);
  expect([undefined, ROUTE]).toContain(request['url']);
  // The response, whether as a top-level event field or as Sentry's contexts.response, keeps at
  // most its status code: no body, data or headers.
  const outside = [
    ...keysOutside('response', event?.['response'], ['status_code']),
    ...keysOutside('contexts.response', event?.contexts?.['response'], ['status_code']),
  ];
  expect(outside).toEqual([]);
  expect(leaked(text)).toEqual([]);
});

/** Allowlisted keys holding nested objects and lists with promotion data inside. */
const NESTED_CONTEXT: CrashCaptureContext = {
  extra: {
    link_id: 'L123',
    platform: ['taobao', PROMO_URL],
    step: { name: 'open', tkl: TKL },
    result: { status: 'failed', promotion_url: PROMO_URL, pid: PID, relation_id: RELATION },
  },
  breadcrumbs: [
    {
      category: 'link',
      message: 'open',
      data: {
        link_id: 'L123',
        platform: { name: 'taobao', url: PROMO_URL },
        step: ['open', TKL],
        result: { status: 'failed', detail: { url: PROMO_URL, pid: PID, relation_id: RELATION } },
      },
    },
  ],
};

it('[AC-QA-13d#2] nested objects and lists under link_id / platform / step / result carry no promotion URL, 口令, 推广位 or relation id out', async () => {
  const { text, events } = await reportOnce(
    NESTED_CONTEXT,
    new Error('qa13d-boom nested link open failed'),
  );
  expect(events).toHaveLength(1);
  expect(exceptionText(events[0])).toContain('qa13d-boom');
  expect(leaked(text)).toEqual([]);
});

it('[AC-QA-13d#2] extra and breadcrumbs keep only link_id / platform / step / result; no promotion URL, 口令, 推广位 or relation id anywhere', async () => {
  const { text, events } = await reportOnce(
    PROMOTION_CONTEXT,
    new Error('qa13d-boom link open failed'),
  );
  expect(events).toHaveLength(1);
  const event = events[0];
  expect(exceptionText(event)).toContain('qa13d-boom');
  const outside = [
    ...keysOutside('extra', event?.extra, ALLOWED_DATA_KEYS),
    ...breadcrumbsOf(event).flatMap((crumb, index) => [
      ...keysOutside(`breadcrumbs[${index}]`, crumb, BREADCRUMB_FIELDS),
      ...keysOutside(`breadcrumbs[${index}].data`, crumb['data'], ALLOWED_DATA_KEYS),
    ]),
  ];
  expect(outside).toEqual([]);
  expect(leaked(text)).toEqual([]);
});
