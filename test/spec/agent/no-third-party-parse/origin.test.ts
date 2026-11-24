import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { expect, it, vi } from 'vitest';
import type { ToolContext } from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import {
  createAgentStreamAssembly,
  type AgentStreamAssemblyDeps,
} from '../../../../apps/api/src/modules/agent/stream/mount/index.ts';
import { bridge } from '../../../../packages/contracts-ts/src/index.ts';
import { ok, setup as setupDataoke } from '../../union/dataoke-core/kit.ts';
import { detailSetup } from '../../union/taobao-goods/kit.ts';
import { output, request, TOKEN } from '../stream-assembly/kit.ts';
import { Logs, ManualTime } from '../stream-mount/kit.ts';

const shortLink = 'https://s.click.taobao.com/t?e=SyntheticAgent';

function fixture() {
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const time = new ManualTime();
  const dataoke = setupDataoke();
  dataoke.transport.mockResolvedValue(ok({ goodsId: '9007199254740993123' }));
  const taobao = detailSetup([], { orderSource: dataoke.client });
  expect(taobao.adapter.resolveLink).toBeTypeOf('function');
  const resolveLink = vi.spyOn(taobao.adapter, 'resolveLink');
  const config: AgentStreamAssemblyDeps['config'] = {
    configValue: async (_appId, key) =>
      key === 'parse.tpwd.enabled' ? { value: true, version: 1 } : null,
  };
  const deps: AgentStreamAssemblyDeps = {
    db,
    config,
    clock: time.clock,
    scheduler: time.scheduler,
    logger: new Logs().logger,
    texts: { text: async (_appId, key) => key, toolDisplay: async () => '合成工具状态' },
    routes: { configured: async () => ['Wallet'], contract: () => bridge.routes },
    ports: {
      readProduct: async () => {
        throw new Error('链接报价应通过解析读取商品');
      },
      cards: () => {
        throw new Error('未解析到商品时不应注册商品卡');
      },
      search: {
        platforms: ['taobao'],
        searchProducts: async () => [],
        prohibited: async () => false,
        categoryAllowed: async () => true,
      },
      parsing: {
        config,
        clock: time.clock,
        catalog: { listPlatforms: async () => [], resolveProductKey: async (key) => key },
        cards: {
          assemble: async () => {
            throw new Error('报价解析不应组装商品卡');
          },
        },
        getGovernedAdapter: () => taobao.adapter,
        linkPatterns: {
          version: 'synthetic',
          rules: [
            {
              platform: 'taobao',
              category: 'promo',
              hosts: ['s.click.taobao.com'],
              path_patterns: ['/**'],
            },
          ],
        },
      },
    },
  };
  const context: ToolContext = {
    subject: {
      appId: 'synthetic-agent-app',
      traceId: 'synthetic-agent-trace',
      deviceId: 'synthetic-agent-device',
      deviceHash: 'synthetic-agent-device-hash',
      ipKey: 'synthetic-agent-ip-key',
      userId: 'synthetic-agent-user',
      phoneBound: true,
    },
    sessionId: 'synthetic-agent-session',
    runId: 'synthetic-agent-run',
    placeholders: {},
    signal: new AbortController().signal,
  };
  return { db, deps, context, resolveLink, dataoke, taobao };
}

it.each([
  ['淘口令', TOKEN],
  ['推广短链', shortLink],
])('[AC-B1-04zzzzo#12] Agent 报价%s标记来源，禁用第三方解析', async (_kind, raw) => {
  const { db, deps, context, resolveLink, dataoke, taobao } = fixture();
  try {
    expect(createAgentStreamAssembly).toBeTypeOf('function');
    const assembly = createAgentStreamAssembly(deps);
    expect(assembly.deterministic?.run).toBeTypeOf('function');
    const terminal = output(context);

    await assembly.deterministic.run(request(context, raw), terminal.run);

    expect(resolveLink).toHaveBeenCalledTimes(1);
    expect(resolveLink).toHaveBeenCalledWith(
      raw,
      expect.objectContaining({
        appId: context.subject.appId,
        requestId: context.runId,
        purpose: 'online',
        origin: 'agent',
      }),
    );
    expect(dataoke.credentials).not.toHaveBeenCalled();
    expect(dataoke.transport).not.toHaveBeenCalled();
    expect(taobao.transport).not.toHaveBeenCalled();
    expect(terminal.cards).toMatchObject([{ type: 'notice', data: { text_key: 'error.30132' } }]);
  } finally {
    await db.destroy();
  }
});
