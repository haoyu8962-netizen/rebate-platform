// B1-10q: the agent module's admin entry mount (the trace console, CT-24zzi). Mounted by app.module
// on the admin entry only, next to FeedbackAdminModule. The controller is guarded by platform's
// AdminOperationGuard (agent.trace, read only, no step-up); the detail's audit record goes through
// platform's AUDIT_PORT, provided globally by the admin module on this entry. Without the database
// or the audit port every call fails closed (50001).
// B1-10t adds the report list (agent.trace): the handlers' display names come from admin's reader,
// which app.module binds to the pool and provides here (adminNames); agent calls it with ids only
// and never hands it a database handle (BR-AI-02 ③, 编排 D10-1539). The report handling
// (adminHandleAgentReport) is admin's own route (admin/http/admin/agent-reports.controller.ts).
import type { DB as Database } from '@couli/db';
import { type DynamicModule, type FactoryProvider, Module } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { AUDIT_PORT, CLOCK, DB, type AuditPort, type Clock } from '../../../platform/index.ts';
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

/** Nest token of the handlers' display name reader (null in a process without the database). */
export const ADMIN_AGENT_REPORT_NAMES = Symbol('AGENT_ADMIN_REPORT_NAMES');

export interface AgentAdminOptions {
  /**
   * The provider of admin's display name reader, already bound to the pool (app.module:
   * createAdminDisplayNameReader(db); null without the database). Nest builds it; agent only
   * injects its value.
   */
  readonly adminNames: Omit<FactoryProvider<AdminDisplayNames | null>, 'provide'>;
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
        { ...options.adminNames, provide: ADMIN_AGENT_REPORT_NAMES },
        {
          provide: ADMIN_AGENT_REPORTS,
          inject: [CLOCK, { token: DB, optional: true }, ADMIN_AGENT_REPORT_NAMES],
          useFactory: (
            clock: Clock,
            db: Kysely<Database> | undefined,
            names: AdminDisplayNames | null,
          ): AdminReportService | null =>
            db === undefined || names === null
              ? null
              : createAdminReportService({ db, clock, names }),
        },
      ],
    };
  }
}

Module({})(AgentAdminModule);
