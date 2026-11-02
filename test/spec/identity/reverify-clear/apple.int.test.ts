// B1-02zw · the Apple revocation of an unbound identity (BR-WDR-01 细则「清除标记只走人工」, BR-ID-28;
// 编排 D10-513 ④; contract adminEditUserProfile「Pending re-verification」; task §9 #4 #5 #6): in the
// phone-change transaction the binding row goes and one job is written, carrying the refresh token
// only as the stored cipher; after the commit the job calls Apple through AppleTokenRevoker, decrypting
// at call time; a failure is retried and alerted on as the deletion flow counts it
// (deletion-processing.ts revokeApple: three attempts, one warn line, AC-B1-15g#21), and never rolls
// the phone change back. The job handed to the handler is the row the save really committed.
import { afterEach, expect, it, vi } from 'vitest';
import { createAppleUnbindRevocation } from '../../../../apps/api/src/modules/identity/application/apple-unbind-revocation.ts';
import { ENTRY_PLAN } from '../../../../apps/api/src/modules/platform/queue/catalog.ts';
import type { JobHandler } from '../../../../apps/api/src/modules/platform/queue/index.ts';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  ACTION,
  REASON,
  added,
  auditText,
  audits,
  edit,
  hmacOf,
  masked,
  noPlaintext,
  ok,
  row,
  testPhone,
} from '../admin-profile/kit.ts';
import { nestContext } from '../data-copies-worker/kit.ts';
import { ports } from '../deletion-processing/kit.ts';
import {
  APPLE_MAX_ATTEMPTS,
  TOKEN,
  account,
  alerts,
  appleDouble,
  bindings,
  deliver,
  expectCleared,
  onlyJob,
  providersOf,
  queued,
  scene,
  spellings,
  strings,
  world,
  type Scene,
} from './kit.ts';

const h = useHarness();
const ROOT = new URL('../../../../', import.meta.url);

afterEach(() => {
  vi.restoreAllMocks();
});

/** A flagged account whose Apple binding (with a stored token) is outside the snapshot. */
const untrustedApple = (s: Scene) =>
  account(s, { bound: ['apple', 'wechat'], trusted: ['wechat'], token: TOKEN });

/** The job's handler over a recording Apple double and logger. */
async function revocation(s: Scene, failures = 0) {
  const p = await ports();
  const apple = appleDouble(failures);
  const worker = createAppleUnbindRevocation({
    crypto: s.h.fields,
    apple: apple.revoker,
    logger: p.logger,
  });
  return { p, apple, worker };
}

it('[AC-B1-02zw#17] 解绑含 Apple：绑定行删除，同事务写一条作业：发送时带着改号事务，事务外还看不到作业和新号，提交后作业落库且由 worker 入口执行', async () => {
  const s = await scene(h);
  const target = await untrustedApple(s);
  const next = testPhone();
  const seen: { hmac?: string | null } = {};
  s.control.onSend = async () => {
    seen.hmac = (await row(h, target)).phone_hmac;
  };
  await ok(await edit(s, target.id, { phone: next, reason: REASON }));
  expect(await providersOf(s, target)).toEqual(['wechat']);
  await expectCleared(s, target);
  expect(s.sent).toHaveLength(1);
  expect(s.sent[0]).toMatchObject({ inTransaction: true, visibleOutside: false });
  expect(seen.hmac).toBe(target.hmac);
  expect((await row(h, target)).phone_hmac).toBe(hmacOf(h, next));
  const job = await onlyJob(s);
  expect(job).toMatchObject({ queue: s.sent[0]!.queue, name: s.sent[0]!.name });
  expect(ENTRY_PLAN.worker.map((work) => work.queue)).toContain(job.queue);
});

it('[AC-B1-02zw#18] 作业只带存储的密文：删行前取出的 apple_refresh_token_cipher 原样在载荷里，任何编码的明文都不在，手机号也不在', async () => {
  const s = await scene(h);
  const target = await untrustedApple(s);
  const apple = (await bindings(s, target)).find((binding) => binding.provider === 'apple');
  const cipher = apple?.apple_refresh_token_cipher;
  expect(cipher).toBeTruthy();
  const next = testPhone();
  await ok(await edit(s, target.id, { phone: next, reason: REASON }));
  const job = await onlyJob(s);
  const stored = spellings(cipher!);
  expect(
    strings(job.payload).some((value) => stored.includes(value)),
    '作业载荷里没有存储的密文',
  ).toBe(true);
  const text = JSON.stringify(job);
  for (const secret of spellings(Buffer.from(TOKEN, 'utf8'))) expect(text).not.toContain(secret);
  for (const phone of [target.phone!, next]) expect(text).not.toContain(phone);
});

