import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';

it('[AC-F1-02zzzb#18] staging 配置签名目录只读挂载到 api，其他进程不持有私钥目录', () => {
  const doc = parseYamlLite(
    readFileSync(new URL('../../../../infra/staging/compose.yaml', import.meta.url), 'utf8'),
  ) as {
    services: Record<string, { volumes?: unknown[] }>;
  };
  const mounts = doc.services['api']?.volumes ?? [];
  expect(mounts).toContainEqual(
    expect.objectContaining({
      type: 'bind',
      source: '/etc/couli-config-sign',
      target: '/run/couli-config-sign',
      read_only: true,
    }),
  );
  for (const [entry, service] of Object.entries(doc.services)) {
    if (entry === 'api') continue;
    expect(JSON.stringify(service.volumes ?? []), entry).not.toContain('couli-config-sign');
  }
});
