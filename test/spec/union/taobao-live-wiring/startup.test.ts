import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/config.ts';
import { openTaobaoCredentials } from '../../../../apps/api/src/modules/platform/config/taobao-startup.ts';
import * as archive from '../../../../apps/api/src/modules/union/infra/archive.ts';
import * as pdd from '../../../../apps/api/src/modules/union/infra/pdd/pdd-adapter.ts';
import {
  signTaobaoParameters,
  taobaoTimestamp,
} from '../../../../apps/api/src/modules/union/infra/taobao/sign.ts';
import { TaobaoUnionAdapter } from '../../../../apps/api/src/modules/union/infra/taobao/taobao-adapter.ts';
import {
  APP_KEY,
  OTHER_SECRET,
  PDD_CLIENT_ID,
  PDD_SECRET,
  SECRET,
  TAOBAO_URL,
  clock,
  configured,
  context,
  endpoints,
  environment,
  logText,
  observeTaobao,
  removeDirectory,
  startUnion,
  startupFailure,
  temporaryDirectory,
  visible,
  type LogEntry,
} from './kit.ts';

// prod is covered at the credential-opening level (#9): a prod endpoint set must be all live, and
// pdd's own prod refusal would then decide a module-level test before taobao is ever looked at.
const METHOD = 'taobao.tbk.wiring.probe';
const ENVELOPE = 'tbk_wiring_probe_response';

// Give spies a mutable module surface; native ESM namespace properties are not configurable.
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return { ...real };
});

let directory: string;
beforeEach(async () => {
  directory = await temporaryDirectory();
  // Even a broken implementation must not contact a real network from these tests.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('FAKE_NETWORK_MUST_BE_STUBBED')));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await removeDirectory(directory);
});

/** Times `file` was opened through either readFile or open (both are valid ways to read it). */
function readsOf(
  file: string,
  readFile: { mock: { calls: readonly (readonly unknown[])[] } },
  open: { mock: { calls: readonly (readonly unknown[])[] } },
): number {
  return (
    readFile.mock.calls.filter(([path]) => String(path) === file).length +
    open.mock.calls.filter(([path]) => String(path) === file).length
  );
}

/** A fetch stand-in answering the probe envelope (or `body`) once per call. */
function answering(body: unknown = { [ENVELOPE]: { result: 'synthetic' } }) {
  const network = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal('fetch', network);
  return network;
}

async function writeSecret(name = 'FAKE_TAOBAO_SECRET_FILE.txt', content = SECRET) {
  const file = join(directory, name);
  await fs.writeFile(file, content, 'utf8');
  return file;
}

it.each(['local', 'test'] as const)(
  '[AC-B1-04k#8] %s 的 taobao/live 在模块工厂拒绝启动，不构造适配器、不联网',
  async (appEnv) => {
    const observed = observeTaobao();
    const error = await startupFailure(() =>
      startUnion(loadConfig(environment(appEnv)), endpoints()),
    );
    expect(error.message.length).toBeGreaterThan(0);
    expect(observed.constructor).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  },
);

it.each(['local', 'test'] as const)(
  '[AC-B1-04k#8] %s 即使直接注入 staging 配置与可读文件，也不得绕过 live 禁令',
  async (appEnv) => {
    const file = await writeSecret('FAKE_BYPASS_SECRET.txt');
    const observed = observeTaobao();
    const readFile = vi.spyOn(fs, 'readFile');
    const open = vi.spyOn(fs, 'open');
    const config = { ...configured(file), appEnv };
    await startupFailure(() => startUnion(config, endpoints()));
    expect(observed.constructor).not.toHaveBeenCalled();
    expect(readsOf(file, readFile, open)).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  },
);

it.each([
  ['local', 'live_in_local'],
  ['test', 'live_in_local'],
  ['prod', 'kms_unavailable'],
] as const)(
  '[AC-B1-04k#9] %s 下淘宝凭据开启直接拒绝（prod 等待 KMS），不读文件、错误不带值',
  async (appEnv, code) => {
    const file = await writeSecret('FAKE_TAOBAO_REFUSED_SECRET.txt');
    const readFile = vi.spyOn(fs, 'readFile');
    const open = vi.spyOn(fs, 'open');
    const error = await startupFailure(() =>
      openTaobaoCredentials(appEnv, { appKey: APP_KEY, secretFile: file }),
    );
    expect(error).toMatchObject({ code });
    expect(error.cause).toBeUndefined();
    for (const marker of [file, directory, APP_KEY, SECRET]) {
      expect(visible(error)).not.toContain(marker);
    }
    expect(readsOf(file, readFile, open)).toBe(0);
  },
);

