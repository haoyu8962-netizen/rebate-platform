// identity on the worker entry (task B1-15f §9.2 #1): the scheduled processing of deletion requests
// whose cooling period has ended. app.module imports this module on `worker` only, beside
// IdentityWorkerModule (whose forWorker options stay as they are); entry.ts starts the timer after
// the payout verification recheck (startDeletionExpiry with deletionExpiryToken()). Without a
// database deletionExpiryToken() provides null and one info line is logged.
// The module and the option factories app.module passes depend only on the platform tokens CLOCK,
// ROOT_LOGGER, APP_CONFIG and (optional) DB, like IdentityWorkerModule.
// The withdrawal port is app.module's truthful "no withdrawal" implementation until B2-05
// (hasNonTerminal answers false; TODO(规划/11 §2.3) there — blocked on B2-05); the balance port is
// the one app.module assembles for B1-15d over the ledger's getBalances, on the caller's transaction.
//
// B1-15g: the same token's runner also does the processing round (cleanup, Apple revocation, done)
// — no second timer. Each round runs processing first and the cooling-period expiry second, so a
// request the expiry moves to processing is cleaned in the next round. The processing ports come
// from app.module's factories (cleanup ports, closing adjustment, paid-out withdrawals, Apple
// revoker, push unbinding); FIELD_CRYPTO is optional (without it an Apple attempt counts as failed).
// B1-27h: EXPORT_STORE (optional) is the private store of the personal information copies, whose
// files of the user the processing round deletes after the cleanup.
//
// Also compiled by the `test` project: a class decorator only (dependencies through factories).
import { type DynamicModule, type FactoryProvider, Module } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  CLOCK,
  DB,
  EXPORT_STORE,
  FIELD_CRYPTO,
  ROOT_LOGGER,
  type Clock,
  type ExportStore,
  type FieldCrypto,
  type RootLogger,
} from '../platform/index.ts';
import {
  createDeletionExpiry,
  deletionExpiryToken,
  type DeletionCalendarConfigReader,
  type DeletionExpiry,
} from './application/deletion-expiry.ts';
import {
  createDeletionProcessing,
  type DeletionProcessing,
} from './application/deletion-processing.ts';
import type { AfterSessionsRevoked } from './application/revoke-sessions.ts';
import type { AppleTokenRevoker } from './ports/apple-token-revoker.ts';
import type { DeletionBalanceReader } from './ports/deletion-balance.ts';
import type { DeletionClosingAdjustmentPrefill } from './ports/closing-adjustment-prefill.ts';
import type { DeletionProgressNotice } from './ports/deletion-progress-notice.ts';
import type {
  DeletionCleanupPorts,
  DeletionClosingAdjustmentReader,
} from './ports/deletion-cleanup.ts';
import type {
  WithdrawalNonTerminalReader,
  WithdrawalSucceededReader,
} from './ports/withdrawal-in-flight.ts';

export interface IdentityDeletionExpiryModuleOptions {
  readonly calendarConfig: Omit<FactoryProvider<DeletionCalendarConfigReader>, 'provide'>;
  /** hasNonTerminal for the expiry, hasSucceeded for the processing round's real-name step. */
  readonly withdrawals: Omit<
    FactoryProvider<WithdrawalNonTerminalReader & WithdrawalSucceededReader>,
    'provide'
  >;
  readonly balance: Omit<FactoryProvider<DeletionBalanceReader>, 'provide'>;
  /** B1-15g: the owning modules' cleanup ports (or the unavailable markers). */
  readonly cleanup: Omit<FactoryProvider<DeletionCleanupPorts>, 'provide'>;
  /** B1-15g: the closing adjustment gate of the completion. */
  readonly funds: Omit<FactoryProvider<DeletionClosingAdjustmentReader>, 'provide'>;
  /** B1-15g: Sign in with Apple revocation. */
  readonly apple: Omit<FactoryProvider<AppleTokenRevoker>, 'provide'>;
  /** B1-15g: the push token unbinding of the sessions the cleanup revokes. */
  readonly afterRevoked: Omit<FactoryProvider<AfterSessionsRevoked>, 'provide'>;
  /**
   * B1-15i: the DELETION_PROGRESS cancelled_negative inbox message (BR-TEXT-23) over notification.
   * Missing → the expiry writes no message.
   */
  readonly deletionProgress?: Omit<FactoryProvider<DeletionProgressNotice | null>, 'provide'>;
  /**
   * B2-12d (BR-FUND-24 ⑧, D10-590 ③): the system-prefilled ACCOUNT_CLOSED decrease, written by the
   * expiry when a request with a balance enters processing and rebuilt by the processing round
   * while the closing gate is pending. Missing → no form is prefilled.
   */
  readonly closingPrefill?: Omit<
    FactoryProvider<DeletionClosingAdjustmentPrefill | null>,
    'provide'
  >;
}

