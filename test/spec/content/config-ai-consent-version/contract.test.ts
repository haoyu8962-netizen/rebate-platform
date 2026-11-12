// CT-26zm: contract ConfigLegal gains an optional ai_third_party { version } (int32 >= 1).
// Additive only: privacy / agreement and the required list of ConfigLegal stay as they were.
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { ROOT, apiRequire } from './fixtures.ts';

interface SchemaNode {
  type?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  required?: string[];
  additionalProperties?: unknown;
  properties?: Record<string, SchemaNode>;
  nullable?: boolean;
}

async function document() {
  const parser = apiRequire('@readme/openapi-parser') as {
    dereference(
      path: string,
      options: object,
    ): Promise<{
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components: { schemas: Record<string, SchemaNode> };
    }>;
  };
  return parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)), {
    resolve: { external: false },
  });
}

it('[AC-CT-26zm#6] ConfigLegal 新增可选 ai_third_party，恰含必填 version（int32 ≥ 1），不加入 ConfigLegal.required', async () => {
  const doc = await document();
  const legal = doc.components.schemas['ConfigLegal']!;
  expect(legal.additionalProperties).toBe(false);
  expect([...(legal.required ?? [])].sort()).toEqual(['agreement', 'privacy']);
  expect(Object.keys(legal.properties ?? {}).sort()).toEqual([
    'agreement',
    'ai_third_party',
    'privacy',
  ]);
  const block = legal.properties!['ai_third_party']!;
  expect(block.type).toBe('object');
  expect(block.nullable).not.toBe(true);
  expect(block.additionalProperties).toBe(false);
  expect(block.required).toEqual(['version']);
  expect(Object.keys(block.properties ?? {})).toEqual(['version']);
  const version = block.properties!['version']!;
  expect(version).toMatchObject({ type: 'integer', format: 'int32', minimum: 1 });
  expect(version.nullable).not.toBe(true);
  expect(version.maximum ?? 2147483647).toBe(2147483647);
  // Untouched neighbours (additive change only).
  expect(legal.properties!['privacy']).toMatchObject({
    additionalProperties: false,
    required: ['version', 'min_version'],
  });
  expect(legal.properties!['agreement']).toMatchObject({
    additionalProperties: false,
    required: ['version'],
  });
});

it('[AC-CT-26zm#7] GET /v1/config 的 200 响应引用的 legal 就是含 ai_third_party 的 ConfigLegal', async () => {
  const doc = await document();
  const operation = doc.paths['/v1/config']!['get']! as {
    operationId?: string;
    responses: Record<string, { content: Record<string, { schema: SchemaNode }> }>;
  };
  expect(operation.operationId).toBe('getConfig');
  // ConfigResponse { code, msg, data: Config, trace_id }; Config.legal is required.
  const envelope = operation.responses['200']!.content['application/json']!.schema;
  const config = envelope.properties?.['data'];
  expect(config?.required).toContain('legal');
  const legal = config?.properties?.['legal'];
  expect(legal).toBeDefined();
  expect(Object.keys(legal?.properties ?? {})).toContain('ai_third_party');
  expect(legal?.properties?.['ai_third_party']?.properties?.['version']).toMatchObject({
    type: 'integer',
    format: 'int32',
    minimum: 1,
  });
});
