import { describe, expect, it } from 'vitest';
import { repoRoot } from '../../lib/paths.ts';
import { loadProtected } from './protected.ts';
import { loadRiskMap, parseRiskMap, riskOfPath, riskOfPaths } from './risk.ts';
import type { RiskMap } from './risk.ts';

const cfg = loadProtected(repoRoot());
const map = loadRiskMap(repoRoot());

describe('ops/risk-map.yaml', () => {
  it('holds the rules in order (default split of 2026-10-05: Opus implements, Codex tests and reviews)', () => {
    expect(map.rules.map((r) => `${r.path} ${r.risk} ${r.impl}/${r.tester}/${r.review}`)).toEqual([
      'docs/** RV0 claude/none/codex',
      'ops/tasks/** RV0 claude/none/codex',
      'contracts/** RV1 claude/codex/codex',
      'packages/contracts-ts/** RV1 claude/codex/codex',
      'apps/api/src/modules/health/** RV1 claude/codex/codex',
      'apps/api/src/modules/identity/** RV1 claude/codex/codex',
      'apps/api/src/modules/risk/** RV1 claude/codex/codex',
      'apps/api/src/modules/union/** RV2 claude/codex/claude+codex',
      'apps/api/src/modules/commission/** RV2 claude/codex/claude+codex',
      'apps/api/src/modules/ledger/** RV2 claude/codex/claude+codex',
      'apps/api/src/modules/settlement/** RV2 claude/codex/claude+codex',
      'apps/api/src/modules/payment/** RV2 claude/codex/claude+codex',
      'apps/api/src/modules/payout/** RV2 claude/codex/claude+codex',
      'apps/api/src/modules/orders/** RV2 claude/codex/claude+codex',
      'apps/api/src/modules/admin/** RV2 claude/codex/claude+codex',
      'apps/api/src/modules/content/** RV2 claude/codex/claude+codex',
      'apps/api/src/modules/linking/** RV2 claude/codex/claude+codex',
      'apps/api/src/modules/growth/** RV2 claude/codex/claude+codex',
      'apps/api/src/modules/catalog/** RV1 claude/codex/codex',
      'apps/api/src/modules/parsing/** RV1 claude/codex/codex',
      'apps/api/src/modules/notification/** RV1 claude/codex/codex',
      'apps/api/src/modules/feedback/** RV1 claude/codex/codex',
      'apps/api/src/modules/agent/** RV1 claude/codex/codex',
      'apps/api/src/modules/platform/** RV2 claude/codex/claude+codex',
      'packages/evals/** RV1 claude/codex/codex',
      'apps/admin/src/**/{withdrawals,adjustments}/** RV2 claude/codex/claude+codex',
      'apps/admin/src/**/{withdrawals,adjustments}.* RV2 claude/codex/claude+codex',
      'apps/admin/** RV1 claude/codex/codex',
      'apps/h5/** RV1 claude/codex/codex',
      'packages/bridge-sdk/** RV1 claude/codex/codex',
      'packages/ui-tokens/** RV1 claude/codex/codex',
      'packages/money/** RV2 claude/codex/claude+codex',
      'packages/domain/** RV2 claude/codex/claude+codex',
      'packages/db/** RV2 claude/codex/claude+codex',
      'db/invariants/** RV2 codex/none/claude',
      'db/** RV2 claude/codex/claude+codex',
      'packages/testing/** RV2 codex/none/claude',
      'test/** RV2 codex/none/claude',
    ]);
  });

  it('ledger files are RV0, the rest of ops/ stays RV2 (owner decision 2026-10-02)', () => {
    expect(riskOfPath('ops/tasks/CT-01.yaml', map, cfg).risk).toBe('RV0');
    expect(riskOfPath('ops/evidence/CT-01.json', map, cfg).risk).toBe('RV2');
    expect(riskOfPath('ops/approvals.yaml', map, cfg).risk).toBe('RV2');
  });

  it('admin withdrawal and adjustment pages are RV2 wherever they live; other admin pages RV1 (规划/11 §1.1)', () => {
    expect(riskOfPath('apps/admin/src/resources/withdrawals/List.tsx', map, cfg).risk).toBe('RV2');
    expect(riskOfPath('apps/admin/src/pages/adjustments/create.tsx', map, cfg).risk).toBe('RV2');
    expect(riskOfPath('apps/admin/src/resources/withdrawals.tsx', map, cfg).risk).toBe('RV2');
    expect(riskOfPath('apps/admin/src/resources/users/List.tsx', map, cfg).risk).toBe('RV1');
    expect(riskOfPath('apps/h5/src/entries/app/main.tsx', map, cfg).risk).toBe('RV1');
  });
});

