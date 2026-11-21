import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import * as traceQueue from '../../../../apps/api/src/modules/agent/stream/mount/trace-retry.ts';
import { LIST_ARGS, replyTextOf } from '../reply-persist/kit.ts';
import { insertChunk } from '../rule-search-wiring/kit.ts';
import { fileText, openSession, until, usePgEach } from '../stream-mount/kit.ts';
import { cardTypesOf, eventually, finishOf, runIdOf, shapeOf } from '../trace-persist/kit.ts';
import { LOST, WRITE_FAILED } from '../trace-retry/kit.ts';
import { driveUntil } from '../trace-retry/runtime-kit.ts';
import { item } from '../tools-orders/kit.ts';
import {
  BACKUP,
  gate,
  intent,
  observeRunUpdates,
  ORDERS,
  PRIMARY,
  PROMPT,
  QUESTION,
  runtimeRig,
  SPEC_TIMEOUT,
  storedRun,
  tool,
} from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

it(
  '[AC-B3-08t#6] 主备都失败时降级，终态清空受理时预写的模型快照，保留提示词版本',
  async () => {
    const admitted = vi.fn(async () =>
      pg.db
        .selectFrom('agent_runs')
        .select(['model_snapshot', 'prompt_version', 'final_event'])
        .executeTakeFirstOrThrow(),
    );
    const x = await runtimeRig(pg.db, {
      steps: [
        {
          degrade: true,
          before: async () => {
            await admitted();
          },
        },
      ],
    });
    try {
      const frames = await x.ask(await openSession(x.r, x.caller), QUESTION);
      expect(cardTypesOf(frames)).toContain('product_list');
      expect(admitted).toHaveBeenCalledOnce();
      expect(await admitted.mock.results[0]?.value).toMatchObject({
        model_snapshot: PRIMARY,
        prompt_version: PROMPT,
        final_event: null,
      });
      const read = () => storedRun(pg.db, x.appId, runIdOf(frames));
      expect(await read()).toMatchObject({
        model: null,
        model_snapshot: null,
        prompt_version: PROMPT,
        intent: 'search',
        input_passed: true,
        final_event: expect.any(Object),
      });
      await x.r.runtime.close();
      expect(await read()).toMatchObject({
        model: null,
        model_snapshot: null,
        prompt_version: PROMPT,
      });
    } finally {
      await x.r.runtime.close();
    }
  },
  SPEC_TIMEOUT,
);

const RULE_QUESTION = '提现最低多少';
const MODEL_COPY = '这是模型生成的说明。';

it.each([
  [
    ORDERS,
    tool('list_my_orders', LIST_ARGS),
    'order_query',
    'order_status',
    'order_status.PAID.summary',
  ],
  [
    RULE_QUESTION,
    tool('search_rules', { question: RULE_QUESTION }),
    'rule_qa',
    'rule_ref',
    'agent.rule.found',
  ],
] as const)(
  '[AC-B3-08t#6] %s 由模型选工具、模板写回答，实际使用的备选模型与快照照记',
  async (question, call, expected, card, copyKey) => {
    const x = await runtimeRig(pg.db, { steps: [call, { text: MODEL_COPY }] });
    try {
      if (expected === 'rule_qa') {
        await insertChunk(pg.db, { appId: x.appId, title: RULE_QUESTION, text: RULE_QUESTION });
      } else {
        x.f.searchForAgent.mockResolvedValue({ orders: [item({ platform: 'taobao' })], total: 1 });
      }
      const frames = await x.ask(await openSession(x.r, x.caller), question);
      expect(finishOf(frames)).toBe('stop');
      expect(replyTextOf(frames)).not.toContain(MODEL_COPY);
      expect(replyTextOf(frames)).toContain(fileText(copyKey));
      expect(cardTypesOf(frames)).toContain(card);
      const read = () => storedRun(pg.db, x.appId, runIdOf(frames));
      const row = await eventually(
        '模板轮的模型留痕',
        read,
        (found) => found.model === BACKUP && found.model_snapshot === BACKUP,
      );
      expect(row).toMatchObject({
        model: BACKUP,
        model_snapshot: BACKUP,
        prompt_version: PROMPT,
        intent: expected,
      });
    } finally {
      await x.r.runtime.close();
    }
  },
  SPEC_TIMEOUT,
);

