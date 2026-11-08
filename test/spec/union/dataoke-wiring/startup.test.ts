import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../../apps/api/src/modules/platform/config/config.ts';
import { openDataokeCredentials } from '../../../../apps/api/src/modules/platform/config/dataoke-startup.ts';
import type { DataokeClient } from '../../../../apps/api/src/modules/union/infra/dataoke/dataoke-client.ts';
import * as archive from '../../../../apps/api/src/modules/union/infra/archive.ts';
import {
  DATAOKE_APP_KEY,
  DATAOKE_GATEWAY,
  DATAOKE_PATH,
  DATAOKE_SECRET,
  DATAOKE_VERSION,
  OTHER_SECRET,
  TAOBAO_APP_KEY,
  TAOBAO_SECRET,
  clock,
  configured,
  context,
  dataokeOk,
  endpoints,
  expectOrderPortsUnchanged,
  expectedSignRan,
  logText,
  observeDataoke,
  observeTaobao,
  removeDirectory,
  startUnion,
  startupFailure,
  temporaryDirectory,
  visible,
  type LogEntry,
} from './kit.ts';

// prod is covered at the credential-opening level (#8): a prod endpoint set must be all live, and
// pdd's own prod refusal (and taobao's kms_unavailable) would then decide a module-level test
// before the 大淘客 order source is ever looked at.

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

/** A fetch stand-in answering `body` (a 大淘客 success envelope by default) once per call. */
function answering(body: string = dataokeOk()) {
  const network = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response(body, { status: 200 }));
  vi.stubGlobal('fetch', network);
  return network;
}

async function writeSecret(name: string, content: string): Promise<string> {
  const file = join(directory, name);
  await fs.writeFile(file, content, 'utf8');
  return file;
}

/** staging with both pairs, both secret files written (taobao's and 大淘客's differ). */
async function bothConfigured(dataokeContent = DATAOKE_SECRET): Promise<{
  readonly config: AppConfig;
  readonly taobaoFile: string;
  readonly dataokeFile: string;
}> {
  const taobaoFile = await writeSecret('FAKE_TAOBAO_SECRET_FILE.txt', `${TAOBAO_SECRET}\n`);
  const dataokeFile = await writeSecret('FAKE_DATAOKE_SECRET_FILE.txt', dataokeContent);
  return { config: configured(taobaoFile, dataokeFile), taobaoFile, dataokeFile };
}

/**
 * The one 大淘客 client the factory assembled, after checking that it is exactly the order source
 * handed to the one real taobao adapter.
 */
function assembledOrderSource(
  taobao: ReturnType<typeof observeTaobao>,
  dataoke: ReturnType<typeof observeDataoke>,
  start = 0,
): DataokeClient {
  expect(dataoke.constructor).toHaveBeenCalledTimes(start + 1);
  expect(taobao.constructor).toHaveBeenCalledTimes(start + 1);
  const client = dataoke.constructor.mock.results[start]!.value as DataokeClient;
  expect(client).toBeInstanceOf(dataoke.Original);
  expect(taobao.constructor.mock.calls[start]![0].orderSource).toBe(client);
  return client;
}

it.each([
  ['local', 'live_in_local'],
  ['test', 'live_in_local'],
  ['prod', 'kms_unavailable'],
] as const)(
  '[AC-B1-04e#8] %s 下大淘客凭据开启直接拒绝（prod 等待 KMS），不读文件、错误不带值',
  async (appEnv, code) => {
    const file = await writeSecret('FAKE_DATAOKE_REFUSED_SECRET.txt', DATAOKE_SECRET);
    const readFile = vi.spyOn(fs, 'readFile');
    const open = vi.spyOn(fs, 'open');
    const error = await startupFailure(async () =>
      openDataokeCredentials(appEnv, { appKey: DATAOKE_APP_KEY, secretFile: file }),
    );
    expect(error).toMatchObject({ code });
    expect(error.cause).toBeUndefined();
    for (const marker of [file, directory, DATAOKE_APP_KEY, DATAOKE_SECRET]) {
      expect(visible(error)).not.toContain(marker);
    }
    expect(readsOf(file, readFile, open)).toBe(0);
  },
);