it.each(['', '\n', '\r\n', 'missing', 'directory'])(
  '[AC-B1-04k#10] 密钥文件为空/仅换行/不存在/无法读取时启动失败，错误不含路径或内容：%j',
  async (content) => {
    const observed = observeTaobao();
    const errors: Error[] = [];
    const logs: LogEntry[] = [];
    for (const label of ['FAKE_PATH_A', 'FAKE_PATH_B']) {
      const file = join(directory, `${label}-${APP_KEY}.txt`);
      if (content === 'directory') await fs.mkdir(file);
      else if (content !== 'missing') await fs.writeFile(file, content, 'utf8');
      const error = await startupFailure(() => startUnion(configured(file), endpoints(), logs));
      expect(visible(error)).not.toContain(file);
      expect(visible(error)).not.toContain(directory);
      expect(visible(error)).not.toContain(label);
      expect(visible(error)).not.toContain(APP_KEY);
      expect(error.cause).toBeUndefined();
      errors.push(error);
    }
    expect(errors[0]!.message).toBe(errors[1]!.message);
    expect(logText(logs)).not.toContain(directory);
    expect(logText(logs)).not.toContain(APP_KEY);
    expect(observed.constructor).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  },
);

it('[AC-B1-04k#11] 读文件的原始异常（含路径与假 secret）不能透传到启动错误或日志', async () => {
  const file = join(directory, 'FAKE_PERMISSION_DENIED.txt');
  const config = configured(file);
  const originalOpen = fs.open;
  const originalReadFile = fs.readFile;
  const unsafe = Object.assign(new Error(`permission denied ${file} ${SECRET}`), {
    code: 'EACCES',
    path: file,
  });
  // Deterministic even when the verification container runs as root; chmod(000) is not reliable.
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    if (String(args[0]) === file) throw unsafe;
    return originalOpen(...args);
  });
  vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
    if (String(args[0]) === file) throw unsafe;
    return originalReadFile(...args);
  });
  const logs: LogEntry[] = [];
  const error = await startupFailure(() => startUnion(config, endpoints(), logs));
  expect(error).not.toBe(unsafe);
  expect(error.cause).toBeUndefined();
  for (const marker of [file, directory, SECRET]) {
    expect(visible(error)).not.toContain(marker);
    expect(logText(logs)).not.toContain(marker);
  }
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['', '\n', '\r\n'])(
  '[AC-B1-04k#12] staging 启动时读一次并去末尾换行 %j，之后改文件或删文件仍用原凭据且不泄漏',
  async (suffix) => {
    const file = await writeSecret('FAKE_TAOBAO_SECRET_FILE.txt', `${SECRET}${suffix}`);
    const observed = observeTaobao();
    const readFile = vi.spyOn(fs, 'readFile');
    const open = vi.spyOn(fs, 'open');
    const config = configured(file);
    expect(readsOf(file, readFile, open)).toBe(0);
    const logs: LogEntry[] = [];
    // The module must use the passed config, not the ambient process environment.
    vi.stubEnv('TAOBAO_APP_KEY', 'fake-ambient-app-key');
    vi.stubEnv('TAOBAO_APP_SECRET_FILE', join(directory, 'FAKE_AMBIENT_MISSING.txt'));
    const registry = await startUnion(config, endpoints(), logs);
    expect(observed.constructor).toHaveBeenCalledTimes(1);
    expect(registry.registrations().find((entry) => entry.platform === 'taobao')?.implemented).toBe(
      true,
    );
    const supplied = observed.constructor.mock.calls[0]![0];
    expect(supplied.clock).toBe(clock);
    expect(supplied.endpoint).toEqual(endpoints().find((entry) => entry.platform === 'taobao'));
    // Change before the FIRST credentials() call: lazy opening must not pass this assertion.
    await fs.writeFile(file, OTHER_SECRET, 'utf8');
    await expect(supplied.credentials()).resolves.toEqual({ appKey: APP_KEY, appSecret: SECRET });
    await fs.rm(file);
    await expect(supplied.credentials()).resolves.toEqual({ appKey: APP_KEY, appSecret: SECRET });
    expect(registry.get('taobao')).toBe(observed.constructor.mock.results[0]!.value);
    expect(JSON.stringify(config)).not.toContain(SECRET);
    expect(JSON.stringify(registry)).not.toContain(SECRET);
    expect(logText(logs)).not.toContain(SECRET);
    expect(logText(logs)).not.toContain(file);
    expect(readsOf(file, readFile, open)).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  },
);

