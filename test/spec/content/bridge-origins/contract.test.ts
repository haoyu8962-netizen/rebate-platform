import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { signedFixture } from './jws-kit.ts';

it('[AC-F1-02zzzb#12] ConfigResponse 的必填 bridge_origins 使用 ConfigBridgeOrigins，拒绝旧对象和非紧凑串', async () => {
  const root = new URL('../../../../', import.meta.url);
  const require = createRequire(new URL('apps/api/package.json', root));
  const parser = require('@readme/openapi-parser') as {
    dereference(path: string): Promise<{ components: { schemas: Record<string, JsonSchema> } }>;
  };
  const doc = await parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', root)));
  const schemas = doc.components.schemas;
  expect(schemas['ConfigBridgeOrigins']).toMatchObject({
    type: 'object',
    required: ['jws'],
    properties: { jws: { type: 'string' } },
  });
  const config = schemas['Config'] as {
    required: string[];
    properties: Record<string, JsonSchema>;
  };
  expect(config.required).toContain('bridge_origins');
  expect(config.properties['bridge_origins']).toEqual(schemas['ConfigBridgeOrigins']);
  const validate = createValidatorCompiler()({
    schema: schemas['ConfigBridgeOrigins']!,
    method: 'GET',
    url: '/v1/config',
    httpPart: 'body',
  });
  expect(validate(signedFixture())).toBe(true);
  for (const bad of [
    {},
    { origins: ['https://h5.example.test'] },
    { jws: '' },
    { jws: 'a.b' },
    { jws: 'a.b.c.d' },
    { jws: 'a=.b.c' },
    { jws: 1 },
  ]) {
    expect(validate(bad), JSON.stringify(bad)).toBe(false);
  }
});
