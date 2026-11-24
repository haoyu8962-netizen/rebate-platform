import { expect, it } from 'vitest';
import { contract } from '../exports/kit.ts';
import { AUTH, METHODS, OPERATION_IDS, PATHS, STEP_UP_OPERATIONS, type Operation } from './kit.ts';

// 保留原标题，二次验证要求以块内断言为准。
it.each(Object.keys(PATHS) as Operation[])(
  '[AC-B1-34i#1] %s 保持契约的鉴权级别与 step-up 头，去掉 planned，规则出处改指 BR-ID-45',
  async (operation) => {
    const spec = (await contract()).paths[PATHS[operation]]![METHODS[operation]]!;
    expect(spec).toMatchObject({
      operationId: OPERATION_IDS[operation],
      'x-auth': AUTH[operation],
    });
    const { parameters, 'x-error-codes': errorCodes } = spec as unknown as {
      parameters?: { name?: string }[];
      'x-error-codes'?: number[];
    };
    const hasToken = (parameters ?? []).some((parameter) => parameter.name === 'X-Step-Up-Token');
    expect(hasToken).toBe(false);
    if ((STEP_UP_OPERATIONS as readonly string[]).includes(operation)) {
      expect(errorCodes ?? []).not.toContain(10003);
    }
    // Test-phase source stays unchanged; the implementer removes these four markers.
    expect(spec['x-implementation']).not.toBe('planned');
    // Task §9: the rule was split out of BR-ID-34 as BR-ID-45 (2026-10-23).
    const description = (spec as unknown as { description?: string }).description ?? '';
    expect(description).toContain('BR-ID-45');
    expect(description).not.toContain('BR-ID-34 细则「验证手机号的登记与更换」');
  },
);