describe('parseRiskMap', () => {
  it('reports every problem at once', () => {
    const text = [
      'version: 2',
      'extra: 1',
      'rules:',
      '  - path: "a/{b"',
      '    risk: RV3',
      '    impl: gpt',
      '    tester: nobody',
      '    review: someone',
      '    note: x',
      '  - just-a-string',
      '  - path: "docs/**"',
      '    risk: RV0',
      '    impl: claude',
      '    tester: none',
      '    review: codex',
      '  - path: "docs/**"',
      '    risk: RV1',
      '    impl: claude',
      '    tester: none',
      '    review: codex',
    ].join('\n');
    let message = '';
    try {
      parseRiskMap(text);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    for (const part of [
      'extra: unknown key',
      'version: must be 1',
      'rules[0].note: unknown key',
      'rules[0].path: unbalanced',
      'rules[0].risk: must be RV0, RV1 or RV2',
      'rules[0].impl: must be codex or claude',
      'rules[0].tester: must be codex, claude or none',
      'rules[0].review: must be claude, codex or claude+codex',
      'rules[1]: must be a mapping',
      'rules[3].path: duplicate rule for "docs/**"',
    ]) {
      expect(message).toContain(part);
    }
  });

  it('rejects documents that are not a mapping with a rule list', () => {
    expect(() => parseRiskMap('- a\n')).toThrow(/must be a mapping/);
    expect(() => parseRiskMap('version: 1\n')).toThrow(/rules: must be a list/);
  });
});

describe('riskOfPath: literal paths', () => {
  it('takes the first matching rule and defaults to RV2', () => {
    expect(riskOfPath('docs/README.md', map, cfg)).toEqual({
      path: 'docs/README.md',
      risk: 'RV0',
      rule: 'docs/**',
      protected: null,
    });
    expect(riskOfPath('apps/api/src/modules/health/health.controller.ts', map, cfg).risk).toBe(
      'RV1',
    );
    expect(riskOfPath('packages/money/src/index.ts', map, cfg).rule).toBe('packages/money/**');
    expect(riskOfPath('apps/api/src/modules/settlement/post.ts', map, cfg).rule).toBe(
      'apps/api/src/modules/settlement/**',
    );
    expect(riskOfPath('apps/api/src/modules/payout/post.ts', map, cfg)).toEqual({
      path: 'apps/api/src/modules/payout/post.ts',
      risk: 'RV2',
      rule: 'apps/api/src/modules/payout/**',
      protected: null,
    });
    expect(riskOfPath('apps/api/src/modules/reconciliation/post.ts', map, cfg)).toEqual({
      path: 'apps/api/src/modules/reconciliation/post.ts',
      risk: 'RV2',
      rule: 'default',
      protected: null,
    });
    expect(riskOfPath('turbo.json', map, cfg)).toEqual({
      path: 'turbo.json',
      risk: 'RV2',
      rule: 'default',
      protected: 2,
    });
  });

  it('honours rule order', () => {
    const ordered: RiskMap = {
      version: 1,
      rules: [
        { path: 'pkg/README.md', risk: 'RV0', impl: 'claude', tester: 'none', review: 'codex' },
        { path: 'pkg/**', risk: 'RV1', impl: 'codex', tester: 'claude', review: 'claude' },
      ],
    };
    expect(riskOfPath('pkg/README.md', ordered, cfg).risk).toBe('RV0');
    expect(riskOfPath('pkg/src/a.ts', ordered, cfg).risk).toBe('RV1');
  });

  it('reports the protected class together with the mapped risk', () => {
    expect(riskOfPath('test/spec/money/round.test.ts', map, cfg)).toMatchObject({
      risk: 'RV2',
      rule: 'test/**',
      protected: 1,
    });
    expect(riskOfPath('docs/AGENTS.md', map, cfg)).toMatchObject({ risk: 'RV0', protected: 3 });
  });

  it('normalises "./" and never trusts absolute or escaping paths', () => {
    expect(riskOfPath('./docs/a.md', map, cfg)).toMatchObject({ path: 'docs/a.md', risk: 'RV0' });
    expect(riskOfPath('/etc/passwd', map, cfg).risk).toBe('RV2');
    expect(riskOfPath('docs/../tools/x.ts', map, cfg)).toMatchObject({
      risk: 'RV2',
      rule: 'default',
    });
  });
});

describe('riskOfPath: task globs', () => {
  const layered: RiskMap = {
    version: 1,
    rules: [
      {
        path: 'packages/money/**',
        risk: 'RV2',
        impl: 'codex',
        tester: 'claude',
        review: 'claude+codex',
      },
      { path: 'packages/**', risk: 'RV0', impl: 'claude', tester: 'none', review: 'codex' },
    ],
  };

  it('needs a covering rule to leave the default', () => {
    expect(riskOfPath('apps/api/src/modules/health/**', map, cfg)).toMatchObject({
      risk: 'RV1',
      rule: 'apps/api/src/modules/health/**',
    });
    expect(riskOfPath('docs/research/**', map, cfg).risk).toBe('RV0');
    expect(riskOfPath('apps/api/src/modules/**', map, cfg)).toMatchObject({
      risk: 'RV2',
      rule: 'default',
    });
    expect(riskOfPath('doc*/**', map, cfg)).toMatchObject({ risk: 'RV2', rule: 'default' });
  });

  it('takes the highest risk among overlapping rules', () => {
    expect(riskOfPath('packages/foo/**', layered, cfg)).toMatchObject({
      risk: 'RV0',
      rule: 'packages/**',
    });
    expect(riskOfPath('packages/**', layered, cfg)).toMatchObject({
      risk: 'RV2',
      rule: 'packages/money/**',
    });
    expect(riskOfPath('packages/money/src/**', layered, cfg).risk).toBe('RV2');
  });

  it('marks globs that target a protected area', () => {
    expect(riskOfPath('tools/guard/**', map, cfg)).toMatchObject({ risk: 'RV2', protected: 3 });
    expect(riskOfPath('packages/money/**', map, cfg).protected).toBeNull();
  });
});

describe('riskOfPaths', () => {
  it('returns the highest risk and asks when class 2 or 3 is hit', () => {
    const report = riskOfPaths(
      ['packages/money/src/index.ts', 'docs/README.md', 'turbo.json'],
      map,
      cfg,
    );
    expect(report.risk).toBe('RV2');
    expect(report.ask).toBe(true);
    expect(report.paths.map((p) => p.risk)).toEqual(['RV2', 'RV0', 'RV2']);
  });

  it('does not ask for class 1 or unprotected paths', () => {
    expect(riskOfPaths(['docs/a.md', 'docs/b.md'], map, cfg)).toMatchObject({
      risk: 'RV0',
      ask: false,
    });
    expect(riskOfPaths(['test/spec/a.test.ts'], map, cfg)).toMatchObject({
      risk: 'RV2',
      ask: false,
    });
    expect(riskOfPaths(['docs/a.md', 'contracts/openapi.yaml'], map, cfg).risk).toBe('RV1');
  });

  it('is RV2 for an empty list', () => {
    expect(riskOfPaths([], map, cfg)).toEqual({ risk: 'RV2', ask: false, paths: [] });
  });
});
