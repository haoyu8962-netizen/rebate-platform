import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';

it('[AC-B2-05u#8] 错误码 30305 的来源包含 BR-WDR-02', () => {
  const catalog = parseYamlLite(
    readFileSync(new URL('../../../../contracts/error-codes.yaml', import.meta.url), 'utf8'),
  ) as { codes: { code: number; sources: string[] }[] };
  expect(catalog.codes.find(({ code }) => code === 30305)?.sources).toContain('BR-WDR-02');
});
