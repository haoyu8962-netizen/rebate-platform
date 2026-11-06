// risk's rule list console (B1-03zg, CT-24f): GET /admin/v1/risk-rules and POST
// /admin/v1/risk-rules/{rule_id}/enable|disable. app.module imports this module on the admin
// entry only. Permission and step-up checks go through platform's AdminOperationGuard, which the
// admin module provides on the admin entry (risk never imports admin); the audit writer bound to
// the change's transaction comes from app.module (admin's createAuditWriter). Without a database
// (isolated HTTP unit tests) the routes still register and every call fails closed (50001).
//
// Also compiled by the `test` project: a class decorator only (no parameter decorators or
// parameter properties; dependencies are injected through factories).
import { type DynamicModule, Module } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import {
  CLOCK,
  DB,
  ROOT_LOGGER,
  type AuditPort,
  type Clock,
  type RootLogger,
} from '../../../platform/index.ts';
import { AdminRiskRules } from '../../application/admin-risk-rules.ts';
import { AdminRiskRulesController } from './risk-rules.controller.ts';

export interface RiskRulesAdminOptions {
  /** Binds the audit port to a transaction handle (app.module: admin's createAuditWriter). */
  readonly auditWriter: (db: Kysely<Database>, clock: Clock) => AuditPort;
}

/** Stands in for the service when the entry has no database: fails closed. */
function unavailable(): AdminRiskRules {
  const fail = () => Promise.reject(new Error('risk: risk rules need the database'));
  return { list: fail, change: fail } as unknown as AdminRiskRules;
}

@Module({})
export class RiskRulesAdminModule {
  static forAdmin(options: RiskRulesAdminOptions): DynamicModule {
    return {
      module: RiskRulesAdminModule,
      controllers: [AdminRiskRulesController],
      providers: [
        {
          provide: AdminRiskRules,
          inject: [CLOCK, ROOT_LOGGER, { token: DB, optional: true }],
          useFactory: (clock: Clock, logger: RootLogger, db?: Kysely<Database>): AdminRiskRules =>
            db === undefined
              ? unavailable()
              : new AdminRiskRules({
                  db,
                  clock,
                  logger,
                  auditOn: (trx: Transaction<Database>) => options.auditWriter(trx, clock),
                }),
        },
      ],
    };
  }
}