it(
  '[AC-B3-08t#11] 异步留痕写入仍在等待时，终态已经提交并下发',
  async () => {
    const release = gate();
    let held = false;
    const db = observeRunUpdates(pg.db, (statement) => {
      if (!/\binput_tokens\b/iu.test(statement)) return;
      return async () => {
        held = true;
        await release.promise;
      };
    });
    const x = await runtimeRig(db, {
      steps: [
        {
          ...intent('out_of_scope'),
          usage: { input_tokens: 31, output_tokens: 9 },
        },
      ],
    });
    try {
      const active = x.start(await openSession(x.r, x.caller));
      await until('运行级留痕写入被暂时挂起', () => held);
      await until('留痕挂起时终态已下发', () => finishOf(active.frames()) === 'stop');
      const runId = runIdOf(active.frames());
      expect(await storedRun(pg.db, x.appId, runId)).toMatchObject({
        final_event: { type: 'done', data: active.frames().at(-1)?.data },
        intent: 'out_of_scope',
        input_passed: true,
      });
      release.open();
      expect(await active.settled).toEqual({ ok: true });
    } finally {
      release.open();
      await x.r.runtime.close();
    }
  },
  SPEC_TIMEOUT,
);

it(
  '[AC-B3-08t#6] 商品情境入口先出卡，随后模型处理文字且保留实际使用的模型',
  async () => {
    const x = await runtimeRig(pg.db, { steps: [{ text: MODEL_COPY }] });
    try {
      const frames = await x.ask(await openSession(x.r, x.caller), '这件商品有返利吗', {
        product_key: 'tb:synthetic-cup',
      });
      expect(cardTypesOf(frames)).toContain('rebate_quote');
      expect(replyTextOf(frames)).toContain(MODEL_COPY);
      expect(x.complete).toHaveBeenCalledOnce();
      const row = await eventually(
        '商品入口轮的模型留痕',
        () => storedRun(pg.db, x.appId, runIdOf(frames)),
        (found) => found.model_snapshot === BACKUP,
      );
      expect(row).toMatchObject({
        model: BACKUP,
        model_snapshot: BACKUP,
        prompt_version: PROMPT,
        intent: 'find_by_link',
      });
    } finally {
      await x.r.runtime.close();
    }
  },
  SPEC_TIMEOUT,
);

const FILTERED_SENTENCE = '售价 29 元，链接 https://example.com/cup，复制￥AbCd123456￥。';
const TRAILING_SENTENCES = '再看商品卡。第三句话不能下发。';

it(
  '[AC-B3-08t#10] 汇总多轮真实使用量，精确记录首字与总耗时以及过滤和截断',
  async () => {
    const firstTextMs = 137;
    const nextRoundMs = 284;
    const totalMs = firstTextMs + nextRoundMs;
    const x = await runtimeRig(pg.db, {
      // 关闭会替换回复正文的工具，让首轮文本在次轮开始前下发。
      config: {
        'agent.tools.list_my_orders.enabled': false,
        'agent.tools.explain_order.enabled': false,
        'agent.tools.search_rules.enabled': false,
        'agent.tools.get_my_earnings.enabled': false,
      },
      steps: [
        {
          ...tool('search_products', { q: '合成保温杯' }),
          text: FILTERED_SENTENCE,
          usage: { input_tokens: 13, output_tokens: 7 },
          before: () => x.r.time.by(firstTextMs),
        },
        {
          text: TRAILING_SENTENCES,
          usage: { input_tokens: 19, output_tokens: 11 },
          before: () => x.r.time.by(nextRoundMs),
        },
      ],
    });
    try {
      const frames = await x.ask(await openSession(x.r, x.caller), QUESTION);
      expect(finishOf(frames)).toBe('stop');
      const text = replyTextOf(frames);
      expect(text).toContain('见卡片');
      expect(text).toContain('再看商品卡');
      expect(text).not.toMatch(/29|example\.com|AbCd123456|第三句话/u);
      const runId = runIdOf(frames);
      const row = await eventually(
        '两个模型轮次的留痕',
        () => storedRun(pg.db, x.appId, runId),
        (found) =>
          found.input_tokens !== null &&
          found.output_tokens !== null &&
          found.ttft_ms !== null &&
          found.latency_ms !== null &&
          found.output_filtered &&
          found.output_truncated,
      );
      expect(row).toMatchObject({
        input_tokens: 32,
        output_tokens: 18,
        output_filtered: true,
        output_truncated: true,
        page_guide_reject_reason: null,
        ttft_ms: firstTextMs,
        latency_ms: totalMs,
      });
      expect([...row.filter_hits].sort()).toEqual(['amount', 'tpwd', 'url']);
      for (const ms of [row.ttft_ms, row.latency_ms]) {
        expect(Number.isInteger(ms)).toBe(true);
        expect(ms).toBeGreaterThanOrEqual(0);
      }
      expect(row.ttft_ms).toBeLessThanOrEqual(totalMs);
    } finally {
      await x.r.runtime.close();
    }
  },
  SPEC_TIMEOUT,
);

