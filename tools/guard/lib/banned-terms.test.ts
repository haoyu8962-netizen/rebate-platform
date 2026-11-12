import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../../lib/paths.ts';
import { parseAllow, parseTerms, scanText } from './banned-terms.ts';

const guardDir = join(repoRoot(), 'tools', 'guard');
const terms = parseTerms(readFileSync(join(guardDir, 'banned-terms.txt'), 'utf8'));
const allow = parseAllow(readFileSync(join(guardDir, 'banned-terms.allow.txt'), 'utf8'));

function hitTerms(file: string, text: string, withAllow = true): string[] {
  return scanText(file, text, terms, withAllow ? allow : []).map((h) => `${h.line}:${h.term}`);
}

describe('banned-terms.txt', () => {
  it('lists the names superseded by ADR-0001 §3', () => {
    expect(terms.map((t) => `${t.wholeWord ? 'word:' : ''}${t.text}`)).toEqual([
      'Prisma',
      'BullMQ',
      'Supertest',
      'react-vant',
      'X-Clock',
      'outbox',
      'word:relay',
      'queue Redis',
    ]);
  });
});

describe('scanText', () => {
  it('matches case-insensitively and reports each term per line', () => {
    expect(
      hitTerms(
        'brief.md',
        ['用 prisma 读库', '没有问题的一行', 'BullMQ 加 OUTBOX 表', '请求头 x-clock'].join('\n'),
      ),
    ).toEqual(['1:Prisma', '3:BullMQ', '3:outbox', '4:X-Clock']);
  });

  it('matches "relay" only as a whole word', () => {
    expect(hitTerms('brief.md', 'the relay process')).toEqual(['1:relay']);
    expect(hitTerms('brief.md', '启动relay进程')).toEqual(['1:relay']);
    expect(hitTerms('brief.md', 'relayed, relays_table, prelay')).toEqual([]);
  });

  it('matches multi-word terms across any whitespace and substrings of identifiers', () => {
    expect(hitTerms('brief.md', '独立  queue   redis 实例')).toEqual(['1:queue Redis']);
    expect(hitTerms('brief.md', 'outbox_events 表')).toEqual(['1:outbox']);
    expect(hitTerms('brief.md', 'queue 与 Redis 分开写')).toEqual([]);
  });

  it('gives an excerpt around the match', () => {
    const [hit] = scanText(
      'brief.md',
      `${'前'.repeat(60)} Supertest ${'后'.repeat(60)}`,
      terms,
      [],
    );
    expect(hit?.excerpt).toContain('Supertest');
    expect(hit?.excerpt.length).toBeLessThan(80);
  });
});

describe('allow list', () => {
  const prohibition =
    '| 数据访问 | Kysely + pg | 不要引入 Prisma 或第二种数据访问方式；不要手改生成的类型 |';

  it('ignores a line only for the listed file', () => {
    expect(hitTerms('规划/02_系统架构.md', prohibition, false)).toEqual(['1:Prisma']);
    expect(hitTerms('规划/02_系统架构.md', prohibition)).toEqual([]);
    expect(hitTerms('规划/05_里程碑与任务拆分.md', prohibition)).toEqual(['1:Prisma']);
    expect(hitTerms('/somewhere/couli-runs/B2-03/brief.md', prohibition)).toEqual(['1:Prisma']);
  });

  it('does not excuse other lines of the same file', () => {
    expect(hitTerms('规划/02_系统架构.md', `${prohibition}\n数据访问层用 Prisma`)).toEqual([
      '2:Prisma',
    ]);
  });

  it('holds only narrow entries for 规划/02 and 规划/08 13', () => {
    expect(allow.map((e) => e.glob)).toEqual([
      '规划/02_系统架构.md',
      '规划/02_系统架构.md',
      '规划/02_系统架构.md',
      '规划/08_业务规则/13_命名与编码对照.md',
      '规划/08_业务规则/13_命名与编码对照.md',
      '规划/08_业务规则/13_命名与编码对照.md',
    ]);
    for (const entry of allow) expect(entry.re.source.length).toBeGreaterThan(15);
  });
});

describe('parsers', () => {
  it('skips comments and blank lines in the term list', () => {
    expect(parseTerms('# c\n\nFoo\n word:bar \n').map((t) => [t.text, t.wholeWord])).toEqual([
      ['Foo', false],
      ['bar', true],
    ]);
    expect(() => parseTerms('word:\n')).toThrow(/empty term/);
  });

  it('rejects malformed allow lines', () => {
    expect(() => parseAllow('docs/** no-tab-here\n')).toThrow(/line 1 must be/);
    expect(() => parseAllow('docs/**\t(unclosed\n')).toThrow(/line 1/);
    expect(parseAllow('# comment\n\ndocs/**\tfoo.*bar\n')).toHaveLength(1);
  });
});

