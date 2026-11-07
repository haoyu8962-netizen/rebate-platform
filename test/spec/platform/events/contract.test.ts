// Unit rule tests of platform/events (no database): event list, errors, event ids, options and
// subscription checks, the checks of publish before any statement, and the checks of the consumer's
// job handler before any statement (规划/02 §11 事件与异步, §19 类型与日志; ADR-0001 §3, §4.2 第 1、10、16 项;
// contract sections 1–4, 6–9 of apps/api/src/modules/platform/events/index.ts). Top-level it() only
// (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  EVENT_ERROR_MESSAGES,
  EVENT_NAMES,
  EVENT_SUBSCRIPTIONS,
  EventError,
  MAX_EVENT_PAYLOAD_BYTES,
  MAX_EVENT_PAYLOAD_DEPTH,
  MAX_EVENT_STRING_LENGTH,
  MAX_EVENT_VERSION,
  createEventBus,
  newEventId,
  registerEventConsumer,
  type EventBus,
  type EventErrorCode,
} from '../../../../apps/api/src/modules/platform/events/index.ts';
import { SENSITIVE_KEYS } from '../../../../apps/api/src/modules/platform/logging/redaction.ts';
import {
  QueueError,
  type JobHandler,
} from '../../../../apps/api/src/modules/platform/queue/index.ts';
import {
  EVENT_MESSAGES,
  EVT_CATALOG,
  PLAN_02_EVENTS,
  PLAN_02_PENDING,
  SUBS,
  UUID_V7,
  countingClock,
  describeError,
  eventErrorProblems,
  fakeQueue,
  fakeTrx,
  payloadOfBytes,
  recordingProxy,
  rejectionProblems,
  text,
  thrownProblems,
  uuidMs,
} from './kit.ts';
import { spec, TEST_DEAD } from '../queue/kit.ts';

const CODES = Object.keys(EVENT_MESSAGES) as EventErrorCode[];
const INSTANT = new Date('2031-02-03T04:05:06.789Z');
const ORDER_ID = '0190a6a0-0000-7000-8000-0000000000aa';

/** A valid event; `extra` replaces or adds keys. */
function event(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    appId: 'couli',
    name: 'order.created',
    payload: { order_id: ORDER_ID, amount_fen: 1234 },
    ...extra,
  };
}

/** A bus with a fake queue and a clock that counts its reads. */
function bus(clockValue: unknown = INSTANT): {
  publish: (trx: unknown, value: unknown) => Promise<unknown>;
  sends: unknown[][];
  reads: () => number;
} {
  const { queue, sends } = fakeQueue();
  const { clock, reads } = countingClock(clockValue);
  let created: EventBus | undefined;
  let failure: unknown;
  try {
    created = createEventBus({
      queue: queue as never,
      clock,
      subscriptions: SUBS,
      catalog: EVT_CATALOG,
    });
  } catch (error) {
    failure = error;
  }
  return {
    // A bus that could not be created rejects every publish with the creation error, so the
    // assertions below report it.
    publish: async (trx, value) => {
      if (created === undefined) throw failure;
      return created.publish(trx as never, value as never);
    },
    sends,
    reads,
  };
}

/**
 * Publishes `value` on a fresh bus and a recording fake transaction; returns the rejection problems
 * for `code`, every access to the transaction, the sends and the clock reads.
 */
async function refused(
  value: unknown,
  code: EventErrorCode,
): Promise<{ problems: string[]; trx: string[]; sends: number; reads: number }> {
  const log: string[] = [];
  const b = bus();
  const problems = await rejectionProblems(b.publish(fakeTrx(log), value), code);
  return {
    problems,
    trx: log.filter((entry) => entry !== 'get:isTransaction'),
    sends: b.sends.length,
    reads: b.reads(),
  };
}

const CLEAN = { problems: [], trx: [], sends: 0, reads: 0 };

