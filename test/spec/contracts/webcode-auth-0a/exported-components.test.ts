import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';

const baselineFile = new URL('../../../../specs/client-security-baseline.yaml', import.meta.url);

it('[AC-CT-17l#1] CSB-09 白名单恰好包含四个自有组件并移除待登记 TODO', () => {
  // 漏登、重复、多登、换端、错标来源、空用途或保留该 TODO 均会失败。
  const raw = readFileSync(baselineFile, 'utf8');
  const { exported_components_allowed: entries } = parseYamlLite(raw) as {
    exported_components_allowed?: unknown;
  };
  expect(Array.isArray(entries)).toBe(true);
  expect(entries).toHaveLength(4);
  expect(entries).toEqual(
    expect.arrayContaining([
      {
        platform: 'android',
        component: 'com.couli.app.MainActivity',
        purpose: expect.stringMatching(/\S/u),
        source: 'own',
      },
      {
        platform: 'android',
        component: 'com.couli.app.clipboard.ShareReceiverActivity',
        purpose: expect.stringMatching(/\S/u),
        source: 'own',
      },
      {
        platform: 'android',
        component: 'com.couli.app.inbound.InboundSchemeActivity',
        purpose: expect.stringMatching(/\S/u),
        source: 'own',
      },
      {
        platform: 'harmony',
        component: 'EntryAbility',
        purpose: expect.stringMatching(/\S/u),
        source: 'own',
      },
    ]),
  );
  expect(raw).not.toContain('TODO(规划/03 §4.8 CSB-09)');
});
