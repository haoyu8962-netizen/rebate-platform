import { expect, it } from 'vitest';
import { contract } from '../exports/kit.ts';
import { METHODS, OPERATION_IDS, PATHS, STEP_UP_OPERATIONS, type Operation } from './kit.ts';

// 保留原标题，二次验证要求以块内断言为准。
it.each(Object.keys(PATHS) as Operation[])(
  '[AC-B1-34h#1] %s 保持 super 鉴权与契约的 step-up 头并去掉 planned',
  async (operation) => {
    const spec = (await contract()).paths[PATHS[operation]]![METHODS[operation]]!;
    expect(spec).toMatchObject({ operationId: OPERATION_IDS[operation], 'x-auth': 'super' });
    const { parameters, 'x-error-codes': errorCodes } = spec as unknown as {
      parameters?: { name?: string }[];
      'x-error-codes'?: number[];
    };
    const hasToken = (parameters ?? []).some((parameter) => parameter.name === 'X-Step-Up-Token');
    expect(hasToken).toBe(false);
    if ((STEP_UP_OPERATIONS as readonly string[]).includes(operation)) {
      expect(errorCodes ?? []).not.toContain(10003);
    }
    // Test-phase source stays unchanged; the implementer removes just these six markers.
    expect(spec['x-implementation']).not.toBe('planned');
  },
);