it('[规划/02 §11 事件清单] EVENT_NAMES 正好是 02 §11 的 18 个事件名（同序、冻结）；EVENT_SUBSCRIPTIONS 是冻结的空数组；上下界常量正好是 4096 字节、128 个码元、3 层、版本 999', () => {
  // B2-05h 两态过渡（D10-208）：B2-05e 合并后由收紧任务 B2-05j 改回单态。Without the
  // payout-went-negative consumer the subscriptions are exactly the original two; with it, it comes
  // last, subscribed to account.went_negative only.
  const expectedSubscriptions = [
    { consumer: 'notification-risk-state', events: ['risk.state_changed'] },
    { consumer: 'notification-appeal-result', events: ['appeal.resolved'] },
    { consumer: 'notification-claim-result', events: ['claim.resolved'] },
    // B1-12u（BR-TEXT-09、BR-WDR-26）：notification 的提现结果通知，只订阅 wallet.withdrawal_changed。
    { consumer: 'notification-withdrawal-result', events: ['wallet.withdrawal_changed'] },
    // B1-12zc（BR-TEXT-09，D10-773 ①）：notification 的扣回与结算负差调减通知，一个消费者同时订阅
    // order.clawed_back 与 order.settle_adjusted，紧跟 notification-withdrawal-result。
    {
      consumer: 'notification-clawback',
      events: ['order.clawed_back', 'order.settle_adjusted'],
    },
    // B1-03z（BR-FUND-22、BR-CALC-13 细则「申诉恢复」）：risk 的申诉恢复差错单生产者，只订阅 appeal.resolved。
    { consumer: 'risk-appeal-restore', events: ['appeal.resolved'] },
    ...(EVENT_SUBSCRIPTIONS.some((s) => s.consumer === 'payout-went-negative')
      ? [{ consumer: 'payout-went-negative', events: ['account.went_negative'] }]
      : []),
    // B2-11c（BR-WDR-30）：payout 的自动到账判定，最后一条，只订阅 withdrawal.created。
    { consumer: 'payout-auto-payout', events: ['withdrawal.created'] },
  ];
  expect({
    names: [...EVENT_NAMES],
    namesFrozen: Object.isFrozen(EVENT_NAMES),
    subscriptions: [...EVENT_SUBSCRIPTIONS],
    subscriptionsFrozen: Object.isFrozen(EVENT_SUBSCRIPTIONS),
    bounds: [
      MAX_EVENT_PAYLOAD_BYTES,
      MAX_EVENT_STRING_LENGTH,
      MAX_EVENT_PAYLOAD_DEPTH,
      MAX_EVENT_VERSION,
    ],
    pattern: EVENT_NAMES.every((name) => /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(name)),
  }).toStrictEqual({
    // B2-05n (D10-475 ②(a)): withdrawal.review_overdue is not pending: required, last.
    names: PLAN_02_EVENTS.filter(
      (name) => !PLAN_02_PENDING.has(name) || EVENT_NAMES.includes(name),
    ),
    namesFrozen: true,
    subscriptions: expectedSubscriptions,
    subscriptionsFrozen: true,
    bounds: [4096, 128, 3, 999],
    pattern: true,
  });
});

it('[contract §9] EventError：每个错误码的 name、code、固定文案、堆栈首行与自有属性都确切，没有 cause；EVENT_ERROR_MESSAGES 与契约逐字一致', () => {
  const problems = Object.fromEntries(
    CODES.map((code) => {
      try {
        return [code, eventErrorProblems(new EventError(code), code)];
      } catch (error) {
        return [code, [`constructor threw ${describeError(error)}`]];
      }
    }),
  );
  expect({ messages: { ...EVENT_ERROR_MESSAGES }, problems }).toStrictEqual({
    messages: EVENT_MESSAGES,
    problems: Object.fromEntries(CODES.map((code) => [code, []])),
  });
});

it('[ADR-0001 §4.2 #1; 规划/02 §11 任务 ID = event_id] newEventId：小写规范 UUIDv7（版本 7、变体 10），前 48 位正好是给定时刻的毫秒数（含 0 与 2^48−1）', () => {
  const instants = [0, 1, 255, 65_536, INSTANT.getTime(), 2 ** 48 - 1];
  const seen = instants.map((ms) => {
    try {
      const id = newEventId(new Date(ms));
      return { format: UUID_V7.test(id), ms: uuidMs(id) };
    } catch (error) {
      return { error: describeError(error) };
    }
  });
  expect(seen).toStrictEqual(instants.map((ms) => ({ format: true, ms })));
});

