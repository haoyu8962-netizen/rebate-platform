// [AC-QA-13d#2] One controlled exception, reported with extra, contexts, tags, user, breadcrumbs and
// request information: what leaves the process (the envelope bodies the fake fetch received) holds
// the event, readable (its message with personal data replaced, its stack frames), and none of:
// phone number, id number, bank card number, Alipay login id, real name, token / key,
// authorization / cookie / signature headers, request or response body, URL query string, the
// concrete URL path (only the route template may leave), the raw user_id, nickname; nor a promotion
// URL, 口令, 推广位 or relation id (01 F-OBS-01; 02 §13 崩溃行, §12.6「崩溃上报的面包屑与附加信息只记
// link_id、平台、步骤与结果」). The user identifier is at most a hash of user_id.
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

/** Values that must not leave the process, by name (the failure lists the names that did). */
const SECRETS: Readonly<Record<string, string>> = {
  phone: PHONE,
  idNo: ID_NO,
  card: CARD,
  alipayLogonId: ALIPAY,
  realName: REAL_NAME,
  nickname: NICK,
  userId: USER_ID,
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
    data: { link_id: 'L123', url: PROMO_URL, pid: PID, relation_id: RELATION, tkl: TKL },
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
  route: '/v1/orders/:order_id/claims',
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
  response: { status_code: 500, body: { detail: RESPONSE, token: TOKEN } },
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

it('[AC-QA-13d#2] the user identifier is at most a hash of user_id: no raw id, phone, nickname or e-mail', async () => {
  const { text, events } = await reportOnce({ user: USER });
  expect(events).toHaveLength(1);
  const user = events[0]?.user ?? {};
  expect(Object.keys(user).filter((key) => key !== 'id')).toEqual([]);
  const id = user['id'] ?? 'no id';
  expect(typeof id).toBe('string');
  expect(String(id)).not.toContain(USER_ID);
  expect(String(id)).not.toContain(USER_ID.replaceAll('-', ''));
  expect(leaked(text)).toEqual([]);
});

it('[AC-QA-13d#2] request information keeps no headers, cookies, body, response body, query string or concrete path', async () => {
  const { text, events } = await reportOnce({ request: REQUEST });
  expect(events).toHaveLength(1);
  const request = events[0]?.request ?? {};
  expect(request['data']).toBeUndefined();
  expect(request['cookies']).toBeUndefined();
  expect(request['query_string']).toBeUndefined();
  expect(Object.keys((request['headers'] as object | undefined) ?? {})).toEqual([]);
  expect(String(request['url'] ?? '')).not.toContain('?');
  expect(leaked(text)).toEqual([]);
});

it('[AC-QA-13d#2] extra, contexts, tags and breadcrumbs carry no promotion URL, 口令, 推广位 or relation id', async () => {
  const { text, events } = await reportOnce(
    PROMOTION_CONTEXT,
    new Error('qa13d-boom link open failed'),
  );
  expect(events).toHaveLength(1);
  expect(exceptionText(events[0])).toContain('qa13d-boom');
  expect(leaked(text)).toEqual([]);
});
