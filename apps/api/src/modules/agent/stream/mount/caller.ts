import { createHmac, randomBytes } from 'node:crypto';
import type { FactoryProvider } from '@nestjs/common';
import {
  APP_CONFIG,
  FIELD_CRYPTO,
  tokenPrincipal,
  type AppConfig,
  type FieldCrypto,
} from '../../../platform/index.ts';
import type { AgentCaller } from '../../http/index.ts';
import { isUuid } from '../../store/index.ts';

/** Implemented by identity and passed in by app.module; agent owns no identity tables. */
export interface AgentCallerReader {
  phoneBound(appId: string, userId: string): Promise<boolean>;
  deviceHash(appId: string, deviceId: string): Promise<string | null>;
}

const CALLER_READER = Symbol('AGENT_CALLER_READER');

/**
 * B3-08k (D10-294; rule tests: test/spec/agent/foreign-db-handoff/**): the DI token of the
 * AgentCallerReader app.module builds on the stream entry (identity's createAgentCallerReader over
 * the primary handle's app schema); its value is null there without a database handle. The
 * AGENT_CALLER provider injects it and no longer takes a reader factory
 * (AgentStreamModuleOptions.callerReader is gone): it never hands a database handle to identity.
 * New wording of the old "no database → null": without a caller reader (the token's value null)
 * AGENT_CALLER is null, whether a database handle exists or not. The same symbol on every call.
 */
export function agentCallerReaderToken(): symbol {
  return CALLER_READER;
}

export interface AgentStreamRequest {
  readonly id: string;
  readonly ip: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly params: {
    readonly id?: string;
    readonly run_id?: string;
    readonly message_id?: string;
  };
  readonly body?: unknown;
}

export type AgentCallerResolver = (request: AgentStreamRequest) => Promise<AgentCaller>;
export const AGENT_CALLER = Symbol('AGENT_CALLER');
const IP_CONTEXT = 'agent.quota.ip';

/**
 * AGENT_CALLER of AgentModule.forStream, injected [APP_CONFIG, agentCallerReaderToken(),
 * {token: FIELD_CRYPTO, optional: true}]. B3-08k: the caller reader comes built by app.module (no
 * reader factory, no database handle here); without one (null) the resolver is null.
 */
export function agentCallerProvider(): FactoryProvider {
  return {
    provide: AGENT_CALLER,
    inject: [APP_CONFIG, agentCallerReaderToken(), { token: FIELD_CRYPTO, optional: true }],
    useFactory: (
      config: AppConfig,
      reader: AgentCallerReader | null | undefined,
      crypto?: FieldCrypto,
    ): AgentCallerResolver | null => {
      if (reader == null) return null;
      // Across production replicas/restarts the existing field keyring supplies the same key.
      // An ephemeral key is only suitable for local/test processes without a keyring.
      if (crypto === undefined && config.appEnv !== 'local' && config.appEnv !== 'test') {
        throw new Error('Agent caller requires the field keyring');
      }
      const localKey = crypto === undefined ? randomBytes(32) : undefined;
      return async (request) => {
        const principal = tokenPrincipal(request);
        const appId = principal?.app_id ?? header(request, 'x-app-id');
        const deviceId = principal?.device_id ?? header(request, 'x-device-id');
        const userId = principal?.uid ?? null;
        if (!appId || !isUuid(deviceId) || (userId !== null && !isUuid(userId))) {
          throw new Error('Agent caller identity unavailable');
        }
        const deviceHash = await reader.deviceHash(appId, deviceId);
        if (deviceHash === null) throw new Error('Agent caller device unavailable');
        const phoneBound = userId !== null && (await reader.phoneBound(appId, userId));
        // request.ip is resolved by bootstrap's trusted proxy policy, never by a raw header.
        const ipKey =
          crypto === undefined
            ? createHmac('sha256', localKey!).update(`${IP_CONTEXT}\0${request.ip}`).digest('hex')
            : crypto.blindIndex(request.ip, IP_CONTEXT);
        return { appId, deviceId, userId, deviceHash, phoneBound, ipKey, traceId: request.id };
      };
    },
  };
}

function header(request: AgentStreamRequest, name: string): string {
  const value = request.headers[name];
  return typeof value === 'string' ? value : '';
}
