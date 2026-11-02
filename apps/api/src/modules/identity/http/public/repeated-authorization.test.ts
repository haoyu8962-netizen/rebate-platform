// A repeated Authorization header through Node's HTTP parsing (BR-ID-01 ②; orchestrator ruling
// B1-02h §9.5 #7: a repeated header is malformed → 10002). Node's HTTP parser keeps only the first
// Authorization line and light-my-request cannot send two, so this case builds the real api entry
// (bootstrap, registration point, global error filter) and hands raw request bytes to its HTTP
// server as a connection (a Duplex emitted as 'connection': no port, no network; unit tests never
// listen). The entry's token check is replaced by one built the same way with a stubbed session
// lookup (no database); the signature check stays first.
import { generateKeyPairSync } from 'node:crypto';
import { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { dereference } from '@readme/openapi-parser';
import { Ajv2020 } from 'ajv/dist/2020.js';
import ajvFormats from 'ajv-formats';
import type { OpenAPIV3_1 } from 'openapi-types';
import { afterEach, expect, it, vi } from 'vitest';
import { AppModule } from '../../../../app.module.ts';
import { createHttpApp } from '../../../../bootstrap.ts';
import {
  FixedClock,
  REQUEST_CHECKS,
  contractAuthRoutes,
  createRootLogger,
  isContractSignedRoute,
  loadConfig,
  tokenPrincipal,
  type RequestCheckPlan,
  type TokenPrincipal,
} from '../../../platform/index.ts';
import {
  TOKEN_REJECTIONS,
  createTokenCheck,
  createTokenService,
} from '../../application/access-tokens.ts';

const CONTRACT = fileURLToPath(
  new URL('../../../../../../../contracts/openapi.yaml', import.meta.url),
);
const TRACE = 'b102a000000000000000000000000002';
const PRINCIPAL: TokenPrincipal = {
  uid: '019a0000-0000-7000-8000-000000000010',
  app_id: 'couli',
  sid: 'session-unit',
  device_id: '019a0000-0000-7000-8000-000000000001',
  scp: 'full',
};

let app: NestFastifyApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.restoreAllMocks();
});

async function errorEnvelopeValidator() {
  const document = await dereference<OpenAPIV3_1.Document>(CONTRACT, {
    resolve: { external: false },
  });
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  ajvFormats.default(ajv);
  ajv.addFormat('int32', {
    type: 'number',
    validate: (value: number) =>
      Number.isInteger(value) && value >= -(2 ** 31) && value <= 2 ** 31 - 1,
  });
  ajv.addFormat('int64', { type: 'number', validate: Number.isSafeInteger });
  return ajv.compile(document.components?.schemas?.['ErrorEnvelope'] as object);
}

/**
 * Hands the request head (one line each, exactly as given) to the server's own HTTP parser as a
 * new connection — Node accepts any Duplex emitted as 'connection' — and resolves with the
 * response once the server ends it (Connection: close). Nothing listens on a port.
 */
function rawExchange(
  server: { emit(event: 'connection', socket: Duplex): boolean },
  head: readonly string[],
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
      final(callback) {
        callback();
        const text = Buffer.concat(chunks).toString('utf8');
        const separator = text.indexOf('\r\n\r\n');
        resolve({
          status: Number(/^HTTP\/1\.1 (\d{3}) /.exec(text)?.[1]),
          body: separator === -1 ? '' : text.slice(separator + 4),
        });
      },
    });
    socket.on('error', reject);
    server.emit('connection', socket);
    socket.push([...head, 'Connection: close', '', ''].join('\r\n'));
  });
}

it('[BR-ID-01][BR-ID-07] through Node HTTP parsing a valid token followed by `Authorization: Bearer invalid` is 10002 before the handler; one valid token passes', async () => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const tokens = createTokenService({
    clock: new FixedClock('2026-10-06T04:00:00.000Z'),
    keys: {
      kid: 'unit',
      privateKey: pair.privateKey,
      publicKeys: new Map([['unit', pair.publicKey]]),
    },
  });
  const find = vi.fn(async () => ({ revoked_at: null }));
  const original = AppModule.forEntry;
  vi.spyOn(AppModule, 'forEntry').mockImplementationOnce((options) => {
    const root = original(options);
    const providers = (root.providers ?? []).map((provider) => {
      if (typeof provider !== 'object' || !('provide' in provider)) return provider;
      if (provider.provide !== REQUEST_CHECKS || !('useFactory' in provider)) return provider;
      const factory = provider.useFactory as (...values: unknown[]) => RequestCheckPlan;
      return {
        ...provider,
        useFactory: (...values: unknown[]): RequestCheckPlan => {
          const plan = factory(...values);
          // The entry's signature check first, then a token check whose sessions are stubbed.
          return {
            ...plan,
            checks: [plan.checks[0]!, createTokenCheck({ tokens, sessions: { find } })],
          };
        },
      };
    });
    return { ...root, providers };
  });
  app = await createHttpApp('api', {
    config: loadConfig({ APP_ENV: 'test' }),
    clock: new FixedClock('2026-10-06T04:00:00.000Z'),
    logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
  });
  await app.init();
  const server = app.getHttpAdapter().getInstance();
  // An unsigned GET operation that reads the token and that the entry does not implement (picked
  // from the contract, so an implemented route is never shadowed). Stage ② judges a presented token
  // alike under x-auth login and optional.
  const probe = contractAuthRoutes().find(
    (route) =>
      route.path.startsWith('/v1/') &&
      route.auth !== 'none' &&
      route.method === 'GET' &&
      !isContractSignedRoute(route.method, route.path) &&
      !server.hasRoute({ method: route.method, url: route.path }),
  );
  expect(
    probe,
    'an unimplemented unsigned GET operation of the contract that reads the token',
  ).toBeDefined();
  const handler = vi.fn((request: object) => ({ uid: tokenPrincipal(request)?.uid ?? null }));
  server.route({ method: probe!.method, url: probe!.path, handler });
  await server.ready();
  const http = server.server;
  const token = await tokens.issueAccess(PRINCIPAL);
  const head = [
    `GET ${probe!.path.replace(/:[^/]+/g, 'test-id')} HTTP/1.1`,
    'Host: 127.0.0.1',
    'X-App-Id: couli',
    'X-Platform: ios',
    'X-App-Version: 2.0.0',
    `X-Device-Id: ${PRINCIPAL.device_id}`,
    `X-Trace-Id: ${TRACE}`,
  ];

  const repeated = await rawExchange(http, [
    ...head,
    `Authorization: Bearer ${token}`,
    'Authorization: Bearer invalid',
  ]);
  expect(repeated.status).toBe(401);
  const body: unknown = JSON.parse(repeated.body);
  expect(body).toEqual({ code: 10002, msg: TOKEN_REJECTIONS[10002].msg, trace_id: TRACE });
  const validate = await errorEnvelopeValidator();
  expect(validate(body)).toBe(true);
  expect(handler).not.toHaveBeenCalled();
  expect(find).not.toHaveBeenCalled();

  const single = await rawExchange(http, [...head, `Authorization: Bearer ${token}`]);
  expect(single.status).toBe(200);
  expect(JSON.parse(single.body)).toEqual({ uid: PRINCIPAL.uid });
  expect(handler).toHaveBeenCalledTimes(1);
  expect(find).toHaveBeenCalledWith(PRINCIPAL.app_id, PRINCIPAL.sid);
}, 30_000);
