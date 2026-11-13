import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';

export interface HandleAgentReportInput {
  readonly appId: string;
  readonly messageId: string;
  readonly handlerId: string;
  readonly note: string;
  readonly expectedRowVersion: number;
}

export type HandleAgentReportResult =
  | { kind: 'handled'; rowVersion: number; handledAt: string }
  | { kind: 'not_found' | 'not_reported' | 'already_handled' | 'cas_conflict' };

export interface AgentReportAdminPort {
  handle(trx: Transaction<DB>, input: HandleAgentReportInput): Promise<HandleAgentReportResult>;
}

export function handleAgentReport(
  trx: Transaction<DB>,
  clock: Clock,
  input: HandleAgentReportInput,
): Promise<HandleAgentReportResult> {
  void trx;
  void clock;
  void input;
  throw new Error('NotImplemented: handleAgentReport');
}

export function createAgentReportAdminPort(deps: { readonly clock: Clock }): AgentReportAdminPort {
  void deps;
  throw new Error('NotImplemented: createAgentReportAdminPort');
}
