// B2-16d: growth's /admin/v1 routes, the console's read of the invite reward records (GET
// /admin/v1/invite-rewards, GET /admin/v1/invite-rewards/{invitee_id}; BR-INV-24, BR-ID-33).
// app.module imports this module on the admin entry only; the api and stream entries do not serve
// /admin/v1. Permission checks go through platform's AdminOperationGuard, which the admin module
// provides on the admin entry. identity's masked phones come in as a factory from app.module, so
// growth imports no identity code (growth AGENTS.md rules 4 and 6). Without a database the routes
// still register and every read fails closed (50001); module startup never touches the database.
//
// Also compiled by the `test` project (through ./index.ts): a class decorator only.
import { Module, type DynamicModule } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import { CLOCK, DB, FIELD_CRYPTO, type Clock, type FieldCrypto } from '../platform/index.ts';
import {
  createAdminInviteRewardsReader,
  type AdminInviteRewardsReader,
  type InviteRewardPhoneReader,
} from './application/admin-invite-rewards.ts';
import {
  ADMIN_INVITE_REWARDS_READER,
  AdminInviteRewardsController,
} from './http/admin/invite-rewards.controller.ts';

export interface GrowthAdminModuleOptions {
  /** identity's masked phones (decrypted and masked inside identity); building it reads nothing. */
  readonly phones: (db: Kysely<Database>, crypto: FieldCrypto | null) => InviteRewardPhoneReader;
}

@Module({})
export class GrowthAdminModule {
  static forAdmin(options: GrowthAdminModuleOptions): DynamicModule {
    return {
      module: GrowthAdminModule,
      controllers: [AdminInviteRewardsController],
      providers: [
        {
          provide: ADMIN_INVITE_REWARDS_READER,
          inject: [CLOCK, { token: DB, optional: true }, { token: FIELD_CRYPTO, optional: true }],
          useFactory: (
            clock: Clock,
            db?: Kysely<Database>,
            crypto?: FieldCrypto,
          ): AdminInviteRewardsReader | null =>
            db === undefined
              ? null
              : createAdminInviteRewardsReader({
                  db,
                  clock,
                  phones: options.phones(db, crypto ?? null),
                }),
        },
      ],
    };
  }
}
