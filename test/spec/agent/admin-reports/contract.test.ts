// B1-10t contract rule test (claude-independent, SPEC_REF 62b5c993): once implemented,
// adminListAgentReports and adminHandleAgentReport are no longer planned — the operations in
// contracts/openapi.yaml carry no `x-implementation`, and the generated planned list
// (packages/contracts-ts/src/planned-operations.gen.ts) holds none of the four agent-traces
// operations (the two session operations of B1-10q included). Static: reads the contract and the
// generated file only. Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { plannedOperations } from '../../../../packages/contracts-ts/src/planned-operations.gen.ts';
import { contract, op } from '../../contracts/admin-order-actions/kit.ts';

const REPORTS = [
  ['get', '/admin/v1/agent-traces/reports', 'adminListAgentReports'],
  ['post', '/admin/v1/agent-traces/reports/{message_id}/handle', 'adminHandleAgentReport'],
] as const;
const SESSIONS = ['adminListAgentSessions', 'adminGetAgentSession'] as const;

it('[AC-B1-10t#12] 契约去 planned：GET /admin/v1/agent-traces/reports（adminListAgentReports）与 POST /admin/v1/agent-traces/reports/{message_id}/handle（adminHandleAgentReport）不再带 x-implementation（不是 planned），生成的 planned 清单不含这两个操作，也不含会话的两个操作', () => {
  const doc = contract();
  for (const [method, path, operationId] of REPORTS) {
    const operation = op(doc, path, method);
    expect(operation['operationId'], path).toBe(operationId);
    expect(operation['x-implementation'], operationId).not.toBe('planned');
    expect(operation, operationId).not.toHaveProperty('x-implementation');
    expect(plannedOperations.has(operationId), operationId).toBe(false);
  }
  for (const operationId of SESSIONS)
    expect(plannedOperations.has(operationId), operationId).toBe(false);
});
