// B1-02zzz / BR-ID-08: observable contract changes, against both source and generated schemas.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';

const ROOT = new URL('../../../../', import.meta.url);
interface Document {
  components: { schemas: Record<string, JsonSchema> };
}

async function document(): Promise<Document> {
  const requireApi = createRequire(new URL('apps/api/package.json', ROOT));
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(path: string, options: object): Promise<Document>;
  };
  return parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)), {
    resolve: { external: false },
  });
}

it('[AC-B1-02zzza#3] Me 契约必须返回 masked_phone，接受脱敏字符串或 null', async () => {
  const schema = (await document()).components.schemas['Me']!;
  expect(schema['required']).toContain('masked_phone');
  const properties = schema['properties'] as Record<string, JsonSchema>;
  expect(properties).toHaveProperty('masked_phone');
  const validate = createValidatorCompiler()({
    schema: properties['masked_phone']!,
    httpPart: 'body',
  });
  expect(validate('138****8000')).toBe(true);
  expect(validate(null)).toBe(true);
  expect(validate(13800138000)).toBe(false);
});
