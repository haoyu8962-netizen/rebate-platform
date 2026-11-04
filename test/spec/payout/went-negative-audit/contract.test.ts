import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { audit_system_actor } from '../../../../packages/contracts-ts/src/index.ts';
import { systemActorName } from '../../../../apps/api/src/modules/admin/domain/audit-log-view.ts';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';

it('[AC-B2-09p#12] 审计身份的源枚举、生成枚举、OpenAPI 和显示名包含打款且保留风控', () => {
  const source = parseYamlLite(
    readFileSync(new URL('../../../../contracts/enums/admin.yaml', import.meta.url), 'utf8'),
  ) as {
    enums: { audit_system_actor: { values: Record<string, string> } };
  };
  const openapi = parseYamlLite(
    readFileSync(new URL('../../../../contracts/openapi.yaml', import.meta.url), 'utf8'),
  ) as {
    components: { schemas: { AdminAuditSystemActor: { enum: string[] } } };
  };
  expect(source.enums.audit_system_actor.values).toMatchObject({
    'system:risk': '系统（风控）',
    'system:payout': '系统（打款）',
  });
  expect([...audit_system_actor]).toEqual(expect.arrayContaining(['system:risk', 'system:payout']));
  expect(openapi.components.schemas.AdminAuditSystemActor.enum).toEqual(
    expect.arrayContaining(['system:risk', 'system:payout']),
  );
  expect(systemActorName('system:risk')).toBe('系统（风控）');
  expect(systemActorName('system:payout')).toBe('系统（打款）');
});
