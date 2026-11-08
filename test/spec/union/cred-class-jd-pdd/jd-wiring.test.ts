import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JdUnionAdapter } from '../../../../apps/api/src/modules/union/infra/jd/jd-adapter.ts';
import { unionFailure } from '../jd-core/kit.ts';
import * as convert from '../jd-convert/kit.ts';
import {
  APP_KEY,
  SECRET,
  configured,
  endpoints,
  logText,
  removeDirectory,
  startUnion,
  temporaryDirectory,
  type LogEntry,
} from '../jd-live-wiring/kit.ts';
import { num } from '../jd-orders/kit.ts';

// Task-local AC labels ([AC-B1-04zzzzc#n]) name this task's acceptance points, not business rules.
// D10-1073：经真实 union 模块装配（startUnion 跑注册的工厂），京东告警钩子仍写恰好一条 warn 日志
// JD_API_WARNING，只带方法名与 code；错误码是新码。传输是替身 fetch，不联网；值全部合成。

const METHOD = 'jd.union.open.cc.probe';
const KEYS = { envelope: 'jd_union_open_cc_probe_responce', resultKey: 'queryResult' };
const MARKERS = [
  'FAKE_UPSTREAM_MESSAGE_TEXT',
  'FAKE_UPSTREAM_REQUEST_ID',
  'FAKE_QUERY_TEXT',
  APP_KEY,
  SECRET,
];

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

async function secretFile(): Promise<string> {
  const file = join(directory, 'FAKE_JD_CC_SECRET_FILE.txt');
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

it.each([403, '403'])(
  '[AC-B1-04zzzzc#12] 经模块装配：内层 code %j → upstream_misconfigured，写恰好一条 warn 日志 JD_API_WARNING，只带方法名与 code',
  async (code) => {
    const logs: LogEntry[] = [];
    const registry = await startUnion(configured(await secretFile()), endpoints(), logs);
    const adapter = registry.get('jd');
    expect(adapter).toBeInstanceOf(JdUnionAdapter);
    const inner = JSON.stringify({
      code,
      message: 'FAKE_UPSTREAM_MESSAGE_TEXT',
      requestId: 'FAKE_UPSTREAM_REQUEST_ID',
    });
    const network = answering(
      JSON.stringify({ [KEYS.envelope]: { code: '0', [KEYS.resultKey]: inner } }),
    );
    const before = logs.length;
    await unionFailure(
      () => (adapter as JdUnionAdapter).request(METHOD, { q: 'FAKE_QUERY_TEXT' }, KEYS),
      'upstream_misconfigured',
    );
    expect(network).toHaveBeenCalledTimes(1);
    const added = logs.slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]!.level).toBe('warn');
    expect(added[0]!.text).toContain('JD_API_WARNING');
    expect(added[0]!.text).toContain(METHOD);
    expect(added[0]!.text).toContain('403');
    for (const marker of MARKERS) expect(logText(logs)).not.toContain(marker);
  },
);

it.each(['2001602', '403'])(
  '[AC-B1-04zzzzc#13] 经模块装配的转链遇内层 %s → upstream_misconfigured，写恰好一条 warn 日志，只带方法名与 code，不带 subUnionId / clickURL / itemId / 上游文案',
  async (code) => {
    const logs: LogEntry[] = [];
    const config = configured(await secretFile(), { JD_SITE_ID: convert.siteId });
    const registry = await startUnion(config, endpoints(), logs);
    const network = answering(convert.reply(convert.failure(num(code))).body);
    const before = logs.length;
    await unionFailure(
      () => registry.get('jd').convert(convert.req, convert.identity, convert.ctx),
      'upstream_misconfigured',
    );
    expect(network).toHaveBeenCalledTimes(1);
    const added = logs.slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]!.level).toBe('warn');
    expect(added[0]!.text).toContain('JD_API_WARNING');
    expect(added[0]!.text).toContain(convert.method);
    expect(added[0]!.text).toContain(code);
    for (const marker of [
      convert.subUnionId,
      convert.clickUrl,
      convert.itemId,
      convert.upstreamText,
      SECRET,
    ]) {
      expect(logText(logs)).not.toContain(marker);
    }
  },
);
