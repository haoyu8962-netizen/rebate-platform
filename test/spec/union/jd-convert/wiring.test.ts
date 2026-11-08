import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createUnionRegistry } from '../../../../apps/api/src/modules/union/infra/registry.ts';
import type { UnionTransport } from '../../../../apps/api/src/modules/union/infra/replay.ts';
import { sent, unionFailure } from '../jd-core/kit.ts';
import {
  APP_KEY,
  JD_URL,
  SECRET,
  configured,
  endpoints,
  logText,
  observeJd,
  registryOptions,
  removeDirectory,
  startUnion,
  temporaryDirectory,
  type LogEntry,
} from '../jd-live-wiring/kit.ts';
import { num } from '../jd-orders/kit.ts';
import {
  clickUrl,
  ctx,
  failure,
  identity,
  itemId,
  method,
  promotionReq,
  reply,
  req,
  siteId,
  subUnionId,
  success,
  upstreamText,
} from './kit.ts';

// D10-500 ①：registry 的 jdLive 带 siteId，union.module.ts 传 config.jdSiteId；钉法照 jd-live-wiring。
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

function liveOptions(site: { readonly siteId?: string | null } = {}) {
  const credentials = vi.fn(async () => ({ appKey: APP_KEY, appSecret: SECRET }));
  const transport = vi.fn<UnionTransport>().mockResolvedValue(reply(success()));
  return { ...registryOptions(), jdLive: { credentials, transport, ...site } };
}

async function secretFile(): Promise<string> {
  const file = join(directory, 'FAKE_JD_SECRET_FILE.txt');
  await writeFile(file, SECRET, 'utf8');
  return file;
}

/** A fetch stand-in answering `body` once per call. */
function answering(body: string) {
  const network = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response(body, { status: 200 }));
  vi.stubGlobal('fetch', network);
  return network;
}

it('[AC-B1-04zd#43] jdLive.siteId 原样交给适配器，转链发出的就是它', async () => {
  const observed = observeJd();
  const options = liveOptions({ siteId });
  const registry = createUnionRegistry(options);
  expect(observed.constructor).toHaveBeenCalledTimes(1);
  expect(observed.constructor.mock.calls[0]![0].siteId).toBe(siteId);
  await expect(registry.get('jd').convert(req, identity, ctx)).resolves.toEqual({
    kind: 'url',
    url: clickUrl,
  });
  expect(promotionReq(sent(options.jdLive.transport))).toMatchObject({ siteId });
});

it.each([
  ['未给', {}],
  ['null', { siteId: null }],
] as const)(
  '[AC-B1-04zd#44] jdLive.siteId %s：适配器照常装配，转链 adapter_unimplemented，不取凭据、不发请求',
  async (_name, site) => {
    const options = liveOptions(site);
    const registry = createUnionRegistry(options);
    expect(registry.registrations().find((entry) => entry.platform === 'jd')?.implemented).toBe(
      true,
    );
    await unionFailure(
      () => registry.get('jd').convert(req, identity, ctx),
      'adapter_unimplemented',
    );
    expect(options.jdLive.credentials).not.toHaveBeenCalled();
    expect(options.jdLive.transport).not.toHaveBeenCalled();
  },
);

it('[AC-B1-04zd#45] 模块把 config.jdSiteId 交给适配器：端到端发往端点 baseUrl，请求带这个 siteId', async () => {
  const observed = observeJd();
  const config = configured(await secretFile(), { JD_SITE_ID: siteId });
  const registry = await startUnion(config, endpoints());
  expect(observed.constructor.mock.calls[0]![0].siteId).toBe(siteId);
  const network = answering(reply(success()).body);
  await expect(registry.get('jd').convert(req, identity, ctx)).resolves.toEqual({
    kind: 'url',
    url: clickUrl,
  });
  expect(network).toHaveBeenCalledTimes(1);
  const [url, init] = network.mock.calls[0]!;
  expect(String(url)).toBe(JD_URL);
  const form = new URLSearchParams(String(init?.body));
  expect(form.get('method')).toBe(method);
  const parameters = JSON.parse(form.get('360buy_param_json') ?? '{}') as Record<string, unknown>;
  expect(parameters['promotionCodeReq']).toMatchObject({ siteId });
});

it('[AC-B1-04zd#46] 没配 JD_SITE_ID：启动不拒绝，转链 adapter_unimplemented 不联网，不读 process.env', async () => {
  // The module must use the passed config, not the ambient process environment.
  vi.stubEnv('JD_SITE_ID', '4000999');
  const registry = await startUnion(configured(await secretFile()), endpoints());
  expect(registry.registrations().find((entry) => entry.platform === 'jd')?.implemented).toBe(true);
  await unionFailure(() => registry.get('jd').convert(req, identity, ctx), 'adapter_unimplemented');
  expect(fetch).not.toHaveBeenCalled();
});

it('[AC-B1-04zd#47] 无权限告警经模块写一条 warn 日志，只带方法名与 code', async () => {
  const logs: LogEntry[] = [];
  const config = configured(await secretFile(), { JD_SITE_ID: siteId });
  const registry = await startUnion(config, endpoints(), logs);
  answering(reply(failure(num('2001403'))).body);
  const before = logs.length;
  await unionFailure(
    () => registry.get('jd').convert(req, identity, ctx),
    'upstream_misconfigured',
  );
  const added = logs.slice(before);
  expect(added).toHaveLength(1);
  expect(added[0]!.level).toBe('warn');
  expect(added[0]!.text).toContain(method);
  expect(added[0]!.text).toContain('2001403');
  for (const marker of [subUnionId, clickUrl, itemId, upstreamText, SECRET]) {
    expect(logText(logs)).not.toContain(marker);
  }
});