it('[AC-B1-04e#9] staging 开启大淘客凭据：缺值 credentials_missing，读不了 secret_unreadable，为空 secret_invalid，错误不带值', async () => {
  for (const missing of [
    null,
    undefined,
    { appKey: '', secretFile: join(directory, 'FAKE_UNUSED.txt') },
    { appKey: DATAOKE_APP_KEY, secretFile: '' },
  ]) {
    const error = await startupFailure(async () => openDataokeCredentials('staging', missing));
    expect(error).toMatchObject({ code: 'credentials_missing' });
    expect(visible(error)).not.toContain(DATAOKE_APP_KEY);
  }
  const absent = join(directory, `FAKE_ABSENT-${DATAOKE_APP_KEY}.txt`);
  const empty = await writeSecret(`FAKE_EMPTY-${DATAOKE_APP_KEY}.txt`, '\n');
  for (const [file, code] of [
    [absent, 'secret_unreadable'],
    [directory, 'secret_unreadable'],
    [empty, 'secret_invalid'],
  ] as const) {
    const error = await startupFailure(async () =>
      openDataokeCredentials('staging', { appKey: DATAOKE_APP_KEY, secretFile: file }),
    );
    expect(error).toMatchObject({ code });
    expect(error.cause).toBeUndefined();
    for (const marker of [file, directory, DATAOKE_APP_KEY]) {
      expect(visible(error)).not.toContain(marker);
    }
  }
});

it.each(['', '\n', '\r\n'])(
  '[AC-B1-04e#9] staging 开启时读一次并去末尾换行 %j，之后改文件不影响已取得的凭据',
  async (suffix) => {
    const file = await writeSecret('FAKE_DATAOKE_OPEN_SECRET.txt', `${DATAOKE_SECRET}${suffix}`);
    const readFile = vi.spyOn(fs, 'readFile');
    const open = vi.spyOn(fs, 'open');
    const credentials = await openDataokeCredentials('staging', {
      appKey: DATAOKE_APP_KEY,
      secretFile: file,
    });
    expect(readsOf(file, readFile, open)).toBe(1);
    await fs.writeFile(file, OTHER_SECRET, 'utf8');
    await expect(credentials()).resolves.toEqual({
      appKey: DATAOKE_APP_KEY,
      appSecret: DATAOKE_SECRET,
    });
    expect(readsOf(file, readFile, open)).toBe(1);
  },
);

it.each(['', '\n', '\r\n', 'missing', 'directory'])(
  '[AC-B1-04e#10] 大淘客密钥文件为空/仅换行/不存在/无法读取时启动失败，错误不含路径或内容：%j',
  async (content) => {
    const taobaoObserved = observeTaobao();
    const dataokeObserved = observeDataoke();
    const taobaoFile = await writeSecret('FAKE_TAOBAO_OK_SECRET.txt', TAOBAO_SECRET);
    const errors: Error[] = [];
    const logs: LogEntry[] = [];
    for (const label of ['FAKE_PATH_A', 'FAKE_PATH_B']) {
      const file = join(directory, `${label}-${DATAOKE_APP_KEY}.txt`);
      if (content === 'directory') await fs.mkdir(file);
      else if (content !== 'missing') await fs.writeFile(file, content, 'utf8');
      const error = await startupFailure(() =>
        startUnion(configured(taobaoFile, file), endpoints(), logs),
      );
      expect(visible(error)).not.toContain(file);
      expect(visible(error)).not.toContain(directory);
      expect(visible(error)).not.toContain(label);
      expect(visible(error)).not.toContain(DATAOKE_APP_KEY);
      expect(visible(error)).not.toContain(TAOBAO_SECRET);
      expect(error.cause).toBeUndefined();
      errors.push(error);
    }
    expect(errors[0]!.message).toBe(errors[1]!.message);
    expect(logText(logs)).not.toContain(directory);
    expect(logText(logs)).not.toContain(DATAOKE_APP_KEY);
    expect(dataokeObserved.constructor).not.toHaveBeenCalled();
    expect(taobaoObserved.constructor).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  },
);