describe('ignoreRepoPaths (task briefs)', () => {
  function briefHits(text: string, options?: { ignoreRepoPaths?: boolean }): string[] {
    return scanText('brief.md', text, terms, allow, options).map((h) => `${h.line}:${h.term}`);
  }

  const inPaths = [
    'test_paths: test/spec/agent/read-exports-relay/**',
    "  - 'test/spec/agent/read-exports-relay/**'",
    '- `test/spec/agent/read-exports-relay/**`',
    '只改 `tools/relay/x.ts`',
    'worktree：./apps/relay-x/y.ts',
    '路径 /Users/a/couli-runs/worktrees/relay-1/b',
  ];

  it('[CT-06zzzzs] does not count relay that only appears inside repository paths', () => {
    for (const line of inPaths) expect(briefHits(line, { ignoreRepoPaths: true })).toEqual([]);
    expect(briefHits(inPaths.join('\n'), { ignoreRepoPaths: true })).toEqual([]);
  });

  it('[CT-06zzzzs] accepts every top-level directory, ./, globs, non-ASCII and quoting', () => {
    const lines = [
      'packages/relay/src/index.ts',
      'db/migrations/0042_relay.sql',
      'contracts/relay.yaml',
      'specs/relay.csv',
      'ops/tasks/relay.yaml',
      'docs/relay/说明.md',
      'infra/relay/main.tf',
      'config/relay.json',
      'fixtures/relay/a.json',
      'lint/relay.ts',
      '.github/workflows/relay.yml',
      './test/relay/x.test.ts',
      'packages/{relay,money}/**',
      'apps/api/src/modules/*relay*/**',
      '/Users/zhixing/我的项目/couli-runs/relay/x',
      '"tools/relay/x.ts"',
      '（见 tools/relay/x.ts）',
      '「apps/relay/x」',
      '[tools/relay/x.ts](tools/relay/x.ts)',
      '<apps/relay/x>',
      'tools/relay/a.ts 和 apps/relay/b.ts',
      'tools/relay/relay.ts',
    ];
    for (const line of lines) expect(briefHits(line, { ignoreRepoPaths: true })).toEqual([]);
  });

  it('[CT-06zzzzs] a relative repository path is ASCII only: Chinese text glued after it is text, not path (an absolute path may hold non-ASCII)', () => {
    const opts = { ignoreRepoPaths: true };
    expect(briefHits('tools/x.ts的relay进程', opts)).toEqual(['1:relay']);
    expect(briefHits('改 apps/api/src/x.ts里的relay', opts)).toEqual(['1:relay']);
    // The ASCII part before the Chinese text still is a path.
    expect(briefHits('test/spec/agent/read-exports-relay/的说明', opts)).toEqual([]);
    expect(briefHits('/Users/zhixing/我的项目/couli-runs/worktrees/relay-1/b', opts)).toEqual([]);
  });

  it('[CT-06zzzzs] still counts relay in the text of a line that also has it in a path', () => {
    expect(
      briefHits('test/spec/agent/read-exports-relay/** 与 the relay process', {
        ignoreRepoPaths: true,
      }),
    ).toEqual(['1:relay']);
    expect(briefHits('the relay process 见 tools/relay/x.ts', { ignoreRepoPaths: true })).toEqual([
      '1:relay',
    ]);
    expect(briefHits('tools/x.ts，relay 进程', { ignoreRepoPaths: true })).toEqual(['1:relay']);
    expect(briefHits('[relay](tools/relay.md)', { ignoreRepoPaths: true })).toEqual(['1:relay']);
    expect(
      briefHits(['只改 tools/relay/x.ts', '不设 relay 进程'].join('\n'), {
        ignoreRepoPaths: true,
      }),
    ).toEqual(['2:relay']);
  });

  it('[CT-06zzzzs] centres the excerpt on the occurrence outside the path', () => {
    const line = `tools/relay/${'a'.repeat(80)}.ts 然后 the relay process`;
    const hits = scanText('brief.md', line, terms, [], { ignoreRepoPaths: true });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.excerpt).toContain('the relay process');
    expect(hits[0]?.excerpt).not.toContain('tools/relay');
  });

  it('[CT-06zzzzs] still counts path-like text that is not under a repository top-level directory', () => {
    const opts = { ignoreRepoPaths: true };
    expect(briefHits('relay/outbox', opts)).toEqual(['1:outbox', '1:relay']);
    expect(briefHits('foo/relay/bar', opts)).toEqual(['1:relay']);
    expect(briefHits('relay-x/y', opts)).toEqual(['1:relay']);
    expect(briefHits('src/relay/x.ts', opts)).toEqual(['1:relay']);
    expect(briefHits('myapps/relay/x.ts', opts)).toEqual(['1:relay']);
    expect(briefHits('../tools/relay/x.ts', opts)).toEqual(['1:relay']);
    expect(briefHits('tools 里的 relay', opts)).toEqual(['1:relay']);
    expect(briefHits('/relay', opts)).toEqual(['1:relay']);
    expect(briefHits('https://example.com/relay/x', opts)).toEqual(['1:relay']);
  });

  it('[CT-06zzzzs] applies the same rule to other terms (outbox, Prisma, queue Redis)', () => {
    const opts = { ignoreRepoPaths: true };
    expect(briefHits('事件写 outbox 表', opts)).toEqual(['1:outbox']);
    expect(briefHits('用 Prisma 读库', opts)).toEqual(['1:Prisma']);
    expect(briefHits('packages/outbox/x.ts', opts)).toEqual([]);
    expect(briefHits('db/migrations/0001_outbox_events.sql', opts)).toEqual([]);
    expect(briefHits('apps/prisma-demo/x.ts', opts)).toEqual([]);
    expect(briefHits('apps/outbox/x.ts 与 outbox 表', opts)).toEqual(['1:outbox']);
    expect(briefHits('apps/Prisma/x.ts 里用 Prisma', opts)).toEqual(['1:Prisma']);
    // A term with whitespace can never lie inside one path token.
    expect(briefHits('docs/queue Redis', opts)).toEqual(['1:queue Redis']);
  });

  it('[CT-06zzzzs] does not count a term inside an all-caps hyphenated identifier (a follow-up or task id such as FU-B316B-RELAY), with the same option', () => {
    const opts = { ignoreRepoPaths: true };
    // The B3-16d brief: its title names the follow-up FU-B316B-RELAY.
    expect(
      briefHits('export { x } 转出也判失败（FU-B316B-RELAY，B3-16b spec-test r1 S2）', opts),
    ).toEqual([]);
    expect(briefHits('FU-RELAY-OUTBOX', opts)).toEqual([]);
    expect(briefHits('见 FU-B316B-RELAY的说明', opts)).toEqual([]);
    // Not such an identifier: still a hit.
    expect(briefHits('RELAY 进程', opts)).toEqual(['1:relay']);
    expect(briefHits('FU-B316B-relay', opts)).toEqual(['1:relay']);
    expect(briefHits('Relay-Service', opts)).toEqual(['1:relay']);
    expect(briefHits('relay-FU', opts)).toEqual(['1:relay']);
    expect(briefHits('FU-B316B-RELAY 和 relay 进程', opts)).toEqual(['1:relay']);
    // Without the option the identifier still hits (the planning scan keeps its reading).
    expect(briefHits('FU-B316B-RELAY')).toEqual(['1:relay']);
  });

  it('[CT-06zzzzs] keeps the old behaviour without the option or with ignoreRepoPaths: false', () => {
    for (const line of inPaths) {
      expect(briefHits(line)).toEqual(['1:relay']);
      expect(briefHits(line, {})).toEqual(['1:relay']);
      expect(briefHits(line, { ignoreRepoPaths: false })).toEqual(['1:relay']);
    }
    expect(briefHits('packages/outbox/x.ts', { ignoreRepoPaths: false })).toEqual(['1:outbox']);
    expect(scanText('brief.md', 'tools/relay/x.ts', terms, [])).toHaveLength(1);
  });

  it('[CT-06zzzzs] still applies the allow list first', () => {
    const prohibition =
      '| 数据访问 | Kysely + pg | 不要引入 Prisma 或第二种数据访问方式；不要手改生成的类型 |';
    expect(
      scanText('规划/02_系统架构.md', `${prohibition} tools/x.ts`, terms, allow, {
        ignoreRepoPaths: true,
      }),
    ).toEqual([]);
    expect(briefHits(prohibition, { ignoreRepoPaths: true })).toEqual(['1:Prisma']);
  });
});