it('[AC-B1-02zw#19] 提交后作业调 Apple 撤销：端口拿到解密后的 refresh token 与 appId，一次成功，不告警，改号不受影响', async () => {
  const s = await scene(h);
  const target = await untrustedApple(s);
  await ok(await edit(s, target.id, { phone: testPhone(), reason: REASON }));
  const job = await onlyJob(s);
  const { p, apple, worker } = await revocation(s);
  const before = await world(s);
  expect(await deliver(worker.handle, job)).toBe(1);
  expect(apple.calls).toEqual([{ appId: s.appId, refreshToken: TOKEN }]);
  expect(alerts(p, s.appId)).toEqual([]);
  expect(await world(s)).toEqual(before);
  expect(p.lines.join('')).not.toContain(TOKEN);
});

it('[AC-B1-02zw#20] 撤销连续失败：只重试到第 3 次，告警一条，不回滚改号：号码、绑定、标记、审计都不动，日志没有令牌和错误内容', async () => {
  const s = await scene(h);
  const target = await untrustedApple(s);
  const next = testPhone();
  await ok(await edit(s, target.id, { phone: next, reason: REASON }));
  const job = await onlyJob(s);
  const { p, apple, worker } = await revocation(s, Number.MAX_SAFE_INTEGER);
  const before = await world(s);
  await deliver(worker.handle, job);
  expect(apple.calls).toEqual(
    Array.from({ length: APPLE_MAX_ATTEMPTS }, () => ({ appId: s.appId, refreshToken: TOKEN })),
  );
  expect(alerts(p, s.appId)).toHaveLength(1);
  expect(await world(s)).toEqual(before);
  expect((await row(h, target)).phone_hmac).toBe(hmacOf(h, next));
  await expectCleared(s, target);
  expect(await providersOf(s, target)).toEqual(['wechat']);
  expect(p.lines.join('')).not.toContain(TOKEN);
  expect(p.lines.join('')).not.toContain('synthetic-apple-failure');
});

it('[AC-B1-02zw#21] 撤销失败一次后重试成功：调用两次、不告警', async () => {
  const s = await scene(h);
  const target = await untrustedApple(s);
  await ok(await edit(s, target.id, { phone: testPhone(), reason: REASON }));
  const job = await onlyJob(s);
  const { p, apple, worker } = await revocation(s, 1);
  expect(await deliver(worker.handle, job)).toBe(2);
  expect(apple.calls).toEqual(
    Array.from({ length: 2 }, () => ({ appId: s.appId, refreshToken: TOKEN })),
  );
  expect(alerts(p, s.appId)).toEqual([]);
});

it('[AC-B1-02zw#22] 解绑不含 Apple 身份：不写作业', async () => {
  const s = await scene(h);
  const target = await account(s, { bound: ['huawei', 'wechat'], trusted: ['wechat'] });
  await ok(await edit(s, target.id, { phone: testPhone(), reason: REASON }));
  expect(await providersOf(s, target)).toEqual(['wechat']);
  await expectCleared(s, target);
  expect(s.sent).toEqual([]);
  expect(await queued(s)).toEqual([]);
});

it('[AC-B1-02zw#23] Apple 身份在快照里：它留着，令牌密文不动，不写作业；被解绑的只有快照外的身份', async () => {
  const s = await scene(h);
  const target = await account(s, { bound: ['apple', 'huawei'], trusted: ['apple'], token: TOKEN });
  const apple = (await bindings(s, target)).filter((binding) => binding.provider === 'apple');
  await ok(await edit(s, target.id, { phone: testPhone(), reason: REASON }));
  expect(await bindings(s, target)).toEqual(apple);
  await expectCleared(s, target);
  expect(s.sent).toEqual([]);
  expect(await queued(s)).toEqual([]);
});

