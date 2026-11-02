// Consume the attempt before exchanging credentials. All database writes then share one
// READ COMMITTED transaction; a provider failure or rollback never restores the attempt.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import { newUuidV7, type RootLogger } from '../../platform/index.ts';
import { deviceHashOf, type LoginAccount } from '../infra/login-accounts.ts';
import { findOauthAccount, replaceAppleRefreshToken } from '../infra/oauth-accounts.ts';
import { lockDeviceRegistrations } from '../infra/registration-store.ts';
import {
  completeLogin,
  type LoginCommand,
  type LoginCompletionOptions,
} from './login-completion.ts';
import type { OauthAttemptService } from './oauth-attempts.ts';
import { readDormantReverifyDays } from './reverify-activity.ts';
import { snapshotRegistrationConfig, type RegistrationService } from './registration.ts';
import { sessionScope, type MinimumVersionReader } from './session-scope.ts';
import type { SmsConfigReader } from './sms-codes.ts';
import type { ThirdPartyIdentity, ThirdPartyIdentityPort } from './step-up.ts';

type Provider = 'wechat' | 'apple';
export type OauthLoginCommand = Omit<LoginCommand, 'body'> & {
  readonly channel?: string;
  readonly version?: string;
} & (
    | { readonly provider: 'wechat'; readonly body: Schema<'LoginByWechatRequest'> }
    | { readonly provider: 'apple'; readonly body: Schema<'LoginByAppleRequest'> }
  );
export type OauthLoginResult =
  | { readonly code: 0; readonly data: Schema<'LoginData'> }
  | { readonly code: 20004 | 50001 }
  | { readonly code: 50305; readonly data: { readonly provider: Provider } }
  | { readonly code: 10007; readonly data: { readonly stage: 'processing' } }
  | { readonly code: 44001; readonly data?: { readonly risk_msg_code: string } }
  | {
      readonly code: 10405;
      readonly data: {
        readonly reason: 'no_account';
        readonly min_supported_version: string | null;
      };
    };

export interface OauthLoginOptions extends LoginCompletionOptions {
  readonly db: Kysely<DB>;
  readonly logger: RootLogger;
  readonly versions: MinimumVersionReader;
  readonly config: SmsConfigReader;
  readonly attempts: Pick<OauthAttemptService, 'consume'>;
  readonly thirdPartyIdentity?: ThirdPartyIdentityPort;
  readonly registration: RegistrationService;
  readonly registrationBlocklist?: (
    trx: Transaction<DB>,
    input: { readonly app_id: string; readonly device_hash: string },
  ) => Promise<{
    readonly code: 44001;
    readonly data?: { readonly risk_msg_code: string };
  } | null>;
}
export interface OauthLoginService {
  login(command: OauthLoginCommand): Promise<OauthLoginResult>;
}

class LoginAbort extends Error {
  readonly result: Exclude<OauthLoginResult, { code: 0 }> | 'no_account';
  constructor(result: LoginAbort['result']) {
    super('identity: OAuth login rolled back');
    this.result = result;
  }
}

/** Only this collision means a concurrent first login won; never retry other failures. */
function identityCollision(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const pg = error as { code?: unknown; constraint?: unknown };
  return pg.code === '23505' && pg.constraint === 'user_oauth_identity_key';
}

