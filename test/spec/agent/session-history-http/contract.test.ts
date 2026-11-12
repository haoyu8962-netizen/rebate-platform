// B3-08ze (2) · listAgentSessionMessages leaves `x-implementation: planned` (D10-1347): the contract
// operation carries no such mark, the generated planned-operations list no longer has it, and the
// generated route schemas give it a request schema equal to routeSchemaOf of the contract
// operation (as test/spec/parsing/http/schema.test.ts does for parseInput). No database.
import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { plannedOperations } from '../../../../packages/contracts-ts/src/index.ts';
import {
  FixedClock,
  createRootLogger,
  loadConfig,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { CONTRACT_ROUTE_SCHEMAS } from '../../../../apps/api/src/modules/platform/validation/route-schemas.gen.ts';
import {
  routeSchemaOf,
  type ContractOperation,
  type ContractParameter,
  type RouteSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import {
  at,
  compile,
  contract,
  historyPath,
  object,
  operation,
} from '../../contracts/agent-history/kit.ts';

const OPERATION_ID = 'listAgentSessionMessages';

it('[AC-B3-08ze#2][BR-AI-19][BR-AI-20] 契约状态：listAgentSessionMessages 不再带 x-implementation（契约原文），生成的 plannedOperations 不再含它，生成的路由请求模式含它且等于契约操作的 routeSchemaOf（path id、query cursor/limit、客户端头）', async () => {
  const doc = await contract();
  const op = operation(doc, 'get', historyPath);
  expect(op['operationId']).toBe(OPERATION_ID);
  expect(op).not.toHaveProperty('x-implementation');
  expect(plannedOperations.has(OPERATION_ID), 'planned-operations.gen.ts').toBe(false);

  const generated: Readonly<Record<string, RouteSchema>> = CONTRACT_ROUTE_SCHEMAS;
  expect(Object.hasOwn(generated, OPERATION_ID), 'route-schemas.gen.ts').toBe(true);
  const pathItem = at(doc, 'paths', historyPath);
  const shared = pathItem['parameters'] as readonly ContractParameter[] | undefined;
  expect(generated[OPERATION_ID]).toEqual(
    routeSchemaOf(op as unknown as ContractOperation, shared),
  );
  const schema = object(generated[OPERATION_ID]);
  expect(Object.keys(at(schema, 'params', 'properties'))).toEqual(['id']);
  expect(Object.keys(at(schema, 'querystring', 'properties')).toSorted()).toEqual([
    'cursor',
    'limit',
  ]);
  expect(at(schema, 'headers')['required']).toEqual(expect.arrayContaining(['x-device-id']));
});

interface Injected {
  readonly statusCode: number;
  readonly headers: Record<string, unknown>;
  readonly body: string;
}

interface App {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  inject(options: {
    method: string;
    url: string;
    headers?: Record<string, string>;
  }): Promise<Injected>;
}

/** An HTTP entry without a database (no listen, no queue). */
async function entryApp(entry: 'stream' | 'api'): Promise<App> {
  // Dynamic URL keeps Nest's decorated controllers out of the spec project's TS compilation.
  const boot = (await import(
    new URL('../../../../apps/api/src/bootstrap.ts', import.meta.url).href
  )) as { createHttpApp(entry: string, overrides: object): Promise<App> };
  const app = await boot.createHttpApp(entry, {
    config: loadConfig({ APP_ENV: 'test' }),
    clock: new FixedClock('2026-10-06T10:00:00+08:00'),
    logger: createRootLogger({ level: 'silent', entry, appEnv: 'test' }),
  });
  await app.init();
  return app;
}

function guestRequest() {
  return {
    method: 'GET',
    url: `/v1/agent/sessions/${randomUUID()}/messages`,
    headers: {
      'x-app-id': 'couli',
      'x-platform': 'ios',
      'x-channel': 'appstore',
      'x-app-version': '2.0.0',
      'x-device-id': randomUUID(),
    },
  };
}

it('[AC-B3-08ze#1][BR-AI-20] 路由挂在 stream 入口：无库时 GET /v1/agent/sessions/{id}/messages 已注册（不是 404），回 JSON 50001 ErrorEnvelope（同另外四条 agent 路由）；api 入口不提供它（404）', async () => {
  const stream = await entryApp('stream');
  try {
    const response = await stream.inject(guestRequest());
    expect(response.statusCode, response.body).not.toBe(404);
    expect(String(response.headers['content-type']), response.body).toMatch(/^application\/json/u);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body['code'], response.body).toBe(50001);
    const doc = await contract();
    const envelope = compile(at(doc, 'components', 'schemas', 'ErrorEnvelope'));
    expect(envelope(body), JSON.stringify(envelope.errors)).toBe(true);
  } finally {
    await stream.close();
  }
  const api = await entryApp('api');
  try {
    const response = await api.inject(guestRequest());
    expect(response.statusCode, response.body).toBe(404);
  } finally {
    await api.close();
  }
}, 60_000);
