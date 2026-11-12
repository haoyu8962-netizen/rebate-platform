// B1-10q: the agent module's admin entry mount (the trace console, CT-24zzi). Mounted by app.module
// on the admin entry only, next to FeedbackAdminModule. The controller is guarded by platform's
// AdminOperationGuard (agent.trace, read only, no step-up); the detail's audit record goes through
// platform's AUDIT_PORT, provided globally by the admin module on this entry. Without the database
// or the audit port every call fails closed (50001).
import type { DB as Database } from '@couli/db';
import { type DynamicModule, Module } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { AUDIT_PORT, CLOCK, DB, type AuditPort, type Clock } from '../../../platform/index.ts';
import { createAdminTraceReaders, type AdminTraceReaders } from '../../application/admin-traces.ts';
import {
  ADMIN_AGENT_TRACES_READERS,
  AdminAgentTracesController,
} from './agent-traces.controller.ts';

export class AgentAdminModule {
  static forAdmin(): DynamicModule {
    return {
      module: AgentAdminModule,
      controllers: [AdminAgentTracesController],
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
      ],
    };
  }
}

Module({})(AgentAdminModule);
