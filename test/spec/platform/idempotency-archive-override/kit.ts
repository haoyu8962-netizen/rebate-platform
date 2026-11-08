// Shared helpers of the B1-01zzs rule tests: the archive override of executeInTransaction
// (orchestrator D10-1099 Q-6 (B); 规划/04 §3.2 sessions「token 只存哈希」; contract in
// apps/api/src/modules/platform/idempotency/archive.ts). As in B1-01zzf, only a test-side
// structural type is added (ArchivingIdempotency): the current factory loads unchanged and the
// tests go red on behaviour. Expected bodies are written out by hand, never taken from the
// implementation. Nothing here imports the test-database base (`@couli/db/testing`).
import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { IdempotencyArchiveOptions } from '../../../../apps/api/src/modules/platform/idempotency/archive.ts';
import type {
  HandlerResult,
  IdempotentRequest,
  IdempotentResponse,
  ResponseEnvelope,
} from '../../../../apps/api/src/modules/platform/idempotency/index.ts';
import { TRACE, USER_B, request as idemRequest, sha256Hex } from '../idempotency/kit.ts';

/** executeInTransaction with the optional third argument of the contract. */
export interface ArchivingIdempotency {
  executeInTransaction(
    request: IdempotentRequest,
    handler: (trx: Transaction<DB>) => Promise<HandlerResult>,
    options?: IdempotencyArchiveOptions,
  ): Promise<IdempotentResponse>;
}

export const MERGE_PATH = '/v1/auth/merge';
export const MERGE_BODY = { merge_ticket: 'b101zzs-rule-test-merge-ticket' };
/** sha256 of the canonical MERGE_BODY, written out by hand. */
export const MERGE_HASH = sha256Hex('{"merge_ticket":"b101zzs-rule-test-merge-ticket"}');

/** POST /v1/auth/merge of user A (the source account) with `key`. */
export function mergeRequest(
  key: string,
  overrides: Partial<IdempotentRequest> = {},
): IdempotentRequest {
  return idemRequest({ method: 'POST', path: MERGE_PATH, key, body: MERGE_BODY, ...overrides });
}

/** The tokens object of LoginResponse (contracts/openapi.yaml mergeAccount 200). */
export interface Tokens {
  readonly access_token: string;
  readonly access_expires_at: string;
  readonly refresh_token: string;
  readonly refresh_expires_at: string;
  readonly session_scope: 'full';
}

let tokenSeq = 0;
/** Distinct token values per call, so a string search finds only the ones of one test case. */
export function freshTokens(): Tokens {
  tokenSeq += 1;
  const seed = `b101zzs:${String(process.pid)}:${String(tokenSeq)}`;
  return {
    access_token: `at1_${sha256Hex(`access:${seed}`)}`,
    access_expires_at: '2031-05-06T17:08:09+08:00',
    refresh_token: `rt1_${sha256Hex(`refresh:${seed}`)}`,
    refresh_expires_at: '2031-06-05T15:08:09+08:00',
    session_scope: 'full',
  };
}

/** The merge success envelope (target account USER_B) carrying `tokens`. */
export function loginEnvelope(tokens: Tokens, code = 0, msg = ''): ResponseEnvelope {
  return { code, msg, data: { user_id: USER_B, is_new_user: false, tokens }, trace_id: TRACE };
}

/** JSON.stringify of loginEnvelope(tokens, code, msg), or of its archive (tokens null), by hand. */
export function loginBody(tokens: Tokens | null, code = 0, msg = ''): string {
  const inner =
    tokens === null
      ? 'null'
      : `{"access_token":"${tokens.access_token}","access_expires_at":"${tokens.access_expires_at}","refresh_token":"${tokens.refresh_token}","refresh_expires_at":"${tokens.refresh_expires_at}","session_scope":"full"}`;
  return `{"code":${String(code)},"msg":"${msg}","data":{"user_id":"${USER_B}","is_new_user":false,"tokens":${inner}},"trace_id":"${TRACE}"}`;
}

/** What the merge route archives: a new envelope, same keys in the same order, data.tokens null. */
export function nullTokens(envelope: ResponseEnvelope): ResponseEnvelope {
  const data = envelope.data as Record<string, unknown>;
  return {
    code: envelope.code,
    msg: envelope.msg,
    data: { ...data, tokens: null },
    trace_id: envelope.trace_id,
  };
}

/** An archive option that records a copy of every envelope it is given. */
export function archiveSpy(
  transform: (envelope: ResponseEnvelope) => ResponseEnvelope = nullTokens,
): { options: IdempotencyArchiveOptions; seen: unknown[] } {
  const seen: unknown[] = [];
  return {
    options: {
      archive: (envelope) => {
        seen.push(structuredClone(envelope));
        return transform(envelope);
      },
    },
    seen,
  };
}

/** Rows of app.idempotency_keys (any key, any app) whose whole row as text contains `needle`. */
export async function rowsContaining(db: Kysely<DB>, needle: string): Promise<number> {
  const result = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM app.idempotency_keys AS t WHERE strpos(t::text, ${needle}) > 0
  `.execute(db);
  return Number(result.rows[0]?.n ?? '-1');
}

/** Rows containing the access or the refresh token of `tokens` (0 = neither is stored anywhere). */
export async function rowsWithTokens(db: Kysely<DB>, tokens: Tokens): Promise<number> {
  return (
    (await rowsContaining(db, tokens.access_token)) +
    (await rowsContaining(db, tokens.refresh_token))
  );
}
