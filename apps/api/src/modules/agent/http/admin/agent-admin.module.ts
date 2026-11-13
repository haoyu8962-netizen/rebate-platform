// B1-10q: the agent module's admin entry mount (the trace console, CT-24zzi). Mounted by app.module
// on the admin entry only, next to FeedbackAdminModule. The controller is guarded by platform's
// AdminOperationGuard (agent.trace, read only, no step-up); the detail's audit record goes through
// platform's AUDIT_PORT, provided globally by the admin module on this entry. Without the database
// or the audit port every call fails closed (50001).
// B1-10t adds the report list and handling (agent.trace / agent.report): the handling's audit
// record is written by admin's writer bound to the handling's transaction and the handlers'
// display names come from admin's reader, both passed in by app.module (agent never imports
// admin); the report column write is agent's own port (application/agent-report.ts).
import type { DB as Database } from '@couli/db';
import { type DynamicModule, Module } from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import { AUDIT_PORT, CLOCK, DB, type AuditPort, type Clock } from '../../../platform/index.ts';
import { createAgentReportAdminPort } from '../../application/agent-report.ts';
import {
  createAdminReportService,
  type AdminDisplayNames,
  type AdminReportService,
} from '../../application/admin-reports.ts';
import { createAdminTraceReaders, type AdminTraceReaders } from '../../application/admin-traces.ts';
import { ADMIN_AGENT_REPORTS, AdminAgentReportsController } from './agent-reports.controller.ts';
import {
  ADMIN_AGENT_TRACES_READERS,
  AdminAgentTracesController,
} from './agent-traces.controller.ts';

export interface AgentAdminOptions {
  /** Binds the audit port to a transaction handle (app.module: admin's createAuditWriter). */
  readonly auditWriter: (db: Kysely<Database>, clock: Clock) => AuditPort;
  /** admin's display name reader over a handle (app.module: admin's createAdminDisplayNameReader). */
  readonly adminNames: (db: Kysely<Database>) => AdminDisplayNames;
}

export class AgentAdminModule {
  static forAdmin(options: AgentAdminOptions): DynamicModule {
    return {
      module: AgentAdminModule,
      controllers: [AdminAgentTracesController, AdminAgentReportsController],
      providers: [
        {
          provide: ADMIN_AGENT_TRACES_READERS,
          inject: [CLOCK, { token: DB, optional: true }, { token: AUDIT_PORT, optional: true }],
          useFactory: (
            clock: Clock,
            db: Kysely<Database> | undefined,
            audit: AuditPort | undefined,
          ): AdminTraceReaders | null =>
            db === undefined || audit === undefined
              ? null
              : createAdminTraceReaders({ db, clock, audit }),
        },
        {
          provide: ADMIN_AGENT_REPORTS,
          inject: [CLOCK, { token: DB, optional: true }],
          useFactory: (
            clock: Clock,
            db: Kysely<Database> | undefined,
          ): AdminReportService | null =>
            db === undefined
              ? null
              : createAdminReportService({
                  db,
                  clock,
                  reports: createAgentReportAdminPort({ clock }),
                  auditOn: (trx: Transaction<Database>) => options.auditWriter(trx, clock),
                  adminNames: options.adminNames,
                }),
        },
      ],
    };
  }
}

Module({})(AgentAdminModule);
