// B1-10q contract rule test (claude-independent, SPEC_REF a36eb936): once implemented,
// adminListAgentSessions and adminGetAgentSession are no longer planned — the operations in
// contracts/openapi.yaml carry no `x-implementation: planned` and the generated planned list
// (packages/contracts-ts/src/planned-operations.gen.ts) does not hold them. Static: reads the
// contract and the generated file only. Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { plannedOperations } from '../../../../packages/contracts-ts/src/planned-operations.gen.ts';
import { contract, op } from '../../contracts/admin-order-actions/kit.ts';

const OPERATIONS = [
  ['/admin/v1/agent-traces/sessions', 'adminListAgentSessions'],
  ['/admin/v1/agent-traces/sessions/{session_id}', 'adminGetAgentSession'],
] as const;

it('[AC-B1-10q#13] 契约去 planned：GET /admin/v1/agent-traces/sessions（adminListAgentSessions）与 GET /admin/v1/agent-traces/sessions/{session_id}（adminGetAgentSession）不再标 x-implementation: planned，生成的 planned 清单不含这两个操作', () => {
  const doc = contract();
  for (const [path, operationId] of OPERATIONS) {
    const operation = op(doc, path, 'get');
    expect(operation['operationId'], path).toBe(operationId);
    expect(operation['x-implementation'], operationId).not.toBe('planned');
    expect(plannedOperations.has(operationId), operationId).toBe(false);
  }
});
