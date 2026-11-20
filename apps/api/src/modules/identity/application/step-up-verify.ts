// Stage ⑫ of the request decision order: the user-side step-up check of the three x-step-up
// operations (规划/08 BR-ID-08, BR-ID-01 判定顺序 ⑫ 10003; 04 §5 step-up row; 02 §18
// step_up_token row; task B1-02y, orchestrator ruling §9.3). The public entry points follow the
// frozen rule-test skeleton in test/spec/identity/step-up-verify/**.
//
// When: only on the three x-step-up operations, keyed by the idempotent request's method and path
// (a fixed copy of 04 §5): PUT /v1/me/payout-account → payout_account_change, POST /v1/me/phone → phone_change (only when the account already has a
// bound phone, read on the claim's transaction: a first binding needs no token), POST
// /v1/me/deletion → account_deletion. Every other request passes untouched — POST /v1/withdrawals
// included: a withdrawal needs no step-up (BR-ID-08, BR-WDR-01, BR-WDR-03 ② retired; B1-02zzzc,
// D10-1665), although it stays one of the four sensitive operations (risk-state.ts). Only in the
// idempotency post-miss phase: a replay (also of a request whose token has since expired or been
// consumed), 40901, 20901, 20903 and a missing / malformed Idempotency-Key (20001) never read,
// judge or reserve the token.
//
// What (any failure → 10003, HTTP 403, no data): header X-Step-Up-Token present; ES256 signature
// under the access token's keys and issuer, aud=step_up; exp judged on the injected Clock
// (now ≥ exp is expired: second 299 after issue passes, second 300 is 10003); the claims uid,
// app_id and device_id equal the request's verified principal (stage ②) and the verified device;
// action equals the operation's step_up_action; jti neither reserved nor consumed. The token is
// only compared against, never a source of identity. sid is not compared.
//
// One use (D12): a passing token is reserved atomically in Redis (SET … NX with the token's
// remaining lifetime); a reservation that is already taken → 10003. After the business: HTTP 2xx
// and code 0 → consumed (kept until exp); any other outcome (non-zero code, thrown error, rolled
// back transaction, a later stage refusing) → only this request's own reservation is released
// (compare and delete), so the token can be retried while it is valid. Redis unavailable while
// judging → 50001 and the business does not run; Redis failing while settling → one pino `warn`
// line, the response is unchanged. Logs never carry the token or its jti.
//
// Business digest (B1-02zzzb; BR-ID-08 细则「绑定业务摘要」): ⑫ does not compare the token's
// `summary` claim. After a passing check it is kept on this request's step-up context, and the
// handler reads it through the StepUpContext withStepUp hands to `execute` (null: no digest in the
// claims, or no token was judged), to compare it inside its own business lock; a mismatch there is
// the business's 10003 and, being a non-zero answer, releases the reservation (not consumed). The
// digest is never logged.
//
// Placement: app.module hands createStepUpCheck's result to RiskModule.forRoot's
// `beforeRateLimit` list, so it is judged after ④a and ⑤ and before ⑬.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`, no decorators.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { StepUpAction } from '@couli/contracts-ts';
import {
  RequestRejection,
  idempotencyPostMissTransaction,
  type Clock,
  type IdempotencyPostMissCheck,
  type IdempotentResponse,
  type RedisHandle,
  type RootLogger,
  type TokenPrincipal,
} from '../../platform/index.ts';
import { STEP_UP_FAILURE } from '../domain/step-up-digest.ts';
import { createStepUpTokenVerifier, type TokenKeyProvider } from './access-tokens.ts';
import { RiskModule } from '../../risk/index.ts';

export const STEP_UP_CHECK = Symbol('STEP_UP_CHECK');

/** Fixed copy of contracts' x-step-up operations (04 §5); the withdrawal is not one (D10-1665). */
const ACTIONS: ReadonlyMap<string, StepUpAction> = new Map([
  ['PUT /v1/me/payout-account', 'payout_account_change'],
  ['POST /v1/me/phone', 'phone_change'],
  ['POST /v1/me/deletion', 'account_deletion'],
]);

// RedisNamespace supplies whole seconds in ARGV[1]. Subtract the rounding excess (ARGV[3])
// so the atomic reservation uses precisely the remaining milliseconds, including partial seconds.
const RESERVE = `
local ttl = tonumber(ARGV[1]) * 1000 - tonumber(ARGV[3])
if redis.call('SET', KEYS[1], ARGV[2], 'NX', 'PX', ttl) then return 1 end
return 0
`;
// Ownership is compared for both outcomes. KEEPTTL preserves the reservation's original expiry;
// a delayed completion must never extend its lifetime or overwrite another request's owner.
const SETTLE = `
if redis.call('GET', KEYS[1]) ~= ARGV[2] then return 0 end
if ARGV[3] == 'consume' then
  redis.call('SET', KEYS[1], 'consumed', 'XX', 'KEEPTTL')
else
  redis.call('DEL', KEYS[1])
end
return 1
`;

interface StepUpScope {
  readonly request: StepUpHttpRequest;
  settle?: (success: boolean) => Promise<void>;
  /** The judged token's digest claim (null: none); set only by a passing stage ⑫. */
  summary?: string | null;
}

/** What the business handler of a withStepUp call may read of the judged step_up_token. */
export interface StepUpContext {
  /**
   * The business digest of the token stage ⑫ passed in this request (BR-ID-08 细则「绑定业务摘要」);
   * null when its claims carry none or no token was judged. Read inside the business lock.
   */
  summary(): string | null;
}