async function waitForTrace<T>(
  what: string,
  read: () => Promise<T>,
  ready: (value: T) => boolean,
): Promise<T> {
  let value = await read();
  for (let i = 0; i < 400 && !ready(value); i += 1) {
    value = await read();
  }
  expect(ready(value), what).toBe(true);
  return value;
}

it(
  '[AC-B3-08t#10] 同一运行时逐轮记录过滤命中，并区分截断、完整通过和仅过滤',
  async () => {
    const x = await runtimeRig(pg.db, {
      steps: [
        { text: FILTERED_SENTENCE + TRAILING_SENTENCES },
        { text: MODEL_COPY },
        { text: '售价 29 元。再看商品卡。' },
      ],
    });
    try {
      const session = await openSession(x.r, x.caller);
      const first = await x.ask(session, QUESTION);
      expect(finishOf(first)).toBe('stop');
      expect(replyTextOf(first)).not.toContain('第三句话');
      const firstRow = await waitForTrace(
        '首轮截断回复的留痕已落库',
        () => storedRun(pg.db, x.appId, runIdOf(first)),
        (row) => row.latency_ms !== null && row.output_filtered && row.output_truncated,
      );
      expect(firstRow).toMatchObject({ output_filtered: true, output_truncated: true });
      expect([...firstRow.filter_hits].sort()).toEqual(['amount', 'tpwd', 'url']);

      const clean = await x.ask(session, '杯盖一般怎么清洗');
      expect(finishOf(clean)).toBe('stop');
      expect(replyTextOf(clean)).toContain(MODEL_COPY);
      const readClean = () => storedRun(pg.db, x.appId, runIdOf(clean));
      await waitForTrace('第二轮干净回复的耗时已落库', readClean, (row) => row.latency_ms !== null);

      const filtered = await x.ask(session, '杯子的价格怎么看');
      expect(finishOf(filtered)).toBe('stop');
      expect(replyTextOf(filtered)).toContain('见卡片');
      expect(replyTextOf(filtered)).toContain('再看商品卡');
      expect(replyTextOf(filtered)).not.toContain('29');
      const readFiltered = () => storedRun(pg.db, x.appId, runIdOf(filtered));
      await waitForTrace(
        '第三轮仅过滤回复的留痕已落库',
        readFiltered,
        (row) => row.latency_ms !== null && row.output_filtered,
      );
      await x.r.runtime.close();
      expect(await readClean()).toMatchObject({
        filter_hits: [],
        output_filtered: false,
        output_truncated: false,
      });
      expect(await readFiltered()).toMatchObject({
        filter_hits: ['amount'],
        output_filtered: true,
        output_truncated: false,
      });
    } finally {
      await x.r.runtime.close();
    }
  },
  SPEC_TIMEOUT,
);