it('[ADR-0001 §4.2 #1; contract §3] newEventId：同一毫秒 4000 个互不相同；74 个随机位每一位都出现过 0 和 1；不合法的时刻（NaN、负数、2^48、非 Date）抛 EventError invalid_option', () => {
  const ids: string[] = [];
  let error = '';
  try {
    for (let index = 0; index < 4000; index += 1) ids.push(newEventId(INSTANT));
  } catch (caught) {
    error = describeError(caught);
  }
  // Random bits: 12 of rand_a (hex 13–15 after the version nibble), 62 of rand_b.
  const bits = (id: string): string => {
    const hex = id.replace(/-/g, '');
    const randA = BigInt(`0x${hex.slice(13, 16)}`)
      .toString(2)
      .padStart(12, '0');
    const randB = (BigInt(`0x${hex.slice(16, 32)}`) & ((1n << 62n) - 1n))
      .toString(2)
      .padStart(62, '0');
    return randA + randB;
  };
  const ones = new Array<number>(74).fill(0);
  for (const id of ids) {
    [...bits(id)].forEach((bit, index) => {
      if (bit === '1') ones[index] = (ones[index] ?? 0) + 1;
    });
  }
  const invalid = [
    new Date(Number.NaN),
    new Date(-1),
    new Date(2 ** 48),
    INSTANT.getTime(),
    INSTANT.toISOString(),
    { getTime: () => INSTANT.getTime() },
  ].map((value) => thrownProblems(() => newEventId(value as Date), 'invalid_option'));
  expect({
    error,
    count: ids.length,
    distinct: new Set(ids).size,
    allV7: ids.every((id) => UUID_V7.test(id) && uuidMs(id) === INSTANT.getTime()),
    stuckBits: ones.flatMap((count, index) => (count === 0 || count === ids.length ? [index] : [])),
    invalid,
  }).toStrictEqual({
    error: '',
    count: 4000,
    distinct: 4000,
    allV7: true,
    stuckBits: [],
    invalid: invalid.map(() => []),
  });
});

it('[contract §7] createEventBus：合法选项返回带 publish 的对象且创建时不发任务、不读时钟；选项不对（非普通对象、多键、缺 queue 或 clock、send / now 不是函数、catalog 不是数组）一律同步抛 invalid_option', () => {
  const { queue, sends } = fakeQueue();
  const { clock, reads } = countingClock(INSTANT);
  let made = 'not created';
  try {
    const created = createEventBus({
      queue: queue as never,
      clock,
      subscriptions: SUBS,
      catalog: EVT_CATALOG,
    });
    made = typeof created.publish;
    createEventBus({ queue: queue as never, clock });
  } catch (error) {
    made = describeError(error);
  }
  const bad: unknown[] = [
    null,
    undefined,
    'options',
    [],
    new (class Options {
      queue = queue;
      clock = clock;
    })(),
    { queue, clock, logger: {} },
    { clock },
    { queue },
    { queue: { send: 'x' }, clock },
    { queue: null, clock },
    { queue, clock: { now: 1 } },
    { queue, clock: null },
    { queue, clock, catalog: 'x' },
    { queue, clock, catalog: null },
  ];
  expect({
    made,
    sends: sends.length,
    reads: reads(),
    bad: bad.map((options) =>
      thrownProblems(() => createEventBus(options as never), 'invalid_option'),
    ),
  }).toStrictEqual({ made: 'function', sends: 0, reads: 0, bad: bad.map(() => []) });
});

