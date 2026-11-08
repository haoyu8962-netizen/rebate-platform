import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/config.ts';
import { openJdCredentials } from '../../../../apps/api/src/modules/platform/config/jd-startup.ts';
import * as archive from '../../../../apps/api/src/modules/union/infra/archive.ts';
import { JdUnionAdapter } from '../../../../apps/api/src/modules/union/infra/jd/jd-adapter.ts';
import {
  jdTimestamp,
  signJdParameters,
} from '../../../../apps/api/src/modules/union/infra/jd/sign.ts';
import * as pdd from '../../../../apps/api/src/modules/union/infra/pdd/pdd-adapter.ts';
import * as taobao from '../../../../apps/api/src/modules/union/infra/taobao/taobao-adapter.ts';
import {
  APP_KEY,
  JD_URL,
  OTHER_SECRET,
  PDD_CLIENT_ID,
  PDD_SECRET,
  PROD_AGENT_KEY,
  SECRET,
  TAOBAO_APP_KEY,
  TAOBAO_SECRET,
  clock,
  configured,
  context,
  endpoints,
  environment,
  logText,
  observeJd,
  removeDirectory,
  startUnion,
  startupFailure,
  temporaryDirectory,
  visible,
  type LogEntry,
} from './kit.ts';

// A prod endpoint set must be all live, and pdd's own prod refusal would then decide a module-level
// test before jd is ever looked at: these tests hand the factory pdd and taobao as replay, which
// only the registry refuses, after every credential has been opened.
const METHOD = 'jd.union.open.wiring.probe';
const KEYS = { envelope: 'jd_union_open_wiring_probe_responce', resultKey: 'queryResult' };
const PARAMS = { q: 'synthetic', pageSize: 2 };

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

/** The gateway's success shape for the probe: outer code 0, the inner result as JSON text. */
function probeReply(inner = '{"code":200,"message":"success","probe":"synthetic"}'): string {
  return JSON.stringify({ [KEYS.envelope]: { code: '0', [KEYS.resultKey]: inner } });
}

/** A fetch stand-in answering `body` once per call. */
function answering(body: string = probeReply()) {
  const network = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response(body, { status: 200 }));
  vi.stubGlobal('fetch', network);
  return network;
}

async function writeSecret(name = 'FAKE_JD_SECRET_FILE.txt', content = SECRET) {
  const file = join(directory, name);
  await fs.writeFile(file, content, 'utf8');
  return file;
}

it.each(['local', 'test'] as const)(
  '[AC-B1-04ze#13] %s 的 jd/live 在模块工厂拒绝启动，不构造适配器、不联网',
  async (appEnv) => {
    const observed = observeJd();
    const error = await startupFailure(() =>
      startUnion(loadConfig(environment(appEnv)), endpoints()),
    );
    expect(error).toMatchObject({ code: 'live_in_local' });
    expect(observed.constructor).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  },
);

