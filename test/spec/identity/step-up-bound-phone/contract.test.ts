// B1-02zzz / BR-ID-08: observable contract changes, against both source and generated schemas.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { CONTRACT_AUTH_ROUTES } from '../../../../apps/api/src/modules/platform/http/auth-routes.gen.ts';
import { CONTRACT_ROUTE_SCHEMAS } from '../../../../apps/api/src/modules/platform/validation/route-schemas.gen.ts';

const ROOT = new URL('../../../../', import.meta.url);
const SMS = '/v1/auth/sms-codes';
type Operation = Record<string, unknown> & {
  requestBody: { content: { 'application/json': { schema: JsonSchema } } };
};
interface Document {
  paths: Record<string, { post: Operation }>;
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

it('[AC-B1-02zzz#1] sendSmsCode 声明可选登录并保留签名，生成鉴权路由同步', async () => {
  const operation = (await document()).paths[SMS]!.post;
  expect(operation).toMatchObject({ 'x-auth': 'optional', 'x-signed': true });
  expect(operation['x-error-codes']).toContain(10001);
  expect(
    CONTRACT_AUTH_ROUTES.find((route) => route.path === SMS && route.method === 'POST'),
  ).toMatchObject({ auth: 'optional' });
});

it.each(['source', 'generated'] as const)(
  '[AC-B1-02zzz#2] %s 请求契约：step_up 不带 phone；login / bind 仍必须带 phone',
  async (source) => {
    const schema =
      source === 'source'
        ? (await document()).paths[SMS]!.post.requestBody.content['application/json'].schema
        : CONTRACT_ROUTE_SCHEMAS.sendSmsCode.body;
    const validate = createValidatorCompiler()({ schema, httpPart: 'body' });
    for (const action of [
      'withdraw',
      'payout_account_change',
      'phone_change',
      'account_deletion',
    ]) {
      expect(validate({ purpose: 'step_up', action }), JSON.stringify(validate.errors)).toBe(true);
    }
    for (const purpose of ['login', 'bind']) {
      expect(validate({ purpose, phone: '13800138000' })).toBe(true);
      expect(validate({ purpose })).toBe(false);
    }
  },
);

it('[AC-B1-02zzz#3] Me 契约必须返回 masked_phone，接受脱敏字符串或 null', async () => {
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
