import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { UnionErrorCode } from '../../../../apps/api/src/modules/union/domain/types.ts';
import type { DataokeClient } from '../../../../apps/api/src/modules/union/infra/dataoke/dataoke-client.ts';
import {
  DATAOKE_APP_KEY,
  DATAOKE_PATH,
  DATAOKE_SECRET,
  DATAOKE_VERSION,
  TAOBAO_SECRET,
  configured,
  endpoints,
  logText,
  observeDataoke,
  observeTaobao,
  removeDirectory,
  startUnion,
  temporaryDirectory,
  type LogEntry,
} from '../dataoke-wiring/kit.ts';
import { outcome } from './cred-kit.ts';

// 编排者补充第 4 条：装配后（UnionModule 注册表工厂，凭据读合成文件，fetch 打桩），站长授权组与其余凭据码
// 仍写现有那条大淘客 warn 日志，只带路径与 code；拒绝码是新码。10021 与 TOP code 11 的装配用例在
// dataoke-wiring / taobao-live-wiring 的 #16（本任务只改了期望码）。

let directory: string;
beforeEach(async () => {
  directory = await temporaryDirectory();
  // Even a broken implementation must not contact a real network from these tests.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('FAKE_NETWORK_MUST_BE_STUBBED')));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await removeDirectory(directory);
});

async function writeSecret(name: string, content: string): Promise<string> {
  const file = join(directory, name);
  await writeFile(file, content, 'utf8');
  return file;
}

it.each<[number, UnionErrorCode]>([
  [10072, 'site_auth_invalid'],
  [10210, 'site_auth_invalid'],
  [10211, 'site_auth_invalid'],
  [401, 'upstream_misconfigured'],
  [10009, 'upstream_misconfigured'],
])(
  '[AC-B1-04zzzx#14] 装配后大淘客外层 %s → %s：仍写一条 warn 日志，只带路径与 code，不带上游说明、参数与凭据',
  async (code, expected) => {
    const taobaoFile = await writeSecret('FAKE_TAOBAO_SECRET_FILE.txt', `${TAOBAO_SECRET}\n`);
    const dataokeFile = await writeSecret('FAKE_DATAOKE_SECRET_FILE.txt', DATAOKE_SECRET);
    const taobaoObserved = observeTaobao();
    const dataokeObserved = observeDataoke();
    const logs: LogEntry[] = [];
    await startUnion(configured(taobaoFile, dataokeFile), endpoints(), logs);
    expect(dataokeObserved.constructor).toHaveBeenCalledTimes(1);
    const client = dataokeObserved.constructor.mock.results[0]!.value as DataokeClient;
    expect(taobaoObserved.constructor.mock.calls[0]![0].orderSource).toBe(client);

    const network = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () =>
          new Response(
            JSON.stringify({ time: 1793433600000, code, msg: 'FAKE_UPSTREAM_MESSAGE_TEXT' }),
            { status: 200 },
          ),
      );
    vi.stubGlobal('fetch', network);
    const before = logs.length;
    const error = await outcome(() =>
      client.request('GET', DATAOKE_PATH, { q: 'FAKE_QUERY_TEXT' }, { version: DATAOKE_VERSION }),
    );
    expect(network).toHaveBeenCalledTimes(1);
    const added = logs.slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]!.level).toBe('warn');
    expect(added[0]!.text).toContain(DATAOKE_PATH);
    expect(added[0]!.text).toContain(String(code));
    for (const marker of [
      'FAKE_UPSTREAM_MESSAGE_TEXT',
      'FAKE_QUERY_TEXT',
      DATAOKE_APP_KEY,
      DATAOKE_SECRET,
      TAOBAO_SECRET,
    ]) {
      expect(logText(logs)).not.toContain(marker);
    }
    expect(error).toMatchObject({ code: expected, platform: 'taobao' });
  },
);