it('[AC-B1-04k#13] 工厂向 B1-04j 注入现有 HTTPS 传输：禁止降级与跳转', async () => {
  const file = await writeSecret();
  const observed = observeTaobao();
  await startUnion(configured(file), endpoints());
  expect(observed.constructor).toHaveBeenCalledTimes(1);
  const transport = observed.constructor.mock.calls[0]![0].transport;
  const network = vi
    .fn()
    .mockResolvedValue(new Response('synthetic transport body', { status: 200 }));
  vi.stubGlobal('fetch', network);
  const signal = new AbortController().signal;
  const request = {
    platform: 'taobao' as const,
    url: TAOBAO_URL,
    method: 'POST' as const,
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: 'synthetic=transport',
    signal,
  };
  await expect(transport(request)).resolves.toMatchObject({
    status: 200,
    body: 'synthetic transport body',
  });
  expect(network).toHaveBeenCalledExactlyOnceWith(
    request.url,
    expect.objectContaining({
      method: 'POST',
      headers: request.headers,
      body: request.body,
      signal,
      redirect: 'error',
    }),
  );
  await expect(
    transport({ ...request, url: 'http://taobao.invalid/router/rest' }),
  ).rejects.toMatchObject({ code: 'invalid_endpoint' });
  expect(network).toHaveBeenCalledTimes(1);
});

it.each(['replay', 'demo'] as const)(
  '[AC-B1-04k#14] staging 的 taobao=%s 不读取或装配真实凭据，同一配置切 live 才装配',
  async (mode) => {
    const file = join(directory, 'FAKE_TAOBAO_SECRET_FILE.txt');
    const observed = observeTaobao();
    const config = configured(file);
    // No file exists yet: replay / demo must not even attempt to open it.
    const dormant = await startUnion(config, endpoints(mode));
    expect(observed.constructor).not.toHaveBeenCalled();
    if (mode === 'replay') {
      await expect(
        dormant.get('taobao').searchItems({ keyword: '演示' }, context),
      ).rejects.toMatchObject({ code: 'adapter_unimplemented' });
    } else {
      const page = await dormant.get('taobao').searchItems({ keyword: '演示' }, context);
      expect(page.items.length).toBeGreaterThan(0);
    }
    await fs.writeFile(file, SECRET, 'utf8');
    const live = await startUnion(config, endpoints());
    expect(live.registrations().find((entry) => entry.platform === 'taobao')?.implemented).toBe(
      true,
    );
    expect(observed.constructor).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  },
);

it('[AC-B1-04k#15] 有数据库时淘宝 live 的 HTTPS 传输外包 B1-04p 原始报文归档；无数据库直通', async () => {
  const file = await writeSecret();
  const archived: { platform: string; db: unknown }[] = [];
  vi.spyOn(archive, 'createArchivingTransport').mockImplementation(
    (inner, deps) => async (request) => {
      archived.push({ platform: request.platform, db: deps.db });
      return inner(request);
    },
  );
  const network = answering();
  const fakeDb = { fake: 'taobao-wiring-database' };
  const withDb = (await startUnion(configured(file), endpoints(), [], fakeDb)).get('taobao');
  expect(withDb).toBeInstanceOf(TaobaoUnionAdapter);
  await expect(
    (withDb as TaobaoUnionAdapter).request(
      METHOD,
      { q: 'synthetic' },
      { envelope: ENVELOPE, archive: { appId: context.appId, kind: 'query' } },
    ),
  ).resolves.toEqual({ result: 'synthetic' });
  expect(archived).toHaveLength(1);
  expect(archived[0]!.platform).toBe('taobao');
  expect(archived[0]!.db).toBe(fakeDb);
  expect(network).toHaveBeenCalledTimes(1);
  expect(String(network.mock.calls[0]![0])).toBe(TAOBAO_URL);

  const withoutDb = (await startUnion(configured(file), endpoints())).get('taobao');
  expect(withoutDb).toBeInstanceOf(TaobaoUnionAdapter);
  await (withoutDb as TaobaoUnionAdapter).request(METHOD, {}, { envelope: ENVELOPE });
  expect(archived).toHaveLength(1);
  expect(network).toHaveBeenCalledTimes(2);
});

it('[AC-B1-04k#16] 淘宝 warn 事件写一条 warn 日志，只带方法名与 code / sub_code', async () => {
  const file = await writeSecret();
  const logs: LogEntry[] = [];
  const registry = await startUnion(configured(file), endpoints(), logs);
  const adapter = registry.get('taobao');
  expect(adapter).toBeInstanceOf(TaobaoUnionAdapter);
  answering({
    error_response: {
      code: 11,
      msg: 'FAKE_UPSTREAM_MESSAGE_TEXT',
      sub_code: 'isv.permission-api-package-limit',
      sub_msg: 'FAKE_UPSTREAM_SUB_MESSAGE_TEXT',
      request_id: 'FAKE_UPSTREAM_REQUEST_ID',
    },
  });
  const before = logs.length;
  await expect(
    (adapter as TaobaoUnionAdapter).request(
      METHOD,
      { q: 'FAKE_QUERY_TEXT' },
      { envelope: ENVELOPE },
    ),
  ).rejects.toMatchObject({ code: 'upstream_misconfigured' });
  const added = logs.slice(before);
  expect(added).toHaveLength(1);
  expect(added[0]!.level).toBe('warn');
  expect(added[0]!.text).toContain(METHOD);
  expect(added[0]!.text).toContain('11');
  expect(added[0]!.text).toContain('isv.permission-api-package-limit');
  for (const marker of [
    'FAKE_UPSTREAM_MESSAGE_TEXT',
    'FAKE_UPSTREAM_SUB_MESSAGE_TEXT',
    'FAKE_UPSTREAM_REQUEST_ID',
    'FAKE_QUERY_TEXT',
    APP_KEY,
    SECRET,
  ]) {
    expect(logText(logs)).not.toContain(marker);
  }
});