it('[contract §6] 订阅表规则：consumer 名格式、长度（46 可、47 不可）与唯一、events 非空不重复且都在事件清单、每个消费者的 evt.<consumer> 在目录里且是 standard；违反任一条 createEventBus 抛 invalid_subscriptions', () => {
  const { queue } = fakeQueue();
  const { clock } = countingClock(INSTANT);
  const long46 = `a${text(45, 'b')}`;
  const catalog = [
    ...EVT_CATALOG,
    spec(`evt.${long46}`),
    spec(`evt.${long46}x`),
    spec('evt.excl', { policy: 'exclusive' }),
    spec('evt.with-dash'),
  ];
  const make =
    (subscriptions: unknown): (() => unknown) =>
    () =>
      createEventBus({
        queue: queue as never,
        clock,
        subscriptions: subscriptions as never,
        catalog,
      });
  const good: unknown[] = [
    [],
    SUBS,
    [{ consumer: long46, events: ['order.created'] }],
    [{ consumer: 'with-dash', events: ['agent.run_finished'] }],
  ];
  const bad: unknown[] = [
    null,
    'alpha',
    { consumer: 'alpha', events: ['order.created'] },
    [null],
    [{ consumer: 'alpha' }],
    [{ events: ['order.created'] }],
    [{ consumer: 'alpha', events: ['order.created'], extra: 1 }],
    [{ consumer: 'Alpha', events: ['order.created'] }],
    [{ consumer: '1alpha', events: ['order.created'] }],
    [{ consumer: 'al.pha', events: ['order.created'] }],
    [{ consumer: 'al_pha', events: ['order.created'] }],
    [{ consumer: '', events: ['order.created'] }],
    [{ consumer: `${long46}x`, events: ['order.created'] }],
    [
      { consumer: 'alpha', events: ['order.created'] },
      { consumer: 'alpha', events: ['order.updated'] },
    ],
    [{ consumer: 'alpha', events: [] }],
    [{ consumer: 'alpha', events: 'order.created' }],
    [{ consumer: 'alpha', events: ['order.created', 'order.created'] }],
    [{ consumer: 'alpha', events: ['order.paid'] }],
    [{ consumer: 'alpha', events: ['ORDER.created'] }],
    [{ consumer: 'gamma', events: ['order.created'] }],
    [{ consumer: 'excl', events: ['order.created'] }],
  ];
  // The default catalog (QUEUE_CATALOG) has no evt.* queue yet.
  const defaultCatalog = thrownProblems(
    () => createEventBus({ queue: queue as never, clock, subscriptions: SUBS }),
    'invalid_subscriptions',
  );
  expect({
    good: good.map((subscriptions) => thrownProblems(make(subscriptions), 'invalid_subscriptions')),
    bad: bad.map((subscriptions) => thrownProblems(make(subscriptions), 'invalid_subscriptions')),
    defaultCatalog,
    catalogWithoutQueues: thrownProblems(
      () =>
        createEventBus({
          queue: queue as never,
          clock,
          subscriptions: SUBS,
          catalog: [TEST_DEAD],
        }),
      'invalid_subscriptions',
    ),
  }).toStrictEqual({
    good: good.map(() => ['returned']),
    bad: bad.map(() => []),
    defaultCatalog: [],
    catalogWithoutQueues: [],
  });
});

it('[规划/02 §11 同事务入队; contract §4] publish 的事务检查：null、undefined、空对象、isTransaction 不是 true（false、字符串）、db 句柄一类对象都拒绝 invalid_transaction，不读时钟、不发任务', async () => {
  const b = bus();
  const values: unknown[] = [
    null,
    undefined,
    {},
    { isTransaction: false },
    { isTransaction: 'true' },
    { isTransaction: 1 },
    { isTransaction: false, selectFrom: () => undefined, transaction: () => undefined },
    'trx',
  ];
  const problems: string[][] = [];
  for (const trx of values) {
    problems.push(await rejectionProblems(b.publish(trx, event()), 'invalid_transaction'));
  }
  expect({ problems, sends: b.sends.length, reads: b.reads() }).toStrictEqual({
    problems: values.map(() => []),
    sends: 0,
    reads: 0,
  });
});