it('[AC-B1-04e#11] 读大淘客密钥文件的原始异常（含路径与假 secret）不能透传到启动错误或日志', async () => {
  const taobaoFile = await writeSecret('FAKE_TAOBAO_OK_SECRET.txt', TAOBAO_SECRET);
  const file = join(directory, 'FAKE_DATAOKE_PERMISSION_DENIED.txt');
  const config = configured(taobaoFile, file);
  const originalOpen = fs.open;
  const originalReadFile = fs.readFile;
  const unsafe = Object.assign(new Error(`permission denied ${file} ${DATAOKE_SECRET}`), {
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
  expect(error === unsafe).toBe(false);
  expect(error.cause === undefined).toBe(true);
  for (const marker of [file, directory, DATAOKE_SECRET]) {
    expect(visible(error).includes(marker)).toBe(false);
    expect(logText(logs).includes(marker)).toBe(false);
  }
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['', '\n', '\r\n'])(
  '[AC-B1-04e#12] staging + taobao live 启动时读一次大淘客密钥并去末尾换行 %j，之后改文件或删文件仍用原凭据且不泄漏',
  async (suffix) => {
    const taobaoFile = await writeSecret('FAKE_TAOBAO_SECRET_FILE.txt', TAOBAO_SECRET);
    const file = await writeSecret('FAKE_DATAOKE_SECRET_FILE.txt', `${DATAOKE_SECRET}${suffix}`);
    const taobaoObserved = observeTaobao();
    const dataokeObserved = observeDataoke();
    const readFile = vi.spyOn(fs, 'readFile');
    const open = vi.spyOn(fs, 'open');
    const config = configured(taobaoFile, file);
    expect(readsOf(file, readFile, open)).toBe(0);
    const logs: LogEntry[] = [];
    // The module must use the passed config, not the ambient process environment.
    vi.stubEnv('DATAOKE_APP_KEY', 'fake-ambient-dataoke-app-key');
    vi.stubEnv('DATAOKE_APP_SECRET_FILE', join(directory, 'FAKE_AMBIENT_MISSING.txt'));
    const registry = await startUnion(config, endpoints(), logs);
    const client = assembledOrderSource(taobaoObserved, dataokeObserved);
    const supplied = dataokeObserved.constructor.mock.calls[0]![0];
    expect(registry.get('taobao')).toBe(taobaoObserved.constructor.mock.results[0]!.value);
    expect(registry.registrations().find((entry) => entry.platform === 'taobao')?.implemented).toBe(
      true,
    );
    expect(client).toBeDefined();
    // Change before the FIRST credentials() call: lazy opening must not pass this assertion.
    await fs.writeFile(file, OTHER_SECRET, 'utf8');
    await expect(supplied.credentials()).resolves.toEqual({
      appKey: DATAOKE_APP_KEY,
      appSecret: DATAOKE_SECRET,
    });
    await fs.rm(file);
    await expect(supplied.credentials()).resolves.toEqual({
      appKey: DATAOKE_APP_KEY,
      appSecret: DATAOKE_SECRET,
    });
    // The taobao adapter keeps its own pair: the two credential sources are never mixed.
    await expect(taobaoObserved.constructor.mock.calls[0]![0].credentials()).resolves.toEqual({
      appKey: TAOBAO_APP_KEY,
      appSecret: TAOBAO_SECRET,
    });
    expect(JSON.stringify(config)).not.toContain(DATAOKE_SECRET);
    expect(JSON.stringify(registry)).not.toContain(DATAOKE_SECRET);
    expect(logText(logs)).not.toContain(DATAOKE_SECRET);
    expect(logText(logs)).not.toContain(file);
    expect(readsOf(file, readFile, open)).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  },
);

it('[AC-B1-04e#13] 大淘客客户端用自己那一份 HTTPS 传输（禁止降级与跳转）、固定网关、注入时钟与六位随机源', async () => {
  const { config } = await bothConfigured();
  const taobaoObserved = observeTaobao();
  const dataokeObserved = observeDataoke();
  await startUnion(config, endpoints());
  assembledOrderSource(taobaoObserved, dataokeObserved);
  const supplied = dataokeObserved.constructor.mock.calls[0]![0];
  expect(supplied.baseUrl).toBe(DATAOKE_GATEWAY);
  expect(supplied.clock).toBe(clock);
  expect(supplied.warn).toBeTypeOf('function');
  for (let draw = 0; draw < 5; draw += 1) {
    const value = supplied.random(1_000_000);
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(1_000_000);
  }
  // Its own transport, not the one of the taobao adapter.
  const transport = supplied.transport;
  expect(transport).not.toBe(taobaoObserved.constructor.mock.calls[0]![0].transport);
  const network = vi
    .fn()
    .mockResolvedValue(new Response('synthetic transport body', { status: 200 }));
  vi.stubGlobal('fetch', network);
  const signal = new AbortController().signal;
  const request = {
    platform: 'taobao' as const,
    url: `${DATAOKE_GATEWAY}${DATAOKE_PATH}?synthetic=transport`,
    method: 'GET' as const,
    headers: {},
    signal,
  };
  await expect(transport(request)).resolves.toMatchObject({
    status: 200,
    body: 'synthetic transport body',
  });
  expect(network).toHaveBeenCalledExactlyOnceWith(
    request.url,
    expect.objectContaining({ method: 'GET', signal, redirect: 'error' }),
  );
  await expect(
    transport({ ...request, url: `http://openapi.dataoke.com${DATAOKE_PATH}` }),
  ).rejects.toMatchObject({ code: 'invalid_endpoint' });
  expect(network).toHaveBeenCalledTimes(1);
});

it.each(['replay', 'demo'] as const)(
  '[AC-B1-04e#14] staging 的 taobao=%s 不读取大淘客密钥、不装配大淘客客户端，同一配置切 live 才装配',
  async (mode) => {
    const taobaoFile = await writeSecret('FAKE_TAOBAO_SECRET_FILE.txt', TAOBAO_SECRET);
    const file = join(directory, 'FAKE_DATAOKE_SECRET_FILE.txt');
    const dataokeObserved = observeDataoke();
    const readFile = vi.spyOn(fs, 'readFile');
    const open = vi.spyOn(fs, 'open');
    const config = configured(taobaoFile, file);
    // No 大淘客 file exists yet: replay / demo must not even attempt to open it.
    await startUnion(config, endpoints(mode));
    expect(dataokeObserved.constructor).not.toHaveBeenCalled();
    expect(readsOf(file, readFile, open)).toBe(0);
    await fs.writeFile(file, DATAOKE_SECRET, 'utf8');
    await startUnion(config, endpoints());
    expect(dataokeObserved.constructor).toHaveBeenCalledTimes(1);
    expect(readsOf(file, readFile, open)).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  },
);

it('[AC-B1-04e#15] 有数据库时大淘客请求经 B1-04p 原始报文归档（platform taobao）；无数据库直通', async () => {
  const { config } = await bothConfigured();
  const archived: { platform: string; db: unknown; url: string; kind: string | undefined }[] = [];
  vi.spyOn(archive, 'createArchivingTransport').mockImplementation(
    (inner, deps) => async (request) => {
      archived.push({
        platform: request.platform,
        db: deps.db,
        url: request.url,
        kind: request.archive?.kind,
      });
      return inner(request);
    },
  );
  const network = answering();
  const fakeDb = { fake: 'dataoke-wiring-database' };
  const taobaoObserved = observeTaobao();
  const dataokeObserved = observeDataoke();

  await startUnion(config, endpoints(), [], fakeDb);
  const withDb = assembledOrderSource(taobaoObserved, dataokeObserved);
  await expect(
    withDb.request(
      'GET',
      DATAOKE_PATH,
      { q: 'synthetic' },
      { version: DATAOKE_VERSION, archive: { appId: context.appId, kind: 'order' } },
    ),
  ).resolves.toEqual({ result: 'synthetic' });
  expect(archived).toHaveLength(1);
  expect(archived[0]!.platform).toBe('taobao');
  expect(archived[0]!.db).toBe(fakeDb);
  expect(archived[0]!.kind).toBe('order');
  expect(archived[0]!.url.startsWith(`${DATAOKE_GATEWAY}${DATAOKE_PATH}?`)).toBe(true);
  expect(network).toHaveBeenCalledTimes(1);
  expect(String(network.mock.calls[0]![0]).startsWith(`${DATAOKE_GATEWAY}${DATAOKE_PATH}?`)).toBe(
    true,
  );

  await startUnion(config, endpoints());
  const withoutDb = assembledOrderSource(taobaoObserved, dataokeObserved, 1);
  await withoutDb.request('GET', DATAOKE_PATH, {}, { version: DATAOKE_VERSION });
  expect(archived).toHaveLength(1);
  expect(network).toHaveBeenCalledTimes(2);
});

it('[AC-B1-04e#16] 大淘客 warn 事件写一条 warn 日志，只带路径与 code', async () => {
  const { config } = await bothConfigured();
  const taobaoObserved = observeTaobao();
  const dataokeObserved = observeDataoke();
  const logs: LogEntry[] = [];
  await startUnion(config, endpoints(), logs);
  const client = assembledOrderSource(taobaoObserved, dataokeObserved);
  answering(
    JSON.stringify({ time: 1793433600000, code: 10021, msg: 'FAKE_UPSTREAM_MESSAGE_TEXT' }),
  );
  const before = logs.length;
  await expect(
    client.request('GET', DATAOKE_PATH, { q: 'FAKE_QUERY_TEXT' }, { version: DATAOKE_VERSION }),
  ).rejects.toMatchObject({ code: 'upstream_misconfigured' });
  const added = logs.slice(before);
  expect(added).toHaveLength(1);
  expect(added[0]!.level).toBe('warn');
  expect(added[0]!.text).toContain(DATAOKE_PATH);
  expect(added[0]!.text).toContain('10021');
  for (const marker of [
    'FAKE_UPSTREAM_MESSAGE_TEXT',
    'FAKE_QUERY_TEXT',
    DATAOKE_APP_KEY,
    DATAOKE_SECRET,
    TAOBAO_SECRET,
  ]) {
    expect(logText(logs)).not.toContain(marker);
  }
});

it('[AC-B1-04e#17] staging + taobao live 而大淘客两变量都没设：照常启动、不写 warn、不注入；两变量都设才注入', async () => {
  const taobaoFile = await writeSecret('FAKE_TAOBAO_SECRET_FILE.txt', TAOBAO_SECRET);
  const taobaoObserved = observeTaobao();
  const dataokeObserved = observeDataoke();
  const logs: LogEntry[] = [];
  const plain = await startUnion(configured(taobaoFile), endpoints(), logs);
  expect(logs.filter((entry) => entry.level === 'warn')).toEqual([]);
  expect(logText(logs)).not.toContain('DATAOKE');
  expect(dataokeObserved.constructor).not.toHaveBeenCalled();
  expect(taobaoObserved.constructor).toHaveBeenCalledTimes(1);
  expect(taobaoObserved.constructor.mock.calls[0]![0].orderSource).toBeUndefined();
  const adapter = plain.get('taobao');
  expect(adapter).toBe(taobaoObserved.constructor.mock.results[0]!.value);
  await expectOrderPortsUnchanged(adapter);

  const dataokeFile = await writeSecret('FAKE_DATAOKE_SECRET_FILE.txt', DATAOKE_SECRET);
  const injected = await startUnion(configured(taobaoFile, dataokeFile), endpoints(), logs);
  expect(dataokeObserved.constructor).toHaveBeenCalledTimes(1);
  expect(taobaoObserved.constructor).toHaveBeenCalledTimes(2);
  expect(taobaoObserved.constructor.mock.calls[1]![0].orderSource).toBe(
    dataokeObserved.constructor.mock.results[0]!.value,
  );
  expect(injected.get('taobao')).toBe(taobaoObserved.constructor.mock.results[1]!.value);
  expect(fetch).not.toHaveBeenCalled();
});

it('[AC-B1-04e#18] 端到端：注册表拿到的淘宝适配器持有大淘客客户端；请求发往大淘客网关，appKey 取变量值，signRan 按 B1-04m 规则，请求不含 secret', async () => {
  const { config } = await bothConfigured(`${DATAOKE_SECRET}\n`);
  const taobaoObserved = observeTaobao();
  const dataokeObserved = observeDataoke();
  const registry = await startUnion(config, endpoints());
  const client = assembledOrderSource(taobaoObserved, dataokeObserved);
  expect(registry.get('taobao')).toBe(taobaoObserved.constructor.mock.results[0]!.value);
  const network = answering();
  await expect(
    client.request('GET', DATAOKE_PATH, { pageSize: 2 }, { version: DATAOKE_VERSION }),
  ).resolves.toEqual({ result: 'synthetic' });
  expect(network).toHaveBeenCalledTimes(1);
  const [target, init] = network.mock.calls[0]!;
  const url = new URL(String(target));
  expect(`${url.origin}${url.pathname}`).toBe(`${DATAOKE_GATEWAY}${DATAOKE_PATH}`);
  expect(init?.method).toBe('GET');
  expect(init?.body ?? undefined).toBeUndefined();
  const query = url.searchParams;
  expect(query.get('appKey')).toBe(DATAOKE_APP_KEY);
  expect(query.get('version')).toBe(DATAOKE_VERSION);
  expect(query.get('pageSize')).toBe('2');
  const timer = String(clock.now().getTime());
  expect(query.get('timer')).toBe(timer);
  const nonce = query.get('nonce') ?? '';
  expect(nonce).toMatch(/^\d{6}$/);
  expect(query.get('signRan')).toBe(expectedSignRan(DATAOKE_APP_KEY, timer, nonce, DATAOKE_SECRET));
  // The taobao pair never signs a 大淘客 request.
  expect(query.get('signRan')).not.toBe(
    expectedSignRan(TAOBAO_APP_KEY, timer, nonce, TAOBAO_SECRET),
  );
  for (const part of [String(target), JSON.stringify(init?.headers ?? {})]) {
    expect(part).not.toContain(DATAOKE_SECRET);
    expect(part).not.toContain(TAOBAO_SECRET);
  }
});
