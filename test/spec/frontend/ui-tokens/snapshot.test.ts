import { expect, it } from 'vitest';
import { baseline, requiredText, snapshot, SOURCE_COMMIT } from './kit.ts';

// No business AC was assigned; AC-CT-11a identifiers are local to task §2 requirements.
it('[AC-CT-11a#1] 契约完整保留固定规划版本的令牌、metadata 与 schemaVersion', () => {
  expect(snapshot()).toEqual(baseline());
  expect(snapshot().metadata).toMatchObject({
    version: '0.5.1',
    theme: 'light',
    modes: ['light', 'dark'],
    darkThemePhase: 'MVP',
  });
  expect(requiredText('contracts/design-tokens.json')).toBe(
    requiredText('test/spec/frontend/ui-tokens/fixtures/design-tokens.f088f04.json'),
  );
});

it('[AC-CT-11a#2] README 已交付清单同一行记录令牌版本与完整来源提交', () => {
  const readme = requiredText('contracts/README.md');
  const delivered = readme.split('## 以后会放在这里的文件')[0]!;
  const rows = delivered
    .split('\n')
    .filter((line) => /^\|\s*`design-tokens\.json`\s*\|/.test(line));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toContain('0.5.1');
  expect(rows[0]).toContain(SOURCE_COMMIT);
  expect(rows[0]).toContain('design/tokens/design-tokens.json');
  expect(rows[0]).not.toContain('只有浅色');
  expect(rows[0]).toMatch(/深色|浅\s*[/／]\s*深/);
});