it(
  '[AC-B3-08t#6][AC-B3-08t#10] 模型报文未用于结果而改走降级，模型字段为空，已发生的 token 仍写入',
  async () => {
    const x = await runtimeRig(pg.db, {
      steps: [
        {
          text: JSON.stringify({ card: '伪造模型卡' }),
          usage: { input_tokens: 23, output_tokens: 17 },
        },
      ],
    });
    try {
      const frames = await x.ask(await openSession(x.r, x.caller), QUESTION);
      expect(cardTypesOf(frames)).toContain('product_list');
      expect(replyTextOf(frames)).not.toContain('伪造模型卡');
      const runId = runIdOf(frames);
      expect(await storedRun(pg.db, x.appId, runId)).toMatchObject({
        model: null,
        model_snapshot: null,
        prompt_version: PROMPT,
        final_event: expect.any(Object),
      });
      const row = await eventually(
        '被丢弃的模型报文也有用量',
        () => storedRun(pg.db, x.appId, runId),
        (found) => found.input_tokens !== null,
      );
      expect(row).toMatchObject({
        input_tokens: 23,
        output_tokens: 17,
        model: null,
        model_snapshot: null,
      });
    } finally {
      await x.r.runtime.close();
    }
  },
  SPEC_TIMEOUT,
);

const guideCases = [
  { reason: 'not_allowed', question: '钱包在哪', route: 'OrderList', fields: {} },
  { reason: 'extra_fields', question: '钱包在哪', route: 'Wallet', fields: { params: {} } },
  { reason: 'disabled', question: '钱包在哪', route: 'Wallet', fields: {} },
  {
    reason: 'untrusted_input',
    question: '分享文案：合成正文，钱包在哪',
    route: 'Wallet',
    fields: {},
  },
  { reason: 'params_requested', question: '打开钱包，名称:合成值', route: 'Wallet', fields: {} },
] as const;

it.each(guideCases)(
  '[AC-B3-08t#5][AC-B3-08t#10] 页面引导拒绝 $reason，终态仍记通过，拒绝原因随留痕写入',
  async ({ reason, question, route, fields }) => {
    const x = await runtimeRig(pg.db, {
      steps: [intent('page_guide', { guide_route: route, ...fields })],
      config: { 'agent.page_guide.enabled': reason !== 'disabled' },
    });
    try {
      const frames = await x.ask(await openSession(x.r, x.caller), question);
      expect(finishOf(frames)).toBe('stop');
      expect(cardTypesOf(frames)).not.toContain('page_guide');
      const read = () => storedRun(pg.db, x.appId, runIdOf(frames));
      expect(await read()).toMatchObject({
        intent: 'page_guide',
        input_passed: true,
        final_event: { type: 'done', data: frames.at(-1)?.data },
      });
      const row = await eventually(
        '页面引导拒绝原因',
        read,
        (found) => found.page_guide_reject_reason !== null,
      );
      expect(row.page_guide_reject_reason).toBe(reason);
    } finally {
      await x.r.runtime.close();
    }
  },
  SPEC_TIMEOUT,
);

