// Nest wrapper of the admin module. It provides the platform audit port globally, so any
// module can `@Inject(AUDIT_PORT)` without importing admin (规划/02 §4.1 dependency direction),
// and the durable TOTP replay store (admin_users.totp_last_step) for admin's own later use.
// The console login, first binding and admin_token check (F1-06k) are AdminAuthModule
// (./admin-auth.module.ts, admin entry only), as are step-up and me/permissions (F1-06l).
// B1-10t (编排 D10-1539): AdminAgentReportsModule mounts the agent report handling route
// (adminHandleAgentReport) on the admin entry only; admin owns its transaction and its audit row.
// B1-10w (编排 D10-1401): AdminDashboardModule mounts the workbench read (adminGetDashboard) on
// the admin entry only, with one content config reader per process for its status switches.
import { type DynamicModule, Global, Module } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import { createContentReader } from '../content/index.ts';
import {
  AUDIT_PORT,
  CLOCK,
  DB,
  SENSITIVE_KEYS,
  type AuditPort,
  type Clock,
} from '../platform/index.ts';
import {
  createAgentReportHandler,
  type AgentReportHandler,
} from './application/agent-report-handle.ts';
import type { AdminDashboardDeps } from './application/dashboard.ts';
import type { TotpReplayStore } from './domain/totp.ts';
import {
  ADMIN_AGENT_REPORT_HANDLE,
  AdminAgentReportHandleController,
} from './http/admin/agent-reports.controller.ts';
import {
  ADMIN_DASHBOARD_DEPS,
  AdminDashboardController,
} from './http/admin/dashboard.controller.ts';
import { createAdminDisplayNameReader } from './infra/admin-display-names.ts';
import { createAuditWriter } from './infra/audit-writer.ts';
import { createPgTotpReplayStore } from './infra/totp-replay-pg.ts';

/** Nest token of admin's TotpReplayStore (admin-internal; the durable PG store). */
export const TOTP_REPLAY_STORE = Symbol('TOTP_REPLAY_STORE');

/** Without a database (isolated HTTP unit tests) the port exists but refuses every write. */
function unavailableAuditPort(): AuditPort {
  return {
    append(): Promise<void> {
      return Promise.reject(new Error('audit port: no database configured for this process'));
    },
  };
}

/** Without a database no code can be consumed: verification fails closed. */
function unavailableReplayStore(): TotpReplayStore {
  return {
    consume(): Promise<boolean> {
      return Promise.reject(
        new Error('totp replay store: no database configured for this process'),
      );
    },
  };
}

@Global()
@Module({
  providers: [
    {
      provide: AUDIT_PORT,
      inject: [CLOCK, { token: DB, optional: true }],
      useFactory: (clock: Clock, db: Kysely<Database> | undefined): AuditPort =>
        db === undefined
          ? unavailableAuditPort()
          : createAuditWriter({ db, clock, sensitiveKeys: SENSITIVE_KEYS }),
    },
    {
      provide: TOTP_REPLAY_STORE,
      inject: [{ token: DB, optional: true }],
      useFactory: (db: Kysely<Database> | undefined): TotpReplayStore =>
        db === undefined ? unavailableReplayStore() : createPgTotpReplayStore({ db }),
    },
  ],
  exports: [AUDIT_PORT],
})
export class AdminModule {}

/**
 * The agent report handling route (B1-10t, CT-24zzi adminHandleAgentReport), admin entry only
 * (app.module): guarded by platform's AdminOperationGuard (agent.report, no step-up), which
 * adminAuthModule provides on that entry. Without the database the route registers and fails
 * closed (50001).
 */
@Module({})
export class AdminAgentReportsModule {
  static forAdmin(): DynamicModule {
    return {
      module: AdminAgentReportsModule,
      controllers: [AdminAgentReportHandleController],
      providers: [
        {
          provide: ADMIN_AGENT_REPORT_HANDLE,
          inject: [CLOCK, { token: DB, optional: true }],
          useFactory: (
            clock: Clock,
            db: Kysely<Database> | undefined,
          ): AgentReportHandler | null =>
            db === undefined
              ? null
              : createAgentReportHandler({
                  db,
                  clock,
                  auditOn: (trx: Transaction<Database>) =>
                    createAuditWriter({ db: trx, clock, sensitiveKeys: SENSITIVE_KEYS }),
                  namesOn: (trx: Transaction<Database>) => createAdminDisplayNameReader(trx),
                }),
        },
      ],
    };
  }
}

/**
 * The workbench read (B1-10w, adminGetDashboard), admin entry only (app.module): guarded by
 * platform's AdminOperationGuard (dashboard.view, read only, no step-up), which adminAuthModule
 * provides on that entry. Read only, no audit row. Without the database the route registers and
 * fails closed (50001).
 */
@Module({})
export class AdminDashboardModule {
  static forAdmin(): DynamicModule {
    return {
      module: AdminDashboardModule,
      controllers: [AdminDashboardController],
      providers: [
        {
          provide: ADMIN_DASHBOARD_DEPS,
          inject: [CLOCK, { token: DB, optional: true }],
          useFactory: (
            clock: Clock,
            db: Kysely<Database> | undefined,
          ): AdminDashboardDeps | null => {
            if (db === undefined) return null;
            const reader = createContentReader({ db, clock });
            return {
              db,
              clock,
              config: async (appId: string, key: string) =>
                (await reader.configValue(appId, key))?.value,
            };
          },
        },
      ],
    };
  }
}