it('[contract §2] 事件形状：非普通对象、缺 appId / name / payload、多出键（occurredAt、id）、访问器、符号键都拒绝 invalid_event；只读过事务的 isTransaction，不读时钟、不发任务', async () => {
  const accessor = event();
  Object.defineProperty(accessor, 'name', { get: () => 'order.created', enumerable: true });
  const symbolKey = { ...event(), [Symbol('x')]: 1 };
  const missing = (key: string): Record<string, unknown> => {
    const copy = event();
    delete copy[key];
    return copy;
  };
  const values: unknown[] = [
    null,
    'order.created',
    [],
    new (class Event {
      appId = 'couli';
      name = 'order.created';
      payload = {};
    })(),
    missing('appId'),
    missing('name'),
    missing('payload'),
    event({ occurredAt: INSTANT }),
    event({ id: ORDER_ID }),
    event({ consumer: 'alpha' }),
    accessor,
    symbolKey,
  ];
  const seen = [];
  for (const value of values) seen.push(await refused(value, 'invalid_event'));
  expect(seen).toStrictEqual(values.map(() => CLEAN));
});

it('[contract §2] appId：1..64 个 [A-Za-z0-9._-] 字符；空串、65 个字符、空格、非 ASCII、非字符串都拒绝 invalid_app_id', async () => {
  const values: unknown[] = ['', text(65), 'cou li', 'couli\n', '凑狸', 'couli/1', 1, null];
  const seen = [];
  for (const appId of values) seen.push(await refused(event({ appId }), 'invalid_app_id'));
  expect(seen).toStrictEqual(values.map(() => CLEAN));
});

it('[规划/02 §11 事件清单; contract §1] 事件名只认 EVENT_NAMES：清单外的名字、大小写不同、带空白、三段式、非字符串都拒绝 unknown_event', async () => {
  const values: unknown[] = [
    'order.paid',
    'Order.created',
    'order.created ',
    'order.created.v2',
    'order',
    'evt.alpha',
    '',
    1,
    null,
  ];
  const seen = [];
  for (const name of values) seen.push(await refused(event({ name }), 'unknown_event'));
  expect(seen).toStrictEqual(values.map(() => CLEAN));
});

it('[contract §2] version：整数 1..999；0、1000、-1、1.5、NaN、Infinity、字符串、null、bigint 都拒绝 invalid_version', async () => {
  const values: unknown[] = [0, 1000, -1, 1.5, Number.NaN, Infinity, '1', null, 1n];
  const seen = [];
  for (const version of values) seen.push(await refused(event({ version }), 'invalid_version'));
  expect(seen).toStrictEqual(values.map(() => CLEAN));
});

it('[规划/02 §11 任务 ID = event_id; contract §2] eventId：小写规范 UUID；大写、带花括号、无短横线、少一位、多一位、空串、null、数字都拒绝 invalid_event_id', async () => {
  const values: unknown[] = [
    ORDER_ID.toUpperCase(),
    `{${ORDER_ID}}`,
    ORDER_ID.replace(/-/g, ''),
    ORDER_ID.slice(1),
    `${ORDER_ID}0`,
    ` ${ORDER_ID}`,
    '',
    null,
    1,
  ];
  const seen = [];
  for (const eventId of values) seen.push(await refused(event({ eventId }), 'invalid_event_id'));
  expect(seen).toStrictEqual(values.map(() => CLEAN));
});

it('[规划/02 §19 类型; contract §2] payload 不是小的 JSON 对象（非普通对象、undefined、小数、NaN、超安全整数、bigint、符号、函数、Date、Map、类实例、空洞数组、带额外属性的数组、U+0000、孤立代理、环、访问器、符号键、非蛇形键、65 字符键、129 码元字符串、第 4 层嵌套）都拒绝 invalid_payload', async () => {
  const cycle: Record<string, unknown> = { a: 1 };
  cycle.self = cycle;
  const accessor = {};
  Object.defineProperty(accessor, 'a', { get: () => 1, enumerable: true });
  const hidden = { a: 1 };
  Object.defineProperty(hidden, 'b', { value: 1, enumerable: false });
  const extraArray = Object.assign([1, 2], { extra: 1 });
  const holes = [1, , 3];
  const values: unknown[] = [
    null,
    [],
    'payload',
    new Date(),
    new Map(),
    new (class Payload {
      order_id = ORDER_ID;
    })(),
    { a: undefined },
    { a: 1.5 },
    { a: Number.NaN },
    { a: Infinity },
    { a: 2 ** 53 },
    { a: 1n },
    { a: Symbol('a') },
    { a: () => 1 },
    { a: new Date() },
    { a: new Map() },
    { a: new String('x') },
    { a: new Uint8Array(2) },
    { a: holes },
    { a: extraArray },
    { a: 'x\u0000y' },
    { a: '\uD800' },
    { '\uD800': 1 },
    cycle,
    accessor,
    hidden,
    { [Symbol('a')]: 1 },
    { A: 1 },
    { orderId: ORDER_ID },
    { 'order-id': ORDER_ID },
    { '1a': 1 },
    { _a: 1 },
    { '': 1 },
    { [`a${text(64)}`]: 1 },
    { a: text(129) },
    { a: [text(129)] },
    { a: { b: text(129) } },
    { a: { b: { c: {} } } },
    { a: [[[]]] },
    { a: { b: [1, { c: 1 }] } },
  ];
  const seen = [];
  for (const payload of values) seen.push(await refused(event({ payload }), 'invalid_payload'));
  expect(seen).toStrictEqual(values.map(() => CLEAN));
});

