// B1-02zx · contract of adminAddUserReverifiedDevice (POST /admin/v1/users/{user_id}/reverified-devices,
// CT-26j); contracts/openapi.yaml is the only source.
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { apiRequire, type Response } from '../../admin/auth/kit.ts';

export const PATH = '/admin/v1/users/{user_id}/reverified-devices';
export const OPERATION_ID = 'adminAddUserReverifiedDevice';
/** The x-error-codes of CT-26j; this task does not change them. */
export const ERROR_CODES = [10001, 10003, 10403, 20001, 30419];

export interface Operation {
  operationId: string;
  'x-implementation'?: string;
  'x-error-codes'?: number[];
  responses: Record<string, { content?: Record<string, { schema: JsonSchema }> }>;
}
interface Document {
  paths: Record<string, { post?: Operation }>;
}

let document: Promise<Document> | undefined;
export function contract(): Promise<Document> {
  const parser = apiRequire('@readme/openapi-parser') as {
    dereference(path: string, options: object): Promise<Document>;
  };
  document ??= parser.dereference(
    fileURLToPath(new URL('../../../../contracts/openapi.yaml', import.meta.url)),
    { resolve: { external: false } },
  );
  return document;
}

export async function operation(): Promise<Operation> {
  const op = (await contract()).paths[PATH]?.post;
  expect(op, `${PATH} POST must exist in the contract`).toBeDefined();
  expect(op!.operationId).toBe(OPERATION_ID);
  return op!;
}

/** The response against the contract response of its status class. */
export async function validate(response: Response) {
  const op = await operation();
  const status = response.statusCode < 400 ? '200' : response.statusCode < 500 ? '4XX' : '5XX';
  const schema = op.responses[status]?.content?.['application/json']?.schema;
  expect(schema, `response ${status} must be in the contract`).toBeDefined();
  const check = createValidatorCompiler()({ schema: schema!, httpPart: 'body' });
  expect(check(response.json()), JSON.stringify(check.errors)).toBe(true);
}
