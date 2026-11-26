import { expect, it } from 'vitest';
import { baseline, fixturePath, pin, pinFor, requiredText, snapshot, sourceCommit } from './kit.ts';

// No business AC was assigned; AC-CT-11a identifiers are local to task §2 requirements.
// CT-11bv: only 0.5.3 is accepted; any other version (including 0.5.2) fails in pin().
it('[AC-CT-11a#1] 契约完整保留固定规划版本的令牌、metadata 与 schemaVersion', () => {
  const branch = pin().version;
  expect(snapshot()).toEqual(baseline());
  expect(branch).toBe('0.5.3');
  expect(snapshot().metadata).toMatchObject({
    version: '0.5.3',
    theme: 'light',
    modes: ['light', 'dark'],
    darkThemePhase: 'MVP',
  });
  expect(requiredText('contracts/design-tokens.json')).toBe(
    requiredText('test/spec/frontend/ui-tokens/fixtures/design-tokens.c404003.json'),
  );
});

it('[AC-CT-11a#2] README 已交付清单同一行记录令牌版本与完整来源提交', () => {
  const branch = pin().version;
  const readme = requiredText('contracts/README.md');
  const delivered = readme.split('## 以后会放在这里的文件')[0]!;
  const rows = delivered
    .split('\n')
    .filter((line) => /^\|\s*`design-tokens\.json`\s*\|/.test(line));
  expect(rows).toHaveLength(1);
  expect(branch).toBe('0.5.3');
  expect(rows[0]).toContain('0.5.3');
  expect(sourceCommit()).toBe('c404003bbecdff2c67f3e744d81a5ee92e5043ce');
  expect(rows[0]).toContain(sourceCommit());
  expect(rows[0]).toContain('design/tokens/design-tokens.json');
  expect(rows[0]).not.toContain('只有浅色');
  expect(rows[0]).toMatch(/深色|浅\s*[/／]\s*深/);
});

it('[AC-CT-11bt-BRANCH#1] 只认 0.5.3 一个版本，固定夹具存在且与钉值对应', () => {
  expect(['0.5.3']).toContain(pin().version);
  for (const version of ['0.5.2', '0.5.1', '0.6.0', '0.5.0', '0.4.0', '', undefined, 0.52]) {
    expect(() => pinFor(version), String(version)).toThrow();
  }
  for (const [version, commit, json, css] of [
    [
      '0.5.3',
      'c404003bbecdff2c67f3e744d81a5ee92e5043ce',
      'design-tokens.c404003.json',
      'variables.c404003.css',
    ],
  ] as const) {
    expect(pinFor(version)).toEqual({ version, commit, json, css });
    const fixture = JSON.parse(requiredText(fixturePath(json))) as Record<string, unknown>;
    expect((fixture.metadata as Record<string, unknown>).version, json).toBe(version);
    expect(requiredText(fixturePath(css))).toContain(':root');
  }
  // The c404003 CSS fixture carries the motion group.
  expect(requiredText(fixturePath('variables.c404003.css'))).toContain(
    '--motion-easing-standard: cubic-bezier(0.2, 0, 0, 1);',
  );
});