export function createOauthLoginService(options: OauthLoginOptions): OauthLoginService {
  const { db, clock, crypto, logger, versions, attempts } = options;

  return {
    async login(command) {
      const { app_id: appId, provider, body } = command;
      const scope = await sessionScope(
        {
          appId,
          platform: command.platform,
          ...(command.channel === undefined ? {} : { channel: command.channel }),
          ...(command.version === undefined ? {} : { version: command.version }),
        },
        versions,
      );
      const consumed = await attempts.consume({
        app_id: appId,
        provider,
        purpose: 'login',
        device_id: command.device_id,
        attempt_id: body.attempt_id,
      });
      if (consumed.code !== 0) return { code: consumed.code };
      const unavailable = { code: 50305, data: { provider } } as const;
      if (options.thirdPartyIdentity === undefined) return unavailable;
      let exchanged: Awaited<ReturnType<ThirdPartyIdentityPort['exchange']>>;
      try {
        const credentials =
          command.provider === 'wechat'
            ? { provider: command.provider, code: command.body.code }
            : {
                provider: command.provider,
                identity_token: command.body.identity_token,
                authorization_code: command.body.authorization_code,
              };
        exchanged = await options.thirdPartyIdentity.exchange({
          ...credentials,
          nonce: consumed.data.nonce,
        });
      } catch {
        // Do not log provider errors: they can contain credentials or third-party tokens.
        return unavailable;
      }
      if (typeof exchanged !== 'object' || exchanged === null) {
        logger.warn({ provider }, 'third_party_identity_missing_union_id');
        return unavailable;
      }
      if ('invalid' in exchanged) return { code: 20004 };
      if ('unavailable' in exchanged) return unavailable;
      if (typeof exchanged.union_id !== 'string' || exchanged.union_id.length === 0) {
        logger.warn({ provider }, 'third_party_identity_missing_union_id');
        return unavailable;
      }
      const identity: ThirdPartyIdentity = exchanged;
      // No second pool connection is acquired while a registration transaction is open.
      const config =
        scope === 'deletion_only'
          ? undefined
          : await snapshotRegistrationConfig(options.config, appId);
      const dormantReverifyDays = await readDormantReverifyDays(options.config, appId);
      const loginCommand = { ...command, dormantReverifyDays };

      async function signIn(
        trx: Transaction<DB>,
        account: LoginAccount & { status: string },
        isNew: boolean,
      ): Promise<Schema<'LoginData'>> {
        if (account.status === 'deleting') {
          throw new LoginAbort({ code: 10007, data: { stage: 'processing' } });
        }
        // A retained binding to a deleted account must never resurrect that account.
        if (account.status === 'deleted') throw new LoginAbort({ code: 50001 });
        if (provider === 'apple' && identity.apple_refresh_token !== undefined) {
          await replaceAppleRefreshToken(
            trx,
            {
              app_id: appId,
              user_id: account.id,
              union_id: identity.union_id,
              refresh_token: identity.apple_refresh_token,
            },
            { clock, crypto },
          );
        }
        return {
          user_id: account.id,
          is_new_user: isNew,
          tokens: await completeLogin(trx, loginCommand, account, scope, provider, options),
        };
      }

      async function inTransaction(
        trx: Transaction<DB>,
        rereadOnly: boolean,
      ): Promise<Schema<'LoginData'>> {
        let existing = await findOauthAccount(trx, appId, provider, identity.union_id);
        if (existing !== undefined) return signIn(trx, existing, false);
        if (rereadOnly) throw new LoginAbort({ code: 50001 });
        if (scope === 'deletion_only') throw new LoginAbort('no_account');
        const deviceHash = await deviceHashOf(trx, appId, command.device_id);
        if (deviceHash === undefined) throw new LoginAbort({ code: 50001 });
        // A same-device contender must re-read after waiting, BEFORE checking its quota.
        await lockDeviceRegistrations(trx, appId, deviceHash);
        existing = await findOauthAccount(trx, appId, provider, identity.union_id);
        if (existing !== undefined) return signIn(trx, existing, false);
        const blocked = await options.registrationBlocklist?.(trx, {
          app_id: appId,
          device_hash: deviceHash,
        });
        if (blocked != null) {
          // D24: phone-less registration refusals roll back without a blocked_request audit.
          throw new LoginAbort({
            code: 44001,
            ...(blocked.data === undefined ? {} : { data: blocked.data }),
          });
        }
        const registered = await options.registration.register(trx, {
          app_id: appId,
          phone: null,
          register_method: provider,
          third_party_digest: crypto.blindIndex(
            `${provider}:${identity.union_id}`,
            'user_oauth.identity',
          ),
          device_hash: deviceHash,
          device_id: command.device_id,
          client_ip: command.client_ip,
          ...(command.channel === undefined ? {} : { channel: command.channel }),
          ...(config === undefined ? {} : { config }),
        });
        if ('outcome' in registered) throw new LoginAbort({ code: 50001 });
        if (registered.code === 44001) {
          // D24 applies to the device registration limit as well: there is no related phone.
          throw new LoginAbort({ code: 44001 });
        }
        if (registered.code !== 0) throw new LoginAbort({ code: 50001 });
        const now = clock.now();
        // A different device may win this unique key. Roll back the ENTIRE losing creation.
        await trx
          .insertInto('user_oauth')
          .values({
            id: newUuidV7(now),
            app_id: appId,
            user_id: registered.user_id,
            provider,
            union_id: identity.union_id,
            open_id: identity.open_id ?? null,
            created_at: now,
            updated_at: now,
          })
          .execute();
        return signIn(
          trx,
          { id: registered.user_id, parent_bind_source: null, status: 'normal' },
          true,
        );
      }

      try {
        let data: Schema<'LoginData'>;
        try {
          data = await db
            .transaction()
            .setIsolationLevel('read committed')
            .execute((trx) => inTransaction(trx, false));
        } catch (error) {
          if (!identityCollision(error)) throw error;
          data = await db
            .transaction()
            .setIsolationLevel('read committed')
            .execute((trx) => inTransaction(trx, true));
        }
        return { code: 0, data };
      } catch (error) {
        if (!(error instanceof LoginAbort)) {
          // Database messages may quote third-party identifiers; expose no error detail.
          logger.error({ provider }, 'oauth_login_failed');
          return { code: 50001 };
        }
        if (error.result !== 'no_account') return error.result;
        const minimum =
          command.channel === undefined
            ? null
            : await versions.minSupportedVersion(appId, command.platform, command.channel);
        return { code: 10405, data: { reason: 'no_account', min_supported_version: minimum } };
      }
    },
  };
}
