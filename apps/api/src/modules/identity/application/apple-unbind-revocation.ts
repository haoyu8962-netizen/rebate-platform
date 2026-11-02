// The Apple revocation after a console phone change unbound an Apple identity (规划/08 BR-WDR-01 细则
// 「清除标记只走人工」, BR-ID-28; contract adminEditUserProfile「Pending re-verification」, CT-26j; 编排
// D10-513 ④; task B1-02zw). Outside any transaction: the phone-change transaction deleted the binding
// and wrote one job carrying the refresh token only as the stored cipher; this handler decrypts it
// at call time (APPLE_REFRESH_TOKEN_CONTEXT) and calls the port. As the deletion flow counts them
// (deletion-processing.ts revokeApple): a failed attempt is retried, the third one is final with one
// warn line carrying app_id, and nothing here touches the phone change. Neither the token nor the
// error reaches a log line.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { FieldCrypto, JobHandler, JobQueue, RootLogger } from '../../platform/index.ts';
import { APPLE_REFRESH_TOKEN_CONTEXT } from '../infra/oauth-accounts.ts';
import type { AppleTokenRevoker } from '../ports/apple-token-revoker.ts';
import { DATA_COPY_QUEUE } from './data-copy-worker.ts';

/** The job's name on identity's data-copy queue (worker entry; identity-worker.module routes it). */
export const APPLE_UNBIND_REVOKE_JOB = 'apple_unbind_revoke';
/** BR-ID-27 as deletion-processing.ts counts it: the third failed attempt is final. */
const APPLE_MAX_ATTEMPTS = 3;

export interface AppleUnbindRevocationOptions {
  readonly crypto: FieldCrypto;
  readonly apple: AppleTokenRevoker;
  readonly logger: Pick<RootLogger, 'warn'>;
}

export interface AppleUnbindRevocation {
  readonly handle: JobHandler;
}

/** One job on the caller's transaction, so a rolled-back save leaves none. */
export async function enqueueAppleUnbindRevocation(
  queue: Pick<JobQueue, 'send'>,
  trx: Transaction<DB>,
  input: { readonly appId: string; readonly cipher: Uint8Array },
): Promise<void> {
  await queue.send(
    DATA_COPY_QUEUE,
    APPLE_UNBIND_REVOKE_JOB,
    { appId: input.appId, cipher: Buffer.from(input.cipher).toString('utf8') },
    { trx },
  );
}

export function createAppleUnbindRevocation(
  options: AppleUnbindRevocationOptions,
): AppleUnbindRevocation {
  const { crypto, apple, logger } = options;
  const handle: JobHandler = async (job) => {
    const appId = job.payload['appId'];
    const cipher = job.payload['cipher'];
    if (typeof appId !== 'string' || appId === '' || typeof cipher !== 'string' || cipher === '') {
      logger.warn({ job_id: job.id }, 'identity_apple_unbind_job_invalid');
      return;
    }
    try {
      const refreshToken = crypto.decrypt(cipher, APPLE_REFRESH_TOKEN_CONTEXT);
      await apple.revoke({ appId, refreshToken });
    } catch {
      // The error may carry the token or Apple's answer: nothing of it leaves this block.
      if (job.attempt < APPLE_MAX_ATTEMPTS) {
        throw new Error('identity: Apple unbind revocation attempt failed');
      }
      logger.warn({ app_id: appId, job_id: job.id }, 'identity_apple_unbind_revoke_failed');
    }
  };
  return Object.freeze({ handle });
}