const SCOPE = new AsyncLocalStorage<StepUpScope>();
const required = () =>
  new RequestRejection(STEP_UP_FAILURE.code, STEP_UP_FAILURE.status, STEP_UP_FAILURE.msg);
const unavailable = () => new RequestRejection(50001, 500, '服务端错误');

/**
 * The HTTP side of one request as its controller holds it after stages ① ② ③: the Fastify request
 * itself (headers, the verified principal copied onto it by the token check).
 */
export interface StepUpHttpRequest {
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly principal?: TokenPrincipal;
  readonly verifiedDevice?: { readonly appId: string; readonly deviceId: string };
}

export interface StepUpCheckOptions {
  /** The access token's keys (TOKEN_KEYS): the step_up_token is signed with them. */
  readonly keys: TokenKeyProvider;
  readonly clock: Clock;
  /** Null (no REDIS on the entry): every x-step-up request fails closed with 50001. */
  readonly redis: RedisHandle | null;
  readonly logger: RootLogger;
}

/**
 * Stage ⑫ as an idempotency post-miss check (registered through RiskModule's `beforeRateLimit`).
 * Like ④a and ⑤, it skips calls outside an HTTP request. Within HTTP it reads the step-up context
 * from the enclosing withStepUp call; a missing wrapper fails closed, except a first phone binding.
 */
export function createStepUpCheck(options: StepUpCheckOptions): IdempotencyPostMissCheck {
  const verify = createStepUpTokenVerifier(options.keys, options.clock);
  return async (command) => {
    if (!RiskModule.hasHttpRequestScope()) return;
    const action = ACTIONS.get(`${command.method} ${command.path}`);
    if (action === undefined) return;
    // First binding needs no step-up context; read the authenticated command's user on the
    // claim transaction before requiring the wrapper used for phone changes.
    if (action === 'phone_change') {
      const trx = idempotencyPostMissTransaction();
      if (trx === undefined) throw unavailable();
      const user = await trx
        .withSchema('app')
        .selectFrom('users')
        .select('phone_hmac')
        .where('app_id', '=', command.appId)
        .where('id', '=', command.actor.userId)
        .executeTakeFirst();
      if (user === undefined) throw required();
      if (user.phone_hmac === null) return;
    }
    const scope = SCOPE.getStore();
    const principal = scope?.request.principal;
    if (scope === undefined || principal === undefined) throw required();
    // Do not let a caller accidentally check one authenticated user and execute for another.
    if (command.appId !== principal.app_id || command.actor.userId !== principal.uid) {
      throw required();
    }
    const device = scope.request.verifiedDevice;
    if (
      device !== undefined &&
      (device.appId !== principal.app_id || device.deviceId !== principal.device_id)
    ) {
      throw required();
    }
    const token = scope.request.headers['x-step-up-token'];
    if (typeof token !== 'string' || token.length === 0) throw required();
    const claims = await verify(token);
    if (
      claims.uid !== principal.uid ||
      claims.app_id !== principal.app_id ||
      claims.device_id !== principal.device_id ||
      claims.action !== action
    ) {
      throw required();
    }
    const remainingMs = claims.exp * 1000 - options.clock.now().getTime();
    if (remainingMs <= 0) throw required();
    // One wrapper is one business request; never replace an outstanding reservation.
    if (scope.settle !== undefined) throw unavailable();
    const owner = randomUUID();
    const ttlSeconds = Math.ceil(remainingMs / 1000);
    let reserved: unknown;
    try {
      if (options.redis === null) throw unavailable();
      reserved = await options.redis.namespace('step_up').eval(RESERVE, {
        keys: [claims.jti],
        args: [owner, String(ttlSeconds * 1000 - remainingMs)],
        ttlSeconds,
      });
    } catch {
      // Do not expose Redis errors or token-derived keys to the HTTP error logger.
      throw unavailable();
    }
    if (reserved === 0) throw required();
    if (reserved !== 1) throw unavailable();
    scope.summary = claims.summary;
    scope.settle = async (success) => {
      try {
        await options.redis!.namespace('step_up').eval(SETTLE, {
          keys: [claims.jti],
          args: [owner, success ? 'consume' : 'release'],
          ttlSeconds,
        });
      } catch {
        options.logger.warn({ event: 'step_up_settlement_failed' }, 'step-up settlement failed');
      }
    };
  };
}

/**
 * The entry for the business handlers of the three x-step-up operations: `execute` is the
 * controller's own idempotency.executeInTransaction call. Runs it with this request's step-up
 * context (what stage ⑫ judges), then settles a reservation stage ⑫ made: the response of source
 * 'handler' with HTTP 2xx and code 0 consumes the token; any other response or a rejection releases
 * this request's reservation (a rejection is rethrown unchanged). `execute` receives the
 * StepUpContext of this request (B1-02zzzb: the judged token's business digest). A replay or an envelope built by
 * the idempotency module made no reservation and settles nothing. The response is returned
 * unchanged.
 */
export function withStepUp(
  request: StepUpHttpRequest,
  execute: (context: StepUpContext) => Promise<IdempotentResponse>,
): Promise<IdempotentResponse> {
  const scope: StepUpScope = { request };
  const context: StepUpContext = Object.freeze({ summary: () => scope.summary ?? null });
  return SCOPE.run(scope, async () => {
    let success = false;
    try {
      const response = await execute(context);
      if (response.source === 'handler' && response.status >= 200 && response.status < 300) {
        const envelope: unknown = JSON.parse(response.body);
        success =
          typeof envelope === 'object' &&
          envelope !== null &&
          'code' in envelope &&
          envelope.code === 0;
      }
      return response;
    } finally {
      await scope.settle?.(success);
    }
  });
}