/** One round: processing first, then the cooling-period expiry (brief B1-15g §9.2 #1). */
function combined(
  processing: DeletionProcessing,
  expiry: DeletionExpiry,
  logger: RootLogger,
): DeletionExpiry {
  return Object.freeze({
    async runOnce(stopping: () => boolean = () => false): Promise<{ scanned: number }> {
      let processed = 0;
      try {
        processed = (await processing.runOnce(stopping)).scanned;
      } catch (error) {
        // A failed processing round (its scan) does not keep the expiry from running.
        logger.warn(
          { error_name: error instanceof Error ? error.name : typeof error },
          'identity_deletion_processing_failed',
        );
      }
      if (stopping()) return { scanned: processed };
      const expired = await expiry.runOnce(stopping);
      return { scanned: processed + expired.scanned };
    },
  });
}

const CALENDAR_CONFIG = Symbol('IDENTITY_DELETION_EXPIRY_CALENDAR_CONFIG');
const WITHDRAWALS = Symbol('IDENTITY_DELETION_EXPIRY_WITHDRAWALS');
const BALANCE = Symbol('IDENTITY_DELETION_EXPIRY_BALANCE');
const CLEANUP = Symbol('IDENTITY_DELETION_PROCESSING_CLEANUP');
const FUNDS = Symbol('IDENTITY_DELETION_PROCESSING_FUNDS');
const APPLE = Symbol('IDENTITY_DELETION_PROCESSING_APPLE');
const AFTER_REVOKED = Symbol('IDENTITY_DELETION_PROCESSING_AFTER_REVOKED');
const DELETION_PROGRESS = Symbol('IDENTITY_DELETION_EXPIRY_PROGRESS_NOTICE');
const CLOSING_PREFILL = Symbol('IDENTITY_DELETION_CLOSING_PREFILL');

@Module({})
export class IdentityDeletionExpiryModule {
  static forWorker(options: IdentityDeletionExpiryModuleOptions): DynamicModule {
    return {
      module: IdentityDeletionExpiryModule,
      providers: [
        { ...options.calendarConfig, provide: CALENDAR_CONFIG },
        { ...options.withdrawals, provide: WITHDRAWALS },
        { ...options.balance, provide: BALANCE },
        { ...options.cleanup, provide: CLEANUP },
        { ...options.funds, provide: FUNDS },
        { ...options.apple, provide: APPLE },
        { ...options.afterRevoked, provide: AFTER_REVOKED },
        options.deletionProgress === undefined
          ? { provide: DELETION_PROGRESS, useValue: null }
          : { ...options.deletionProgress, provide: DELETION_PROGRESS },
        options.closingPrefill === undefined
          ? { provide: CLOSING_PREFILL, useValue: null }
          : { ...options.closingPrefill, provide: CLOSING_PREFILL },
        {
          provide: deletionExpiryToken(),
          inject: [
            CLOCK,
            ROOT_LOGGER,
            CALENDAR_CONFIG,
            WITHDRAWALS,
            BALANCE,
            CLEANUP,
            FUNDS,
            APPLE,
            AFTER_REVOKED,
            DELETION_PROGRESS,
            CLOSING_PREFILL,
            { token: DB, optional: true },
            { token: FIELD_CRYPTO, optional: true },
            { token: EXPORT_STORE, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            calendar: DeletionCalendarConfigReader,
            withdrawals: WithdrawalNonTerminalReader & WithdrawalSucceededReader,
            balance: DeletionBalanceReader,
            cleanup: DeletionCleanupPorts,
            funds: DeletionClosingAdjustmentReader,
            apple: AppleTokenRevoker,
            afterRevoked: AfterSessionsRevoked,
            notice: DeletionProgressNotice | null,
            prefill: DeletionClosingAdjustmentPrefill | null,
            db?: Kysely<Database>,
            crypto?: FieldCrypto,
            store?: ExportStore,
          ): DeletionExpiry | null => {
            if (db === undefined) {
              logger.info({}, 'identity_deletion_expiry_disabled');
              return null;
            }
            const expiry = createDeletionExpiry({
              db,
              clock,
              logger,
              withdrawals,
              balance,
              calendar,
              notice: notice ?? null,
              prefill: prefill ?? null,
            });
            const processing = createDeletionProcessing({
              db,
              clock,
              logger,
              ...(crypto === undefined || crypto === null ? {} : { crypto }),
              cleanup,
              funds,
              prefill: prefill ?? null,
              withdrawals,
              apple,
              afterRevoked,
              // B1-27h (BR-ID-40 细则「副本请求与注销状态」): the copy files of the user are deleted.
              ...(store === undefined ? {} : { dataCopyStore: store }),
            });
            return combined(processing, expiry, logger);
          },
        },
      ],
      exports: [deletionExpiryToken()],
    };
  }
}