it('[AC-B1-02zw#24] 解绑的 Apple 身份没有存 refresh token：绑定照删、标记照清，无可撤销，不调 Apple 也不告警', async () => {
  const s = await scene(h);
  const target = await account(s, { bound: ['apple'] });
  await ok(await edit(s, target.id, { phone: testPhone(), reason: REASON }));
  expect(await providersOf(s, target)).toEqual([]);
  await expectCleared(s, target);
  const { p, apple, worker } = await revocation(s);
  for (const job of await queued(s)) await deliver(worker.handle, job);
  expect(apple.calls).toEqual([]);
  expect(alerts(p, s.appId)).toEqual([]);
});

it('[AC-B1-02zw#25] 审计照常：一条 user_profile_edit，带原因与脱敏号码，没有明文令牌；响应与日志也没有令牌和完整号码', async () => {
  const s = await scene(h);
  const target = await untrustedApple(s);
  const next = testPhone();
  const before = await audits(h, s.appId);
  const response = await edit(s, target.id, { phone: next, reason: REASON });
  await ok(response);
  expect(await providersOf(s, target)).toEqual(['wechat']);
  const rows = added(before, await audits(h, s.appId));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ app_id: s.appId, admin_id: s.actor.id, action: ACTION });
  const text = auditText(rows[0]!);
  expect(text).toContain(REASON);
  expect(text).toContain(masked(target.phone!));
  expect(text).toContain(masked(next));
  for (const secret of spellings(Buffer.from(TOKEN, 'utf8'))) expect(text).not.toContain(secret);
  noPlaintext(s, [target.phone, next], response);
  expect(s.lines.join('\n')).not.toContain(TOKEN);
});

interface WorkerModuleApi {
  IdentityWorkerModule: { forWorker(options: never): { module: unknown } };
}

it('[AC-B1-02zw#26] 装配：worker 入口在作业所在队列上注册的处理器真的处理这条作业：未配置的 Apple 实现按失败计，重试到第 3 次告警一条，不假装成功', async () => {
  const s = await scene(h);
  const target = await untrustedApple(s);
  await ok(await edit(s, target.id, { phone: testPhone(), reason: REASON }));
  const job = await onlyJob(s);

  const p = await ports();
  const api = (await import(
    new URL('apps/api/src/modules/identity/index.ts', ROOT).href
  )) as WorkerModuleApi;
  const { AppModule } = (await import(new URL('apps/api/src/app.module.ts', ROOT).href)) as {
    AppModule: { forEntry(options: object): unknown };
  };
  const config = p.platform.loadConfig({ APP_ENV: 'test' });
  const forWorker = vi
    .spyOn(api.IdentityWorkerModule, 'forWorker')
    .mockReturnValue({ module: api.IdentityWorkerModule });
  AppModule.forEntry({ entry: 'worker', config, clock: p.clock, logger: p.logger });
  expect(forWorker, 'app.module does not assemble IdentityWorkerModule').toHaveBeenCalledTimes(1);
  const options = forWorker.mock.calls[0]![0];
  forWorker.mockRestore();

  const registered: { queue: string; handler: JobHandler }[] = [];
  const queue = {
    register: vi.fn(
      (name: string, handler: JobHandler) => void registered.push({ queue: name, handler }),
    ),
    send: vi.fn(async () => 'job-id'),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
  const store = p.platform.createExportStore({
    appEnv: 'test',
    baseUrl: undefined,
    signingKey: undefined,
    clock: p.clock,
    logger: p.logger,
  });
  const context = await nestContext(api.IdentityWorkerModule.forWorker(options), [
    { provide: p.platform.CLOCK, useValue: p.clock },
    { provide: p.platform.ROOT_LOGGER, useValue: p.logger },
    { provide: p.platform.APP_CONFIG, useValue: config },
    { provide: p.platform.DB, useValue: h.db },
    { provide: p.platform.JOB_QUEUE, useValue: queue },
    { provide: p.platform.EXPORT_STORE, useValue: store },
    { provide: p.platform.FIELD_CRYPTO, useValue: h.fields },
  ]);
  try {
    const handlers = registered.filter((item) => item.queue === job.queue);
    expect(handlers, `no handler registered for queue ${job.queue}`).toHaveLength(1);
    expect(await deliver(handlers[0]!.handler, job)).toBeGreaterThanOrEqual(APPLE_MAX_ATTEMPTS);
    expect(alerts(p, s.appId)).toHaveLength(1);
    expect(p.lines.join('')).not.toContain(TOKEN);
  } finally {
    await context.close();
  }
}, 60_000);
