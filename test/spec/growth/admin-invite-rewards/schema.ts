// B2-16d · contract of adminListInviteRewards (GET /admin/v1/invite-rewards) and
// adminGetInviteReward (GET /admin/v1/invite-rewards/{invitee_id}), CT-25a; contracts/openapi.yaml is
// the only source.
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { apiRequire, type Response } from '../../admin/auth/kit.ts';

export const LIST = '/admin/v1/invite-rewards';
export const DETAIL = '/admin/v1/invite-rewards/{invitee_id}';
export const LIST_ID = 'adminListInviteRewards';
export const DETAIL_ID = 'adminGetInviteReward';
/** The x-error-codes of CT-25a; this task does not change them. */
export const ERROR_CODES: Readonly<Record<string, readonly number[]>> = {
  [LIST]: [10001, 10403, 20001],
  [DETAIL]: [10001, 10403, 20001, 30701],
};
export type Path = typeof LIST | typeof DETAIL;

export interface Operation {
  operationId: string;
  'x-implementation'?: string;
  'x-error-codes'?: number[];
  responses: Record<string, { content?: Record<string, { schema: JsonSchema }> }>;
}
interface Document {
  paths: Record<string, { get?: Operation }>;
}

let document: Promise<Document> | undefined;
function contract(): Promise<Document> {
  const parser = apiRequire('@readme/openapi-parser') as {
    dereference(path: string, options: object): Promise<Document>;
  };
  document ??= parser.dereference(
    fileURLToPath(new URL('../../../../contracts/openapi.yaml', import.meta.url)),
    { resolve: { external: false } },
  );
  return document;
}

export async function operation(path: Path): Promise<Operation> {
  const op = (await contract()).paths[path]?.get;
  expect(op, `${path} GET must exist in the contract`).toBeDefined();
  expect(op!.operationId).toBe(path === LIST ? LIST_ID : DETAIL_ID);
  return op!;
}

/** The response against the contract response of its status class. */
export async function validate(path: Path, response: Response) {
  const op = await operation(path);
  const status = response.statusCode < 400 ? '200' : response.statusCode < 500 ? '4XX' : '5XX';
  const schema = op.responses[status]?.content?.['application/json']?.schema;
  expect(schema, `${path} response ${status} must be in the contract`).toBeDefined();
  const check = createValidatorCompiler()({ schema: schema!, httpPart: 'body' });
  expect(check(response.json()), JSON.stringify(check.errors)).toBe(true);
}