it('[AC-B1-04k#17] staging 下 pdd 与 taobao 同时 live 时各自装配、凭据互不串用', async () => {
  const taobaoFile = await writeSecret('FAKE_TAOBAO_BOTH_SECRET.txt', `${SECRET}\n`);
  const pddFile = await writeSecret('FAKE_PDD_BOTH_SECRET.txt', PDD_SECRET);
  const taobaoObserved = observeTaobao();
  const PddOriginal = pdd.PddUnionAdapter;
  const pddConstructor = vi
    .spyOn(pdd, 'PddUnionAdapter')
    .mockImplementation(class extends PddOriginal {});
  const config = configured(taobaoFile, {
    PDD_CLIENT_ID: PDD_CLIENT_ID,
    PDD_CLIENT_SECRET_FILE: pddFile,
  });
  const logs: LogEntry[] = [];
  const registry = await startUnion(config, endpoints('live', 'live'), logs);
  expect(registry.registrations()).toEqual([
    { platform: 'jd', implemented: false },
    { platform: 'pdd', implemented: true },
    { platform: 'taobao', implemented: true },
  ]);
  expect(taobaoObserved.constructor).toHaveBeenCalledTimes(1);
  expect(pddConstructor).toHaveBeenCalledTimes(1);
  const taobaoSupplied = taobaoObserved.constructor.mock.calls[0]![0];
  const pddSupplied = pddConstructor.mock.calls[0]![0];
  await expect(taobaoSupplied.credentials()).resolves.toEqual({
    appKey: APP_KEY,
    appSecret: SECRET,
  });
  await expect(pddSupplied.credentials()).resolves.toEqual({
    clientId: PDD_CLIENT_ID,
    clientSecret: PDD_SECRET,
  });
  expect(registry.get('taobao')).toBe(taobaoObserved.constructor.mock.results[0]!.value);
  expect(registry.get('pdd')).toBe(pddConstructor.mock.results[0]!.value);
  await expect(
    registry.get('jd').searchItems({ keyword: 'synthetic' }, context),
  ).rejects.toMatchObject({ code: 'adapter_unimplemented' });
  for (const marker of [SECRET, PDD_SECRET]) {
    expect(JSON.stringify(config)).not.toContain(marker);
    expect(logText(logs)).not.toContain(marker);
  }
  expect(fetch).not.toHaveBeenCalled();
});

it('[AC-B1-04k#18] 端到端：经注册表拿到的淘宝适配器发往端点 baseUrl，app_key 取变量值，sign 按 B1-04j 规则，请求不含 secret', async () => {
  const file = await writeSecret('FAKE_TAOBAO_E2E_SECRET.txt', `${SECRET}\n`);
  const network = answering();
  const registry = await startUnion(configured(file), endpoints());
  const adapter = registry.get('taobao');
  expect(adapter).toBeInstanceOf(TaobaoUnionAdapter);
  await expect(
    (adapter as TaobaoUnionAdapter).request(
      METHOD,
      { q: 'synthetic', page_size: 2 },
      { envelope: ENVELOPE },
    ),
  ).resolves.toEqual({ result: 'synthetic' });
  expect(network).toHaveBeenCalledTimes(1);
  const [url, init] = network.mock.calls[0]!;
  expect(String(url)).toBe(TAOBAO_URL);
  expect(init?.method).toBe('POST');
  const body = String(init?.body);
  const form = new URLSearchParams(body);
  expect(form.get('app_key')).toBe(APP_KEY);
  expect(form.get('method')).toBe(METHOD);
  expect(form.get('timestamp')).toBe(taobaoTimestamp(clock.now()));
  expect(form.get('sign_method')).toBe('md5');
  const unsigned = Object.fromEntries([...form].filter(([name]) => name !== 'sign'));
  expect(form.get('sign')).toBe(signTaobaoParameters(unsigned, SECRET));
  for (const part of [String(url), body, JSON.stringify(init?.headers ?? {})]) {
    expect(part).not.toContain(SECRET);
  }
});