it('[规划/02 §12.3; contract §2] payload 不带个人数据：SENSITIVE_KEYS 的每个名字（蛇形写法）与 email、name、nickname、address、ip、open_id、union_id，在顶层、嵌套对象、数组里的对象中，去掉下划线后同形的写法（phonenumber、idcard、openid）都拒绝 personal_data', async () => {
  const snake = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const listed = [
    ...SENSITIVE_KEYS.map(snake),
    'email',
    'name',
    'nickname',
    'address',
    'ip',
    'open_id',
    'union_id',
  ];
  const variants = [
    'phonenumber',
    'idcard',
    'openid',
    'unionid',
    'realname',
    'set_cookie',
    'x_sign',
  ];
  const payloads: unknown[] = [
    ...listed.map((key) => ({ order_id: ORDER_ID, [key]: 'x' })),
    ...variants.map((key) => ({ [key]: 1 })),
    { order: { phone: 'x' } },
    { items: [{ order_id: ORDER_ID }, { email: 'x' }] },
    { a: { b: [] }, user: { real_name: null } },
  ];
  const seen = [];
  for (const payload of payloads) seen.push(await refused(event({ payload }), 'personal_data'));
  expect({
    hasSome: ['phone', 'id_card', 'bank_card_no', 'alipay_logon_id', 'password'].every((key) =>
      listed.includes(key),
    ),
    seen,
  }).toStrictEqual({ hasSome: true, seen: payloads.map(() => CLEAN) });
});

it('[contract §2] payload 大小：JSON.stringify 的 UTF-8 字节数 4097（多字节字符按字节计）拒绝 payload_too_large；检查顺序为事务、形状、appId、名字、版本、eventId、payload 合法、个人数据、大小', async () => {
  const big = payloadOfBytes(4097);
  const bigAscii: Record<string, string> = {};
  for (let index = 0; Buffer.byteLength(JSON.stringify(bigAscii)) < 4097; index += 1) {
    bigAscii[`k${index}`] = text(100);
  }
  const order = [
    await refused(event({ appId: '', name: 'order.paid' }), 'invalid_app_id'),
    await refused(event({ name: 'order.paid', version: 0 }), 'unknown_event'),
    await refused(event({ version: 0, eventId: 'x' }), 'invalid_version'),
    await refused(event({ eventId: 'x', payload: { a: 1.5 } }), 'invalid_event_id'),
    await refused(event({ payload: { phone: 'x', a: 1.5 } }), 'invalid_payload'),
    await refused(event({ payload: { ...big, phone: 'x' } }), 'personal_data'),
  ];
  const both = await rejectionProblems(
    bus().publish(null, event({ appId: '' })),
    'invalid_transaction',
  );
  expect({
    bigBytes: Buffer.byteLength(JSON.stringify(big)),
    big: await refused(event({ payload: big }), 'payload_too_large'),
    bigAscii: await refused(event({ payload: bigAscii }), 'payload_too_large'),
    shape: await refused(event({ appId: '', extra: 1 }), 'invalid_event'),
    order,
    both,
  }).toStrictEqual({
    bigBytes: 4097,
    big: CLEAN,
    bigAscii: CLEAN,
    shape: CLEAN,
    order: order.map(() => CLEAN),
    both: [],
  });
});