it('[AC-B1-04ze#14] prod 的 jd/live 在模块工厂拒绝启动（等待 KMS），不看有没有配置', async () => {
  const observed = observeJd();
  const config = loadConfig({ ...environment('prod'), ...PROD_AGENT_KEY });
  const error = await startupFailure(() => startUnion(config, endpoints()));
  expect(error).toMatchObject({ code: 'kms_unavailable' });
  expect(observed.constructor).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  ['local', 'live_in_local'],
  ['test', 'live_in_local'],
  ['prod', 'kms_unavailable'],
] as const)(
  '[AC-B1-04ze#15] %s 即使直接注入 staging 配置与可读文件，也不得绕过 live 禁令',
  async (appEnv, code) => {
    const file = await writeSecret('FAKE_BYPASS_SECRET.txt');
    const observed = observeJd();
    const readFile = vi.spyOn(fs, 'readFile');
    const open = vi.spyOn(fs, 'open');
    const config = { ...configured(file), appEnv };
    const error = await startupFailure(() => startUnion(config, endpoints()));
    expect(error).toMatchObject({ code });
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
  '[AC-B1-04ze#16] %s 下京东凭据开启直接拒绝（prod 等待 KMS），不读文件、错误不带值',
  async (appEnv, code) => {
    const file = await writeSecret('FAKE_JD_REFUSED_SECRET.txt');
    const readFile = vi.spyOn(fs, 'readFile');
    const open = vi.spyOn(fs, 'open');
    const error = await startupFailure(() =>
      openJdCredentials(appEnv, { appKey: APP_KEY, secretFile: file }),
    );
    expect(error).toMatchObject({ code });
    expect(error.cause).toBeUndefined();
    for (const marker of [file, directory, APP_KEY, SECRET]) {
      expect(visible(error)).not.toContain(marker);
    }
    expect(readsOf(file, readFile, open)).toBe(0);
  },
);

it.each([
  null,
  undefined,
  { appKey: '', secretFile: '' },
  { appKey: APP_KEY, secretFile: '' },
  { appKey: '', secretFile: 'FAKE_JD_PATH.txt' },
])('[AC-B1-04ze#17] staging 开启凭据时缺 app key 或文件路径即拒绝：%j', async (jd) => {
  const error = await startupFailure(() => openJdCredentials('staging', jd));
  expect(error).toMatchObject({ code: 'credentials_missing' });
  expect(error.cause).toBeUndefined();
  expect(visible(error)).not.toContain(APP_KEY);
  expect(visible(error)).not.toContain('FAKE_JD_PATH.txt');
});

it('[AC-B1-04ze#18] staging 的 jd/live 配置里凭据不全时启动失败，不延迟到第一次请求', async () => {
  const observed = observeJd();
  const config = {
    ...loadConfig(environment('staging')),
    jd: { appKey: APP_KEY, secretFile: '' },
  };
  const error = await startupFailure(() => startUnion(config, endpoints()));
  expect(error).toMatchObject({ code: 'credentials_missing' });
  expect(visible(error)).not.toContain(APP_KEY);
  expect(observed.constructor).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it('[AC-B1-04ze#19] staging 两个变量都没设时 jd/live 保持未实现、不告警，配上变量才装配', async () => {
  // The frozen taobao / pdd wiring tests start staging with jd live and neither jd variable, assert
  // jd stays unimplemented and count the warnings exactly; same as taobao without its variables.
  const observed = observeJd();
  const logs: LogEntry[] = [];
  const dormant = await startUnion(loadConfig(environment('staging')), endpoints(), logs);
  expect(observed.constructor).not.toHaveBeenCalled();
  expect(dormant.registrations().find((entry) => entry.platform === 'jd')?.implemented).toBe(false);
  await expect(
    dormant.get('jd').searchItems({ keyword: 'synthetic' }, context),
  ).rejects.toMatchObject({ code: 'adapter_unimplemented' });
  expect(logs).toEqual([]);
  const live = await startUnion(configured(await writeSecret()), endpoints());
  expect(live.registrations().find((entry) => entry.platform === 'jd')?.implemented).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['', '\n', '\r\n', 'missing', 'directory'])(
  '[AC-B1-04ze#20] 密钥文件为空/仅换行/不存在/无法读取时启动失败，错误不含路径或内容：%j',
  async (content) => {
    const observed = observeJd();
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

it('[AC-B1-04ze#21] 读文件的原始异常（含路径与假 secret）不能透传到启动错误或日志', async () => {
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
  '[AC-B1-04ze#22] staging 启动时读一次并去末尾换行 %j，之后改文件或删文件仍用原凭据且不泄漏',
  async (suffix) => {
    const file = await writeSecret('FAKE_JD_SECRET_FILE.txt', `${SECRET}${suffix}`);
    const observed = observeJd();
    const readFile = vi.spyOn(fs, 'readFile');
    const open = vi.spyOn(fs, 'open');
    const config = configured(file);
    expect(readsOf(file, readFile, open)).toBe(0);
    const logs: LogEntry[] = [];
    // The module must use the passed config, not the ambient process environment.
    vi.stubEnv('JD_APP_KEY', 'fake-ambient-app-key');
    vi.stubEnv('JD_APP_SECRET_FILE', join(directory, 'FAKE_AMBIENT_MISSING.txt'));
    const registry = await startUnion(config, endpoints(), logs);
    expect(observed.constructor).toHaveBeenCalledTimes(1);
    expect(registry.registrations().find((entry) => entry.platform === 'jd')?.implemented).toBe(
      true,
    );
    const supplied = observed.constructor.mock.calls[0]![0];
    expect(supplied.clock).toBe(clock);
    expect(supplied.endpoint).toEqual(endpoints().find((entry) => entry.platform === 'jd'));
    // Change before the FIRST credentials() call: lazy opening must not pass this assertion.
    await fs.writeFile(file, OTHER_SECRET, 'utf8');
    await expect(supplied.credentials()).resolves.toEqual({ appKey: APP_KEY, appSecret: SECRET });
    await fs.rm(file);
    await expect(supplied.credentials()).resolves.toEqual({ appKey: APP_KEY, appSecret: SECRET });
    expect(registry.get('jd')).toBe(observed.constructor.mock.results[0]!.value);
    expect(JSON.stringify(config)).not.toContain(SECRET);
    expect(JSON.stringify(registry)).not.toContain(SECRET);
    expect(logText(logs)).not.toContain(SECRET);
    expect(logText(logs)).not.toContain(file);
    expect(logText(logs)).not.toContain(APP_KEY);
    expect(readsOf(file, readFile, open)).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  },
);

it('[AC-B1-04ze#23] 工厂向 B1-04za 注入现有 HTTPS 传输：禁止降级与跳转', async () => {
  const file = await writeSecret();
  const observed = observeJd();
  await startUnion(configured(file), endpoints());
  expect(observed.constructor).toHaveBeenCalledTimes(1);
  const transport = observed.constructor.mock.calls[0]![0].transport;
  const network = vi
    .fn()
    .mockResolvedValue(new Response('synthetic transport body', { status: 200 }));
  vi.stubGlobal('fetch', network);
  const signal = new AbortController().signal;
  const request = {
    platform: 'jd' as const,
    url: JD_URL,
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
    transport({ ...request, url: 'http://jd.invalid/routerjson' }),
  ).rejects.toMatchObject({ code: 'invalid_endpoint' });
  expect(network).toHaveBeenCalledTimes(1);
});

it.each(['replay', 'demo'] as const)(
  '[AC-B1-04ze#24] staging 的 jd=%s 不读取或装配真实凭据，同一配置切 live 才装配',
  async (mode) => {
    const file = join(directory, 'FAKE_JD_SECRET_FILE.txt');
    const observed = observeJd();
    const config = configured(file);
    // No file exists yet: replay / demo must not even attempt to open it.
    const dormant = await startUnion(config, endpoints(mode));
    expect(observed.constructor).not.toHaveBeenCalled();
    if (mode === 'replay') {
      await expect(
        dormant.get('jd').searchItems({ keyword: '演示' }, context),
      ).rejects.toMatchObject({ code: 'adapter_unimplemented' });
    } else {
      const page = await dormant.get('jd').searchItems({ keyword: '演示' }, context);
      expect(page.items.length).toBeGreaterThan(0);
    }
    await fs.writeFile(file, SECRET, 'utf8');
    const live = await startUnion(config, endpoints());
    expect(live.registrations().find((entry) => entry.platform === 'jd')?.implemented).toBe(true);
    expect(observed.constructor).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  },
);

it('[AC-B1-04ze#25] 有数据库时京东 live 的 HTTPS 传输外包原始报文归档，摘要去掉 app_key 与 sign；无数据库直通', async () => {
  const file = await writeSecret();
  const archived: { platform: string; db: unknown; summary: Record<string, unknown> }[] = [];
  vi.spyOn(archive, 'createArchivingTransport').mockImplementation(
    (inner, deps) => async (request) => {
      archived.push({
        platform: request.platform,
        db: deps.db,
        summary: archive.requestSummary(request),
      });
      return inner(request);
    },
  );
  const network = answering();
  const fakeDb = { fake: 'jd-wiring-database' };
  const withDb = (await startUnion(configured(file), endpoints(), [], fakeDb)).get('jd');
  expect(withDb).toBeInstanceOf(JdUnionAdapter);
  await expect(
    (withDb as JdUnionAdapter).request(METHOD, PARAMS, {
      ...KEYS,
      archive: { appId: context.appId, kind: 'query' },
    }),
  ).resolves.toMatchObject({ probe: 'synthetic' });
  expect(archived).toHaveLength(1);
  expect(archived[0]!.platform).toBe('jd');
  expect(archived[0]!.db).toBe(fakeDb);
  const parameters = archived[0]!.summary['params'];
  expect(parameters).toMatchObject({ method: METHOD });
  expect(parameters).not.toHaveProperty('app_key');
  expect(parameters).not.toHaveProperty('sign');
  expect(JSON.stringify(archived)).not.toContain(APP_KEY);
  expect(JSON.stringify(archived)).not.toContain(SECRET);
  expect(network).toHaveBeenCalledTimes(1);
  expect(String(network.mock.calls[0]![0])).toBe(JD_URL);

  const withoutDb = (await startUnion(configured(file), endpoints())).get('jd');
  expect(withoutDb).toBeInstanceOf(JdUnionAdapter);
  await (withoutDb as JdUnionAdapter).request(METHOD, {}, KEYS);
  expect(archived).toHaveLength(1);
  expect(network).toHaveBeenCalledTimes(2);
});

it.each([
  [
    '网关 code 28',
    JSON.stringify({
      error_response: {
        code: 28,
        zh_desc: 'FAKE_UPSTREAM_MESSAGE_TEXT',
        en_desc: 'FAKE_UPSTREAM_SUB_MESSAGE_TEXT',
        request_id: 'FAKE_UPSTREAM_REQUEST_ID',
      },
    }),
    '28',
  ],
])(
  '[AC-B1-04ze#26] 京东 warn 事件（%s）写一条 warn 日志，只带方法名与 code',
  async (_label, body, code) => {
    const file = await writeSecret();
    const logs: LogEntry[] = [];
    const registry = await startUnion(configured(file), endpoints(), logs);
    const adapter = registry.get('jd');
    expect(adapter).toBeInstanceOf(JdUnionAdapter);
    answering(body);
    const before = logs.length;
    await expect(
      (adapter as JdUnionAdapter).request(METHOD, { q: 'FAKE_QUERY_TEXT' }, KEYS),
    ).rejects.toMatchObject({ code: 'upstream_rejected' });
    const added = logs.slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]!.level).toBe('warn');
    expect(added[0]!.text).toContain(METHOD);
    expect(added[0]!.text).toContain(code);
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
  },
);

it('[AC-B1-04ze#27] staging 下 pdd、taobao 与 jd 同时 live 时各自装配，凭据与传输互不串用', async () => {
  const jdFile = await writeSecret('FAKE_JD_ALL_SECRET.txt', `${SECRET}\n`);
  const pddFile = await writeSecret('FAKE_PDD_ALL_SECRET.txt', PDD_SECRET);
  const taobaoFile = await writeSecret('FAKE_TAOBAO_ALL_SECRET.txt', TAOBAO_SECRET);
  const observed = observeJd();
  const PddOriginal = pdd.PddUnionAdapter;
  const pddConstructor = vi
    .spyOn(pdd, 'PddUnionAdapter')
    .mockImplementation(class extends PddOriginal {});
  const TaobaoOriginal = taobao.TaobaoUnionAdapter;
  const taobaoConstructor = vi
    .spyOn(taobao, 'TaobaoUnionAdapter')
    .mockImplementation(class extends TaobaoOriginal {});
  const config = configured(jdFile, {
    PDD_CLIENT_ID,
    PDD_CLIENT_SECRET_FILE: pddFile,
    TAOBAO_APP_KEY,
    TAOBAO_APP_SECRET_FILE: taobaoFile,
  });
  const logs: LogEntry[] = [];
  const registry = await startUnion(config, endpoints('live', 'live'), logs);
  expect(registry.registrations()).toEqual([
    { platform: 'jd', implemented: true },
    { platform: 'pdd', implemented: true },
    { platform: 'taobao', implemented: true },
  ]);
  expect(observed.constructor).toHaveBeenCalledTimes(1);
  expect(pddConstructor).toHaveBeenCalledTimes(1);
  expect(taobaoConstructor).toHaveBeenCalledTimes(1);
  const jdSupplied = observed.constructor.mock.calls[0]![0];
  const pddSupplied = pddConstructor.mock.calls[0]![0];
  const taobaoSupplied = taobaoConstructor.mock.calls[0]![0];
  await expect(jdSupplied.credentials()).resolves.toEqual({ appKey: APP_KEY, appSecret: SECRET });
  await expect(pddSupplied.credentials()).resolves.toEqual({
    clientId: PDD_CLIENT_ID,
    clientSecret: PDD_SECRET,
  });
  await expect(taobaoSupplied.credentials()).resolves.toEqual({
    appKey: TAOBAO_APP_KEY,
    appSecret: TAOBAO_SECRET,
  });
  expect(jdSupplied.transport).not.toBe(pddSupplied.transport);
  expect(jdSupplied.transport).not.toBe(taobaoSupplied.transport);
  expect(registry.get('jd')).toBe(observed.constructor.mock.results[0]!.value);
  expect(registry.get('pdd')).toBe(pddConstructor.mock.results[0]!.value);
  expect(registry.get('taobao')).toBe(taobaoConstructor.mock.results[0]!.value);
  for (const marker of [SECRET, PDD_SECRET, TAOBAO_SECRET]) {
    expect(JSON.stringify(config)).not.toContain(marker);
    expect(logText(logs)).not.toContain(marker);
  }
  expect(fetch).not.toHaveBeenCalled();
});

it('[AC-B1-04ze#28] 端到端：经注册表拿到的京东适配器发往端点 baseUrl，app_key 取变量值，sign 按 B1-04za 规则，请求不含 secret', async () => {
  const file = await writeSecret('FAKE_JD_E2E_SECRET.txt', `${SECRET}\n`);
  const network = answering();
  const registry = await startUnion(configured(file), endpoints());
  const adapter = registry.get('jd');
  expect(adapter).toBeInstanceOf(JdUnionAdapter);
  await expect((adapter as JdUnionAdapter).request(METHOD, PARAMS, KEYS)).resolves.toMatchObject({
    probe: 'synthetic',
  });
  expect(network).toHaveBeenCalledTimes(1);
  const [url, init] = network.mock.calls[0]!;
  expect(String(url)).toBe(JD_URL);
  expect(init?.method).toBe('POST');
  const body = String(init?.body);
  const form = new URLSearchParams(body);
  expect(form.get('method')).toBe(METHOD);
  expect(form.get('app_key')).toBe(APP_KEY);
  expect(form.get('timestamp')).toBe(jdTimestamp(clock.now()));
  expect(form.get('sign_method')).toBe('md5');
  const unsigned = Object.fromEntries([...form].filter(([name]) => name !== 'sign'));
  expect(form.get('sign')).toBe(signJdParameters(unsigned, SECRET));
  for (const part of [String(url), body, JSON.stringify(init?.headers ?? {})]) {
    expect(part).not.toContain(SECRET);
  }
});