it(
  '[AC-B3-08t#11] 运行级留痕写失败时照常下发终态，数据库恢复后重试并补写用量',
  async () => {
    const queueFactory = vi.spyOn(traceQueue, 'createTraceRedoQueue');
    let unavailable = false;
    let refused = 0;
    const db = observeRunUpdates(pg.db, (statement) => {
      if (unavailable && /\binput_tokens\b/iu.test(statement)) {
        refused += 1;
        throw new Error('合成故障：运行级留痕暂不可写');
      }
    });
    const step = { text: MODEL_COPY, usage: { input_tokens: 29, output_tokens: 5 } };
    const x = await runtimeRig(db, { steps: [step, step] });
    try {
      const control = await x.ask(await openSession(x.r, x.caller), QUESTION);
      expect(finishOf(control)).toBe('stop');
      await eventually(
        '正常运行的用量先落库',
        () => storedRun(pg.db, x.appId, runIdOf(control)),
        (row) => row.input_tokens === 29,
      );

      unavailable = true;
      const frames = await x.ask(await openSession(x.r, x.caller), '再帮我找合成保温杯');
      expect(shapeOf(frames)).toEqual(shapeOf(control));
      const runId = runIdOf(frames);
      await until(
        '写失败已交给已有的留痕队列',
        () => refused > 0 && x.f.logs.of(WRITE_FAILED).some((line) => line['run_id'] === runId),
      );
      const queue = queueFactory.mock.results.find((result) => result.type === 'return')?.value;
      expect(queue?.queued()).toBe(1);
      const terminal = { type: 'done', data: frames.at(-1)?.data };
      expect(await storedRun(pg.db, x.appId, runId)).toMatchObject({
        final_event: terminal,
        input_passed: true,
        input_tokens: null,
        output_tokens: null,
      });

      unavailable = false;
      const written = await driveUntil(
        x.r.time,
        '重试补写同一 run',
        () => storedRun(pg.db, x.appId, runId),
        (row) => row.input_tokens === 29 && row.output_tokens === 5,
      );
      expect(written).toMatchObject({
        final_event: terminal,
        input_passed: true,
        input_tokens: 29,
        output_tokens: 5,
      });
      await until('补写成功后清出留痕队列', () => queue?.queued() === 0);
      expect(x.f.logs.of(LOST)).toEqual([]);
    } finally {
      unavailable = false;
      await x.r.runtime.close();
    }
  },
  SPEC_TIMEOUT,
);

it(
  '[AC-B3-08t#11] 用量已经提交但写入确认丢失，重试后不重复累计 token',
  async () => {
    let tokenUpdateExecuted = false;
    let completedWrites = 0;
    const db = observeRunUpdates(pg.db, (statement) => {
      if (!/\binput_tokens\b/iu.test(statement)) return;
      return async () => {
        tokenUpdateExecuted = true;
      };
    });
    const createQueue = traceQueue.createTraceRedoQueue;
    const queueFactory = vi.spyOn(traceQueue, 'createTraceRedoQueue').mockImplementation((deps) =>
      createQueue({
        ...deps,
        writer: new Proxy(deps.writer, {
          get(writer, key, receiver) {
            const method: unknown = Reflect.get(writer, key, receiver);
            if (typeof method !== 'function') return method;
            return async (...args: unknown[]) => {
              const result: unknown = await Reflect.apply(method, writer, args);
              // UPDATE 已返回。等整个写入方法返回后再丢失确认，事务里的 UPDATE 此时也已提交。
              if (tokenUpdateExecuted && ++completedWrites === 1) {
                throw new Error('合成故障：留痕已提交，写入确认丢失');
              }
              return result;
            };
          },
        }),
      }),
    );
    const x = await runtimeRig(db, {
      steps: [{ text: MODEL_COPY, usage: { input_tokens: 29, output_tokens: 5 } }],
    });
    try {
      const frames = await x.ask(await openSession(x.r, x.caller), QUESTION);
      expect(finishOf(frames)).toBe('stop');
      expect(replyTextOf(frames)).toContain(MODEL_COPY);
      const runId = runIdOf(frames);
      const read = () => storedRun(pg.db, x.appId, runId);
      const queue = queueFactory.mock.results.find((result) => result.type === 'return')?.value;
      await waitForTrace(
        '丢失确认后，已提交的用量可读且写入已经入队',
        read,
        () =>
          queue?.queued() === 1 &&
          x.f.logs.of(WRITE_FAILED).some((line) => line['run_id'] === runId),
      );
      const terminal = { type: 'done', data: frames.at(-1)?.data };
      expect(await read()).toMatchObject({
        final_event: terminal,
        input_tokens: 29,
        output_tokens: 5,
      });

      await x.r.time.by(traceQueue.traceRedoDefaults().firstDelayMs);
      await waitForTrace(
        '已提交的留痕重试成功并出队',
        read,
        () => completedWrites >= 2 && queue?.queued() === 0,
      );
      expect(await read()).toMatchObject({
        final_event: terminal,
        input_tokens: 29,
        output_tokens: 5,
      });
      expect(x.f.logs.of(LOST)).toEqual([]);
    } finally {
      await x.r.runtime.close();
    }
  },
  SPEC_TIMEOUT,
);