it('[ADR-0001 §4.2 #10 时钟; contract §4] 检查都通过后只读一次时钟；时钟给出的不是合法时刻（NaN、2^48 毫秒、负数、字符串）拒绝 invalid_option，不执行语句（事务只被读过 isTransaction）、不发任务', async () => {
  const values: unknown[] = [
    new Date(Number.NaN),
    new Date(2 ** 48),
    new Date(-1),
    INSTANT.toISOString(),
    INSTANT.getTime(),
  ];
  const seen = [];
  for (const value of values) {
    const b = bus(value);
    const log: string[] = [];
    const problems = await rejectionProblems(b.publish(fakeTrx(log), event()), 'invalid_option');
    seen.push({
      problems,
      trx: log.filter((entry) => entry !== 'get:isTransaction'),
      sends: b.sends.length,
      reads: b.reads(),
    });
  }
  expect(seen).toStrictEqual(values.map(() => ({ ...CLEAN, reads: 1 })));
});

/** A fake runtime that records its register calls. */
function fakeRuntime(error?: unknown): {
  runtime: { register: (queue: string, handler: JobHandler) => void };
  calls: unknown[][];
} {
  const calls: unknown[][] = [];
  return {
    calls,
    runtime: {
      register: (queue: string, handler: JobHandler) => {
        calls.push([queue, typeof handler]);
        if (error !== undefined) throw error;
      },
    },
  };
}

function consumerOptions(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    consumer: 'alpha',
    db: {},
    logger: { info: () => undefined },
    handler: async () => undefined,
    subscriptions: SUBS,
    ...extra,
  };
}

it('[规划/02 §11 消费幂等; contract §8] registerEventConsumer：合法时正好一次 register("evt.<consumer>", 函数) 并返回 undefined、不碰 db；选项不对抛 invalid_option，订阅表不对抛 invalid_subscriptions，消费者不在订阅表抛 unknown_consumer（按此顺序）；register 抛的 QueueError 原样传出', () => {
  const ok = fakeRuntime();
  const dbLog: string[] = [];
  let returned: unknown = 'threw';
  try {
    returned = registerEventConsumer(
      ok.runtime,
      consumerOptions({ consumer: 'beta', db: recordingProxy({}, dbLog) }) as never,
    );
  } catch (error) {
    returned = describeError(error);
  }
  const bad = (options: unknown): string[] => {
    const fake = fakeRuntime();
    const problems = [
      ...thrownProblems(
        () => registerEventConsumer(fake.runtime, options as never),
        'invalid_option',
      ),
    ];
    if (fake.calls.length > 0) problems.push('registered');
    return problems;
  };
  const badOptions: unknown[] = [
    null,
    'alpha',
    consumerOptions({ extra: 1 }),
    consumerOptions({ handler: 'x' }),
    consumerOptions({ db: null }),
    consumerOptions({ logger: {} }),
    consumerOptions({ logger: null }),
    { db: {}, logger: { info: () => undefined }, handler: async () => undefined },
    consumerOptions({ subscriptions: 'x', handler: 1 }),
  ];
  const subsFake = fakeRuntime();
  const subs = thrownProblems(
    () =>
      registerEventConsumer(
        subsFake.runtime,
        consumerOptions({
          consumer: 'zeta',
          subscriptions: [{ consumer: 'alpha', events: ['order.paid'] }],
        }) as never,
      ),
    'invalid_subscriptions',
  );
  const unknown = [
    consumerOptions({ consumer: 'gamma' }),
    consumerOptions({ consumer: 'ALPHA' }),
    consumerOptions({ consumer: 'evt.alpha' }),
    (() => {
      // Without the key the default EVENT_SUBSCRIPTIONS (empty) applies.
      const { subscriptions, ...rest } = consumerOptions();
      void subscriptions;
      return rest;
    })(),
  ].map((options) => {
    const fake = fakeRuntime();
    const problems = thrownProblems(
      () => registerEventConsumer(fake.runtime, options as never),
      'unknown_consumer',
    );
    return fake.calls.length > 0 ? [...problems, 'registered'] : problems;
  });
  const queueError = (() => {
    try {
      return new QueueError('not_in_entry');
    } catch {
      return new Error('QueueError not constructible');
    }
  })();
  const propagated = (() => {
    try {
      registerEventConsumer(fakeRuntime(queueError).runtime, consumerOptions() as never);
    } catch (error) {
      return error === queueError;
    }
    return false;
  })();
  expect({
    returned,
    calls: ok.calls,
    db: dbLog,
    badOptions: badOptions.map(bad),
    subs,
    subsRegistered: subsFake.calls.length,
    unknown,
    propagated,
  }).toStrictEqual({
    returned: undefined,
    calls: [['evt.beta', 'function']],
    db: [],
    badOptions: badOptions.map(() => []),
    subs: [],
    subsRegistered: 0,
    unknown: unknown.map(() => []),
    propagated: true,
  });
});

