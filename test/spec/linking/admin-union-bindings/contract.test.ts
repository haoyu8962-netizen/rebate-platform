import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { apiRequire } from '../../admin/auth/kit.ts';
import { ACTIONS, ROOT } from './kit.ts';

it.each(ACTIONS)(
  '[AC-F1-07c#23] %s 上线后移除 planned，保留后台身份与无幂等键契约',
  async (action) => {
    const parser = apiRequire('@readme/openapi-parser') as {
      dereference(
        path: string,
        options: object,
      ): Promise<{
        paths: Record<
          string,
          {
            post: {
              'x-implementation'?: string;
              'x-auth': string;
              parameters: readonly { name: string }[];
            };
          }
        >;
      }>;
    };
    const document = await parser.dereference(
      fileURLToPath(new URL('contracts/openapi.yaml', ROOT)),
      {
        resolve: { external: false },
      },
    );
    const operation =
      document.paths[`/admin/v1/users/{user_id}/union-bindings/{platform}/${action}`]?.post;
    expect(operation).toBeDefined();
    expect(operation!['x-implementation']).not.toBe('planned');
    expect(operation!['x-auth']).toBe('admin');
    const parameterNames = operation!.parameters.map((p) => p.name.toLowerCase());
    expect(parameterNames.includes('x-step-up-token')).toBe(action === 'reset');
    expect(operation!.parameters.map((p) => p.name.toLowerCase())).not.toContain('idempotency-key');
  },
);