it('[contract §8.1] 消费端任务检查：id 不是小写 UUID、任务名不是本消费者订阅的（含别的消费者的）、信封缺键或多键、app_id 不合法、v 越界或非整数、occurred_at 不是毫秒 Z 格式、data 不是普通对象，都拒绝 invalid_event，不碰 db、不调处理器、不写日志', async () => {
  const { runtime, calls } = (() => {
    const captured: JobHandler[] = [];
    const fake = {
      register: (_queue: string, handler: JobHandler) => {
        captured.push(handler);
      },
    };
    return { runtime: fake, calls: captured };
  })();
  const dbLog: string[] = [];
  const loggerLog: string[] = [];
  let handled = 0;
  let setup = 'ok';
  try {
    registerEventConsumer(runtime, {
      consumer: 'alpha',
      db: recordingProxy({}, dbLog) as never,
      logger: recordingProxy({ info: () => undefined }, loggerLog) as never,
      handler: async () => {
        handled += 1;
      },
      subscriptions: SUBS,
    });
  } catch (error) {
    setup = describeError(error);
  }
  // Only what happens while handling jobs counts (registration may check the logger's shape).
  loggerLog.length = 0;
  dbLog.length = 0;
  const envelope = {
    app_id: 'couli',
    v: 1,
    occurred_at: '2031-02-03T04:05:06.789Z',
    data: { order_id: ORDER_ID },
  };
  const job = (extra: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) => ({
    id: ORDER_ID,
    queue: 'evt.alpha',
    name: 'order.created',
    attempt: 1,
    payload: { ...envelope, ...payload },
    ...extra,
  });
  const withoutKey = (key: string): Record<string, unknown> => {
    const copy: Record<string, unknown> = { ...envelope };
    delete copy[key];
    return { payload: copy };
  };
  const jobs: unknown[] = [
    job({ id: ORDER_ID.toUpperCase() }),
    job({ id: 'not-a-uuid' }),
    job({ name: 'member.registered' }),
    job({ name: 'order.credited' }),
    job({ name: 'order.paid' }),
    job(withoutKey('app_id')),
    job(withoutKey('v')),
    job(withoutKey('occurred_at')),
    job(withoutKey('data')),
    job({}, { extra: 1 }),
    job({}, { app_id: '' }),
    job({}, { app_id: 'cou li' }),
    job({}, { v: 0 }),
    job({}, { v: 1000 }),
    job({}, { v: '1' }),
    job({}, { v: 1.5 }),
    job({}, { occurred_at: '2031-02-03T04:05:06Z' }),
    job({}, { occurred_at: '2031-02-03T04:05:06.789+00:00' }),
    job({}, { occurred_at: 1_927_771_506_789 }),
    job({}, { data: [] }),
    job({}, { data: null }),
    job({}, { data: 'x' }),
  ];
  const problems: string[][] = [];
  const handler = calls[0];
  for (const value of jobs) {
    problems.push(
      handler === undefined
        ? ['no handler registered']
        : await rejectionProblems(handler(value as never), 'invalid_event'),
    );
  }
  expect({ setup, problems, db: dbLog, logger: loggerLog, handled }).toStrictEqual({
    setup: 'ok',
    problems: jobs.map(() => []),
    db: [],
    logger: [],
    handled: 0,
  });
});
