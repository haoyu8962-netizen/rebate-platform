import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EXPECTED_VALUE_LENGTH_MAX,
  EXPECTED_VALUE_SHAPE,
  EXPECTED_VALUES_MAX,
  MODIFY_EXISTING_REASONS,
  RENAME_CONTENT_MIN,
  RENAMES_MAX,
  listTaskIds,
  loadTask,
  parseTaskFile,
} from './task-file.ts';

const EXAMPLE = [
  'id: B2-02a',
  'repo: rebate-platform',
  'title: ledger：凭证与分录写入、余额缓存、账户行锁',
  'type: impl',
  'refs: [BR-FUND-13, BR-FUND-16, BR-FUND-19]',
  'refs_hash:',
  '  BR-FUND-13: 0123456789ab',
  '  BR-FUND-16: 123456789abc',
  '  BR-FUND-19: 23456789abcd',
  'deps: [B2-01]',
  'paths:',
  '  - "apps/api/src/modules/ledger/**"',
  'impl: codex',
  'tester: claude',
  'accept:',
  '  - "pnpm verify"',
  '  - "test/spec/ledger/**"',
  'status: todo',
  'pr: null',
  '',
].join('\n');

function messageOf(text: string, fileName: string): string {
  try {
    parseTaskFile(text, fileName);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return '';
}

describe('parseTaskFile', () => {
  it('parses the example of the planning template', () => {
    expect(parseTaskFile(EXAMPLE, 'ops/tasks/B2-02a.yaml')).toEqual({
      id: 'B2-02a',
      repo: 'rebate-platform',
      title: 'ledger：凭证与分录写入、余额缓存、账户行锁',
      type: 'impl',
      refs: ['BR-FUND-13', 'BR-FUND-16', 'BR-FUND-19'],
      refs_hash: {
        'BR-FUND-13': '0123456789ab',
        'BR-FUND-16': '123456789abc',
        'BR-FUND-19': '23456789abcd',
      },
      contract_sections: [],
      deps: ['B2-01'],
      paths: ['apps/api/src/modules/ledger/**'],
      impl: 'codex',
      test_paths: [],
      mechanical_paths: [],
      red_exempt: [],
      red_exempt_outside: [],
      red_exempt_rows: [],
      modify_existing: [],
      renames: [],
      expected_values: [],
      tester: 'claude',
      accept: ['pnpm verify', 'test/spec/ledger/**'],
      status: 'todo',
      pr: null,
    });
  });

  it('defaults a missing pr to null and accepts a PR number', () => {
    const withoutPr = EXAMPLE.replace('pr: null\n', '');
    expect(parseTaskFile(withoutPr, 'B2-02a.yaml').pr).toBeNull();
    const done = EXAMPLE.replace('status: todo', 'status: done').replace('pr: null', 'pr: 37');
    expect(parseTaskFile(done, 'B2-02a.yaml')).toMatchObject({ status: 'done', pr: 37 });
  });

  it('accepts status void (D10-190) and rejects other statuses', () => {
    const voided = EXAMPLE.replace('status: todo', 'status: void');
    expect(parseTaskFile(voided, 'B2-02a.yaml')).toMatchObject({ status: 'void', pr: null });
    const unknown = EXAMPLE.replace('status: todo', 'status: cancelled');
    expect(() => parseTaskFile(unknown, 'B2-02a.yaml')).toThrow(
      'status: must be one of todo / done / void',
    );
  });

  it('accepts empty refs, deps and refs_hash', () => {
    const text = EXAMPLE.replace('refs: [BR-FUND-13, BR-FUND-16, BR-FUND-19]', 'refs: []')
      .replace(/refs_hash:\n(?: {2}BR-.*\n){3}/, 'refs_hash: {}\n')
      .replace('deps: [B2-01]', 'deps: []');
    expect(parseTaskFile(text, 'B2-02a.yaml')).toMatchObject({ refs: [], refs_hash: {}, deps: [] });
  });

  it('contract_sections: only on contract tasks, as 规划/04 section numbers', () => {
    const contract = EXAMPLE.replace('type: impl', 'type: contract');
    const withSections = contract.replace(
      'deps: [B2-01]',
      "contract_sections: ['2', '6.1']\ndeps: [B2-01]",
    );
    expect(parseTaskFile(withSections, 'B2-02a.yaml').contract_sections).toEqual(['2', '6.1']);
    expect(messageOf(withSections.replace("'6.1'", "'§6.1'"), 'B2-02a.yaml')).toContain(
      'contract_sections: "§6.1" is not a 规划/04 section number',
    );
    expect(
      messageOf(withSections.replace('type: contract', 'type: impl'), 'B2-02a.yaml'),
    ).toContain('contract_sections: only a contract task names 规划/04 sections');
  });

  it('[CT-06r] red_exempt: a list of file / test / reason mappings, the reason at least 10 characters', () => {
    const declared = (entries: string): string =>
      EXAMPLE.replace('tester: claude', `tester: claude\nred_exempt:${entries}`);
    const two = declared(
      "\n  - file: test/spec/ledger-rules/ledger-rules.test.ts\n    test: '[AC-B2-01i#1] CSV 固定十一列'\n    reason: 数据驱动、结构断言对旧 csv 亦成立、不可能有效红\n  - file: test/spec/ledger-rules/ledger-rules.test.ts\n    test: 'rules > [AC-B2-01i#4] 借贷成对'\n    reason: 'structural: holds for the old data too'",
    );
    expect(parseTaskFile(two, 'B2-02a.yaml').red_exempt).toEqual([
      {
        file: 'test/spec/ledger-rules/ledger-rules.test.ts',
        test: '[AC-B2-01i#1] CSV 固定十一列',
        reason: '数据驱动、结构断言对旧 csv 亦成立、不可能有效红',
      },
      {
        file: 'test/spec/ledger-rules/ledger-rules.test.ts',
        test: 'rules > [AC-B2-01i#4] 借贷成对',
        reason: 'structural: holds for the old data too',
      },
    ]);
    // An older ledger without the field: [].
    expect(parseTaskFile(EXAMPLE, 'B2-02a.yaml').red_exempt).toEqual([]);
    // Without a reason, with a short one, with blanks only: refused (the reason is the point).
    const noReason = declared("\n  - file: test/spec/a.test.ts\n    test: '[AC-1] a'");
    expect(messageOf(noReason, 'B2-02a.yaml')).toContain(
      'red_exempt[0].reason: must say why the test cannot be shown red (at least 10 characters)',
    );
    const short = declared(
      "\n  - file: test/spec/a.test.ts\n    test: '[AC-1] a'\n    reason: too short",
    );
    expect(messageOf(short, 'B2-02a.yaml')).toContain('red_exempt[0].reason');
    const blank = declared(
      "\n  - file: test/spec/a.test.ts\n    test: '[AC-1] a'\n    reason: '              '",
    );
    expect(messageOf(blank, 'B2-02a.yaml')).toContain('red_exempt[0].reason');
    // Missing or empty file / test, a file that is not a repository path, an unknown field.
    const noTest = declared(
      '\n  - file: test/spec/a.test.ts\n    reason: a reason of enough length',
    );
    expect(messageOf(noTest, 'B2-02a.yaml')).toContain(
      "red_exempt[0].test: must be the test's full name",
    );
    const badFile = declared(
      "\n  - file: /test/spec/a.test.ts\n    test: '[AC-1] a'\n    reason: a reason of enough length",
    );
    expect(messageOf(badFile, 'B2-02a.yaml')).toContain(
      'red_exempt[0].file: "/test/spec/a.test.ts" must be relative',
    );
    const extra = declared(
      "\n  - file: test/spec/a.test.ts\n    test: '[AC-1] a'\n    reason: a reason of enough length\n    note: x",
    );
    expect(messageOf(extra, 'B2-02a.yaml')).toContain('red_exempt[0].note: unknown field');
    // CT-06t: at most 50 declarations (the section is not counted in the file's line limit).
    const many = (n: number): string =>
      declared(
        Array.from(
          { length: n },
          (_, i) =>
            `\n  - file: test/spec/a.test.ts\n    test: '[AC-${i + 1}] a'\n    reason: a reason of enough length`,
        ).join(''),
      );
    expect(parseTaskFile(many(300), 'B2-02a.yaml').red_exempt).toHaveLength(300);
    expect(messageOf(many(301), 'B2-02a.yaml')).toContain(
      'red_exempt: 301 entries, the limit is 300',
    );
    // Not a list, not mappings, the same test twice.
    expect(messageOf(declared(' abc'), 'B2-02a.yaml')).toContain(
      'red_exempt: must be a list of mappings',
    );
    expect(messageOf(declared('\n  - abc'), 'B2-02a.yaml')).toContain(
      'red_exempt[0]: must be a mapping',
    );
    const twice = declared(
      "\n  - file: test/spec/a.test.ts\n    test: '[AC-1] a'\n    reason: a reason of enough length\n  - file: test/spec/a.test.ts\n    test: '[AC-1] a'\n    reason: another reason of enough length",
    );
    expect(messageOf(twice, 'B2-02a.yaml')).toContain(
      'red_exempt[1]: "test/spec/a.test.ts > [AC-1] a" is declared twice',
    );
  });

  it('[CT-06zzzc] red_exempt_outside: a list of file / reason mappings, optional, every malformed entry refused', () => {
    const declared = (entries: string): string =>
      EXAMPLE.replace('tester: claude', `tester: claude\nred_exempt_outside:${entries}`);
    const one = declared(
      "\n  - file: test/spec/content/config/delivery.int.test.ts\n    reason: 'import 新增、#20 顶层表移出 bridge_origins 组'",
    );
    expect(parseTaskFile(one, 'B2-02a.yaml').red_exempt_outside).toEqual([
      {
        file: 'test/spec/content/config/delivery.int.test.ts',
        reason: 'import 新增、#20 顶层表移出 bridge_origins 组',
      },
    ]);
    // An older ledger without the field: [].
    expect(parseTaskFile(EXAMPLE, 'B2-02a.yaml').red_exempt_outside).toEqual([]);
    // Not a list, not a mapping, an unknown field, a missing / bad file, a short reason.
    expect(messageOf(declared(' abc'), 'B2-02a.yaml')).toContain(
      'red_exempt_outside: must be a list of mappings (file / reason)',
    );
    expect(messageOf(declared('\n  - abc'), 'B2-02a.yaml')).toContain(
      'red_exempt_outside[0]: must be a mapping (file / reason)',
    );
    const extra = declared(
      "\n  - file: test/spec/a.test.ts\n    reason: a reason of enough length\n    test: '[AC-1] a'",
    );
    expect(messageOf(extra, 'B2-02a.yaml')).toContain('red_exempt_outside[0].test: unknown field');
    expect(messageOf(declared('\n  - reason: a reason of enough length'), 'B2-02a.yaml')).toContain(
      'red_exempt_outside[0].file: must be a non-empty repository path',
    );
    const badFile = declared(
      '\n  - file: ../test/spec/a.test.ts\n    reason: a reason of enough length',
    );
    expect(messageOf(badFile, 'B2-02a.yaml')).toContain(
      'red_exempt_outside[0].file: "../test/spec/a.test.ts" must not contain "." or ".." segments',
    );
    for (const reason of ['', "'          '", 'too short']) {
      const short = declared(`\n  - file: test/spec/a.test.ts\n    reason: ${reason}`);
      expect(messageOf(short, 'B2-02a.yaml'), reason).toContain(
        'red_exempt_outside[0].reason: must say why the code outside the tests changes (at least 10 characters)',
      );
    }
    // The same file twice.
    const twice = declared(
      '\n  - file: test/spec/a.test.ts\n    reason: a reason of enough length\n  - file: test/spec/a.test.ts\n    reason: another reason of enough length',
    );
    expect(messageOf(twice, 'B2-02a.yaml')).toContain(
      'red_exempt_outside[1]: "test/spec/a.test.ts" is declared twice',
    );
    // At most RED_EXEMPT_MAX entries, as red_exempt.
    const many = (n: number): string =>
      declared(
        Array.from(
          { length: n },
          (_, i) => `\n  - file: test/spec/a${i}.test.ts\n    reason: a reason of enough length`,
        ).join(''),
      );
    expect(parseTaskFile(many(300), 'B2-02a.yaml').red_exempt_outside).toHaveLength(300);
    expect(messageOf(many(301), 'B2-02a.yaml')).toContain(
      'red_exempt_outside: 301 entries, the limit is 300',
    );
  });

  it('[CT-06zzze] red_exempt_rows: a list of file / test / reason mappings, optional, every malformed entry refused, never also in red_exempt', () => {
    const declared = (entries: string, extra = ''): string =>
      EXAMPLE.replace('tester: claude', `tester: claude\nred_exempt_rows:${entries}${extra}`);
    const row = (test: string, file = 'test/spec/catalog/detail/detail.test.ts'): string =>
      `\n  - file: ${file}\n    test: '${test}'\n    reason: '留下的行与基线逐字相同，风险行已拆出（D10-641）'`;
    const one = declared(
      row('[AC-B1-05e#8] 来源卡 feed 经 SourceLinkReader 按 App 范围读取并继承报价口径'),
    );
    expect(parseTaskFile(one, 'B2-02a.yaml').red_exempt_rows).toEqual([
      {
        file: 'test/spec/catalog/detail/detail.test.ts',
        test: '[AC-B1-05e#8] 来源卡 feed 经 SourceLinkReader 按 App 范围读取并继承报价口径',
        reason: '留下的行与基线逐字相同，风险行已拆出（D10-641）',
      },
    ]);
    // An older ledger without the field: [].
    expect(parseTaskFile(EXAMPLE, 'B2-02a.yaml').red_exempt_rows).toEqual([]);
    // Not a list, not a mapping, an unknown field, a missing / bad file, an empty test, a short reason.
    expect(messageOf(declared(' abc'), 'B2-02a.yaml')).toContain(
      'red_exempt_rows: must be a list of mappings (file / test / reason)',
    );
    expect(messageOf(declared('\n  - abc'), 'B2-02a.yaml')).toContain(
      'red_exempt_rows[0]: must be a mapping (file / test / reason)',
    );
    expect(messageOf(declared(`${row('[AC-1] a')}\n    note: x`), 'B2-02a.yaml')).toContain(
      'red_exempt_rows[0].note: unknown field',
    );
    expect(
      messageOf(
        declared("\n  - test: '[AC-1] a'\n    reason: a reason of enough length"),
        'B2-02a.yaml',
      ),
    ).toContain('red_exempt_rows[0].file: must be a non-empty repository path');
    expect(messageOf(declared(row('[AC-1] a', '../a.test.ts')), 'B2-02a.yaml')).toContain(
      'red_exempt_rows[0].file: "../a.test.ts" must not contain "." or ".." segments',
    );
    expect(messageOf(declared(row(' ')), 'B2-02a.yaml')).toContain(
      "red_exempt_rows[0].test: must be the test's full name (non-empty)",
    );
    for (const reason of ['', "'          '", 'too short']) {
      const short = declared(
        `\n  - file: test/spec/a.test.ts\n    test: '[AC-1] a'\n    reason: ${reason}`,
      );
      expect(messageOf(short, 'B2-02a.yaml'), reason).toContain(
        'red_exempt_rows[0].reason: must say why the test cannot be shown red (at least 10 characters)',
      );
    }
    // The same row twice; a row also declared in red_exempt.
    expect(messageOf(declared(row('[AC-1] a') + row('[AC-1] a')), 'B2-02a.yaml')).toContain(
      'red_exempt_rows[1]: "test/spec/catalog/detail/detail.test.ts > [AC-1] a" is declared twice',
    );
    const both = declared(
      row('[AC-1] a'),
      "\nred_exempt:\n  - file: test/spec/catalog/detail/detail.test.ts\n    test: '[AC-1] a'\n    reason: a reason of enough length",
    );
    expect(messageOf(both, 'B2-02a.yaml')).toContain(
      'red_exempt_rows: "test/spec/catalog/detail/detail.test.ts > [AC-1] a" is also declared in red_exempt (declare a test in one of them)',
    );
    // At most RED_EXEMPT_MAX entries of its own (not added to red_exempt's).
    const many = (n: number): string =>
      declared(Array.from({ length: n }, (_, i) => row(`[AC-${i + 1}] a`)).join(''));
    expect(parseTaskFile(many(300), 'B2-02a.yaml').red_exempt_rows).toHaveLength(300);
    expect(messageOf(many(301), 'B2-02a.yaml')).toContain(
      'red_exempt_rows: 301 entries, the limit is 300 (CT-06zzze;',
    );
  });

  it('[CT-06zzzg] modify_existing: file / test / reason / ruling / note, optional, every malformed entry refused, never also exempt, the cap shared with red_exempt', () => {
    const FILE = 'test/spec/payout/recon-late-paid/worker.int.test.ts';
    const declared = (entries: string, extra = ''): string =>
      EXAMPLE.replace('tester: claude', `tester: claude\nmodify_existing:${entries}${extra}`);
    const entry = (test: string, fields: Record<string, string> = {}): string => {
      const all: Record<string, string> = {
        file: FILE,
        test: `'${test}'`,
        reason: 'tighten_only',
        ruling: 'D10-701',
        note: "'超时红改断言红，期望不变（FU-B2-09T-ASSERT-NOT-TIMEOUT）'",
        ...fields,
      };
      const lines = Object.entries(all)
        .filter(([, v]) => v !== '')
        .map(([k, v], i) => `${i === 0 ? '  - ' : '    '}${k}: ${v}`);
      return `\n${lines.join('\n')}`;
    };
    const one = declared(entry('[AC-B2-09t#35] 迟到回调'));
    expect(parseTaskFile(one, 'B2-02a.yaml').modify_existing).toEqual([
      {
        file: FILE,
        test: '[AC-B2-09t#35] 迟到回调',
        reason: 'tighten_only',
        ruling: 'D10-701',
        note: '超时红改断言红，期望不变（FU-B2-09T-ASSERT-NOT-TIMEOUT）',
      },
    ]);
    expect(
      parseTaskFile(declared(entry('[AC-1] a', { reason: 'flake_fix' })), 'B2-02a.yaml')
        .modify_existing[0]?.reason,
    ).toBe('flake_fix');
    // An older ledger without the field: [].
    expect(parseTaskFile(EXAMPLE, 'B2-02a.yaml').modify_existing).toEqual([]);
    const cases: [string, string][] = [
      [
        declared(' abc'),
        'modify_existing: must be a list of mappings (file / test / reason / ruling / note)',
      ],
      [
        declared('\n  - abc'),
        'modify_existing[0]: must be a mapping (file / test / reason / ruling / note)',
      ],
      [declared(`${entry('[AC-1] a')}\n    extra: x`), 'modify_existing[0].extra: unknown field'],
      [
        declared(entry('[AC-1] a', { file: '' })),
        'modify_existing[0].file: must be a non-empty repository path',
      ],
      [
        declared(entry('[AC-1] a', { file: '../a.test.ts' })),
        'modify_existing[0].file: "../a.test.ts" must not contain "." or ".." segments',
      ],
      [declared(entry(' ')), "modify_existing[0].test: must be the test's full name (non-empty)"],
      [
        declared(entry('[AC-1] a', { reason: '' })),
        'modify_existing[0].reason: must be one of flake_fix / tighten_only',
      ],
      [
        declared(entry('[AC-1] a', { reason: 'loosen' })),
        'modify_existing[0].reason: must be one of flake_fix / tighten_only',
      ],
      [
        declared(entry('[AC-1] a', { ruling: '' })),
        'modify_existing[0].ruling: must be the orchestrator ruling id, D10-<number>',
      ],
      [
        declared(entry('[AC-1] a', { ruling: 'D10-0701x' })),
        'modify_existing[0].ruling: must be the orchestrator ruling id, D10-<number>',
      ],
      [
        declared(entry('[AC-1] a', { ruling: 'D9-701' })),
        'modify_existing[0].ruling: must be the orchestrator ruling id, D10-<number>',
      ],
      [
        declared(entry('[AC-1] a', { note: '' })),
        'modify_existing[0].note: must say why the test is changed (at least 10 characters)',
      ],
      [
        declared(entry('[AC-1] a', { note: 'too short' })),
        'modify_existing[0].note: must say why the test is changed (at least 10 characters)',
      ],
      // The same test twice.
      [
        declared(entry('[AC-1] a') + entry('[AC-1] a', { reason: 'flake_fix' })),
        `modify_existing[1]: "${FILE} > [AC-1] a" is declared twice`,
      ],
      // A changed test is not an exempt one.
      [
        declared(
          entry('[AC-1] a'),
          `\nred_exempt:\n  - file: ${FILE}\n    test: '[AC-1] a'\n    reason: a reason of enough length`,
        ),
        `modify_existing: "${FILE} > [AC-1] a" is also declared in red_exempt (a changed test is not an exempt one)`,
      ],
      [
        declared(
          entry('[AC-1] a'),
          `\nred_exempt_rows:\n  - file: ${FILE}\n    test: '[AC-1] a'\n    reason: a reason of enough length`,
        ),
        `modify_existing: "${FILE} > [AC-1] a" is also declared in red_exempt_rows (a changed test is not an exempt one)`,
      ],
    ];
    for (const [text, want] of cases) expect(messageOf(text, 'B2-02a.yaml'), want).toContain(want);
    // RED_EXEMPT_MAX counts modify_existing and red_exempt together.
    const exempt = (n: number): string =>
      n === 0
        ? ''
        : `\nred_exempt:${Array.from(
            { length: n },
            (_, i) =>
              `\n  - file: test/spec/other.test.ts\n    test: '[AC-${i + 1}] x'\n    reason: a reason of enough length`,
          ).join('')}`;
    const mixed = (m: number, n: number): string =>
      declared(Array.from({ length: m }, (_, i) => entry(`[AC-${i + 1}] a`)).join(''), exempt(n));
    expect(parseTaskFile(mixed(300, 0), 'B2-02a.yaml').modify_existing).toHaveLength(300);
    expect(parseTaskFile(mixed(100, 200), 'B2-02a.yaml').modify_existing).toHaveLength(100);
    expect(messageOf(mixed(301, 0), 'B2-02a.yaml')).toContain(
      'modify_existing: 301 entries together with red_exempt, the limit is 300 (CT-06zzzg;',
    );
    expect(messageOf(mixed(101, 200), 'B2-02a.yaml')).toContain(
      'modify_existing: 301 entries together with red_exempt, the limit is 300 (CT-06zzzg;',
    );
  });

  // CT-06zzzzr (FU-MODIFY-EXISTING-RETITLE, D10-1278 ②): an entry may rename its test once,
  // `retitle_to` the new full name (the head's), its [AC-…] ids exactly the old name's.
  const RT_FILE = 'test/spec/agent/allowlist.test.ts';
  const RT_OLD = '[AC-B3-16a#2] allowlist 行集合 = 7 个 MVP 工具';
  const RT_NEW = '[AC-B3-16a#2] allowlist 行集合 = 8 个 MVP 工具';
  const rtDeclared = (entries: string): string =>
    EXAMPLE.replace('tester: claude', `tester: claude\nmodify_existing:${entries}`);
  const rtEntry = (test: string, fields: Record<string, string> = {}): string => {
    const all: Record<string, string> = {
      file: RT_FILE,
      test: `'${test}'`,
      reason: 'tighten_only',
      ruling: 'D10-1278',
      note: "'工具从 7 个变成 8 个，标题里的数字跟着改'",
      ...fields,
    };
    const lines = Object.entries(all)
      .filter(([, v]) => v !== '')
      .map(([k, v], i) => `${i === 0 ? '  - ' : '    '}${k}: ${v}`);
    return `\n${lines.join('\n')}`;
  };
  /** A problem of the retitle_to field itself (not the old "unknown field" refusal). */
  const RETITLE_PROBLEM = (i: number): RegExp =>
    new RegExp(`modify_existing\\[${i}\\]\\.retitle_to: (?!unknown field)`);

  it('[CT-06zzzzr] modify_existing retitle_to: optional, the new full name kept as written; without it the entry has no retitle_to key', () => {
    const one = rtDeclared(rtEntry(RT_OLD, { retitle_to: `'${RT_NEW}'` }));
    expect(parseTaskFile(one, 'B2-02a.yaml').modify_existing).toEqual([
      {
        file: RT_FILE,
        test: RT_OLD,
        reason: 'tighten_only',
        ruling: 'D10-1278',
        note: '工具从 7 个变成 8 个，标题里的数字跟着改',
        retitle_to: RT_NEW,
      },
    ]);
    // Several [AC-…] ids, in the same order, with other words changed: accepted.
    const two = rtDeclared(
      rtEntry('d > [AC-1] [AC-2#3] 旧说法', { retitle_to: "'d > [AC-1] 新说法 [AC-2#3]'" }),
    );
    expect(parseTaskFile(two, 'B2-02a.yaml').modify_existing[0]).toMatchObject({
      test: 'd > [AC-1] [AC-2#3] 旧说法',
      retitle_to: 'd > [AC-1] 新说法 [AC-2#3]',
    });
    // A test without any [AC-…] id renamed to one without any: the sequences are both empty.
    const none = rtDeclared(rtEntry('old words', { retitle_to: "'new words'" }));
    expect(parseTaskFile(none, 'B2-02a.yaml').modify_existing[0]).toMatchObject({
      test: 'old words',
      retitle_to: 'new words',
    });
    // Without retitle_to: no key at all (not an empty string, not undefined).
    const plain = parseTaskFile(rtDeclared(rtEntry(RT_OLD)), 'B2-02a.yaml').modify_existing;
    expect(plain).toHaveLength(1);
    expect(Object.hasOwn(plain[0] as object, 'retitle_to')).toBe(false);
    // A mix: only the entry that renames has the key.
    const mixed = parseTaskFile(
      rtDeclared(rtEntry(RT_OLD, { retitle_to: `'${RT_NEW}'` }) + rtEntry('[AC-B3-16a#3] other')),
      'B2-02a.yaml',
    ).modify_existing;
    expect(mixed.map((e) => Object.hasOwn(e, 'retitle_to'))).toEqual([true, false]);
  });

  it('[CT-06zzzzr] modify_existing retitle_to refused: not a string, blank, the same as test, [AC-…] ids changed, added, removed or reordered', () => {
    const cases: [string, string][] = [
      ['a number', rtDeclared(rtEntry(RT_OLD, { retitle_to: '7' }))],
      ['null', rtDeclared(rtEntry(RT_OLD, { retitle_to: 'null' }))],
      ['a list', rtDeclared(rtEntry(RT_OLD, { retitle_to: `['${RT_NEW}']` }))],
      ['empty', rtDeclared(rtEntry(RT_OLD, { retitle_to: "''" }))],
      ['blank', rtDeclared(rtEntry(RT_OLD, { retitle_to: "'   '" }))],
      ['the same as test', rtDeclared(rtEntry(RT_OLD, { retitle_to: `'${RT_OLD}'` }))],
      [
        'an id changed',
        rtDeclared(
          rtEntry(RT_OLD, { retitle_to: "'[AC-B3-16a#3] allowlist 行集合 = 8 个 MVP 工具'" }),
        ),
      ],
      [
        'an id added',
        rtDeclared(
          rtEntry(RT_OLD, {
            retitle_to: "'[AC-B3-16a#2] [AC-B3-16a#9] allowlist 行集合 = 8 个 MVP 工具'",
          }),
        ),
      ],
      [
        'an id removed',
        rtDeclared(rtEntry(RT_OLD, { retitle_to: "'allowlist 行集合 = 8 个 MVP 工具'" })),
      ],
      [
        'ids reordered',
        rtDeclared(rtEntry('[AC-1] [AC-2] x', { retitle_to: "'[AC-2] [AC-1] y'" })),
      ],
      ['an id written otherwise', rtDeclared(rtEntry('[AC-1] x', { retitle_to: "'[AC-01] y'" }))],
    ];
    for (const [name, text] of cases) {
      expect(messageOf(text, 'B2-02a.yaml'), name).toMatch(RETITLE_PROBLEM(0));
    }
    // The index is the entry's own.
    expect(
      messageOf(
        rtDeclared(rtEntry('[AC-1] ok') + rtEntry(RT_OLD, { retitle_to: `'${RT_OLD}'` })),
        'B2-02a.yaml',
      ),
    ).toMatch(RETITLE_PROBLEM(1));
    // Any other unknown field is still refused, with or without retitle_to.
    expect(
      messageOf(
        rtDeclared(`${rtEntry(RT_OLD, { retitle_to: `'${RT_NEW}'` })}\n    extra: x`),
        'B2-02a.yaml',
      ),
    ).toContain('modify_existing[0].extra: unknown field');
    expect(
      messageOf(rtDeclared(rtEntry(RT_OLD, { retitle: `'${RT_NEW}'` })), 'B2-02a.yaml'),
    ).toContain('modify_existing[0].retitle: unknown field');
    // And the well-formed one parses.
    expect(
      messageOf(rtDeclared(rtEntry(RT_OLD, { retitle_to: `'${RT_NEW}'` })), 'B2-02a.yaml'),
    ).toBe('');
  });

  it('[CT-06zzzzr] modify_existing retitle_to: in one file it may not be another entry’s test or another entry’s retitle_to; across files it may', () => {
    const SAME_PROBLEM = /modify_existing\[\d+\]: /;
    // Entry 0 renames to the name entry 1 has at the base.
    const intoTest = rtDeclared(
      rtEntry('[AC-1] a', { retitle_to: "'[AC-1] b'" }) + rtEntry('[AC-1] b'),
    );
    expect(messageOf(intoTest, 'B2-02a.yaml')).toMatch(SAME_PROBLEM);
    // The same, the renaming entry second.
    const intoEarlier = rtDeclared(
      rtEntry('[AC-1] b') + rtEntry('[AC-1] a', { retitle_to: "'[AC-1] b'" }),
    );
    expect(messageOf(intoEarlier, 'B2-02a.yaml')).toMatch(SAME_PROBLEM);
    // Two entries rename to one name.
    const together = rtDeclared(
      rtEntry('[AC-1] a', { retitle_to: "'[AC-1] c'" }) +
        rtEntry('[AC-1] b', { retitle_to: "'[AC-1] c'" }),
    );
    expect(messageOf(together, 'B2-02a.yaml')).toMatch(SAME_PROBLEM);
    // A swap (a → b, b → a) is a clash too: each new name is the other entry's test.
    const swap = rtDeclared(
      rtEntry('[AC-1] a', { retitle_to: "'[AC-1] b'" }) +
        rtEntry('[AC-1] b', { retitle_to: "'[AC-1] a'" }),
    );
    expect(messageOf(swap, 'B2-02a.yaml')).toMatch(SAME_PROBLEM);
    // The old "file + test twice" refusal is unchanged.
    expect(
      messageOf(
        rtDeclared(
          rtEntry('[AC-1] a', { retitle_to: "'[AC-1] x'" }) +
            rtEntry('[AC-1] a', { retitle_to: "'[AC-1] y'" }),
        ),
        'B2-02a.yaml',
      ),
    ).toContain(`modify_existing[1]: "${RT_FILE} > [AC-1] a" is declared twice`);
    // Another file: the same names do not clash.
    const OTHER = 'test/spec/agent/other.test.ts';
    const across = rtDeclared(
      rtEntry('[AC-1] a', { retitle_to: "'[AC-1] b'" }) + rtEntry('[AC-1] b', { file: OTHER }),
    );
    expect(parseTaskFile(across, 'B2-02a.yaml').modify_existing).toMatchObject([
      { file: RT_FILE, test: '[AC-1] a', retitle_to: '[AC-1] b' },
      { file: OTHER, test: '[AC-1] b' },
    ]);
    const acrossBoth = rtDeclared(
      rtEntry('[AC-1] a', { retitle_to: "'[AC-1] c'" }) +
        rtEntry('[AC-1] b', { file: OTHER, retitle_to: "'[AC-1] c'" }),
    );
    expect(parseTaskFile(acrossBoth, 'B2-02a.yaml').modify_existing).toHaveLength(2);
  });

  // CT-06zzzzw (FU-MODIFY-EXISTING-RULE-CHANGE, D10-1299 ③, after B3-08zc): a frozen test changed
  // because its BR changed is declared with reason rule_change and the BR ids it follows (`br`).
  const RW_FILE = 'test/spec/agent/intent.test.ts';
  const RW_TEST = '[AC-B3-08zc#4] 意图路由按新规则';
  // CT-06zzzzzb (D10-1356 ②): parseTaskFile wants every br id in the ledger's own refs, so the
  // fixture's refs carry the well-formed ids these tests use (EXAMPLE_REFS below is EXAMPLE's own).
  const RW_REFS =
    'refs: [BR-FUND-13, BR-FUND-16, BR-FUND-19, BR-AI-14, BR-AI-15, BR-FUND-16a, BR-WDR-3]';
  const rwDeclared = (entries: string, refs: string = RW_REFS): string =>
    EXAMPLE.replace('tester: claude', `tester: claude\nmodify_existing:${entries}`).replace(
      'refs: [BR-FUND-13, BR-FUND-16, BR-FUND-19]',
      refs,
    );
  const rwEntry = (test: string, fields: Record<string, string> = {}): string => {
    const all: Record<string, string> = {
      file: RW_FILE,
      test: `'${test}'`,
      reason: 'rule_change',
      ruling: 'D10-1297',
      note: "'BR-AI-14 改了，用例跟着新规则改写'",
      br: '[BR-AI-14]',
      ...fields,
    };
    const lines = Object.entries(all)
      .filter(([, v]) => v !== '')
      .map(([k, v], i) => `${i === 0 ? '  - ' : '    '}${k}: ${v}`);
    return `\n${lines.join('\n')}`;
  };
  /** A problem of the br field itself (not the old "unknown field" refusal). */
  const BR_PROBLEM = (i: number): RegExp =>
    new RegExp(`modify_existing\\[${i}\\]\\.br: (?!unknown field)`);

  it('[CT-06zzzzw] modify_existing rule_change: accepted with br, the BR ids kept in order; the three reasons; without br the entry has no br key', () => {
    expect([...MODIFY_EXISTING_REASONS]).toEqual(['flake_fix', 'tighten_only', 'rule_change']);
    const one = rwDeclared(rwEntry(RW_TEST));
    expect(messageOf(one, 'B2-02a.yaml')).toBe('');
    expect(parseTaskFile(one, 'B2-02a.yaml').modify_existing).toEqual([
      {
        file: RW_FILE,
        test: RW_TEST,
        reason: 'rule_change',
        ruling: 'D10-1297',
        note: 'BR-AI-14 改了，用例跟着新规则改写',
        br: ['BR-AI-14'],
      },
    ]);
    // Several ids (one with a letter suffix), kept as written and in order.
    const several = rwDeclared(rwEntry(RW_TEST, { br: '[BR-FUND-16a, BR-AI-14, BR-WDR-3]' }));
    expect(parseTaskFile(several, 'B2-02a.yaml').modify_existing[0]).toMatchObject({
      reason: 'rule_change',
      br: ['BR-FUND-16a', 'BR-AI-14', 'BR-WDR-3'],
    });
    // A block list is the same list.
    const block = rwDeclared(rwEntry(RW_TEST, { br: '\n      - BR-AI-14\n      - BR-AI-15' }));
    expect(parseTaskFile(block, 'B2-02a.yaml').modify_existing[0]).toMatchObject({
      br: ['BR-AI-14', 'BR-AI-15'],
    });
    // rule_change together with retitle_to.
    const renamed = rwDeclared(
      rwEntry(RW_TEST, { retitle_to: "'[AC-B3-08zc#4] 意图路由按新规则（改名）'" }),
    );
    expect(parseTaskFile(renamed, 'B2-02a.yaml').modify_existing[0]).toMatchObject({
      reason: 'rule_change',
      retitle_to: '[AC-B3-08zc#4] 意图路由按新规则（改名）',
      br: ['BR-AI-14'],
    });
    // tighten_only and flake_fix without br: no key at all (not an empty list, not undefined).
    const others = parseTaskFile(
      rwDeclared(
        rwEntry('[AC-1] a', { reason: 'tighten_only', br: '' }) +
          rwEntry('[AC-1] b', { reason: 'flake_fix', br: '' }) +
          rwEntry('[AC-1] c'),
      ),
      'B2-02a.yaml',
    ).modify_existing;
    expect(others.map((e) => e.reason)).toEqual(['tighten_only', 'flake_fix', 'rule_change']);
    expect(others.map((e) => Object.hasOwn(e, 'br'))).toEqual([false, false, true]);
  });

  it('[CT-06zzzzw] modify_existing rule_change refused: br missing, empty, not a list, a malformed id, a duplicate', () => {
    const cases: [string, string][] = [
      ['missing', rwDeclared(rwEntry(RW_TEST, { br: '' }))],
      ['empty list', rwDeclared(rwEntry(RW_TEST, { br: '[]' }))],
      ['null', rwDeclared(rwEntry(RW_TEST, { br: 'null' }))],
      ['a string', rwDeclared(rwEntry(RW_TEST, { br: 'BR-AI-14' }))],
      ['a number in the list', rwDeclared(rwEntry(RW_TEST, { br: '[BR-AI-14, 7]' }))],
      ['an empty string in the list', rwDeclared(rwEntry(RW_TEST, { br: "[BR-AI-14, '']" }))],
      ['lower-case domain', rwDeclared(rwEntry(RW_TEST, { br: '[BR-ai-14]' }))],
      ['no number', rwDeclared(rwEntry(RW_TEST, { br: '[BR-AI]' }))],
      ['no prefix', rwDeclared(rwEntry(RW_TEST, { br: '[AI-14]' }))],
      ['two suffix letters', rwDeclared(rwEntry(RW_TEST, { br: '[BR-AI-14ab]' }))],
      ['upper-case suffix', rwDeclared(rwEntry(RW_TEST, { br: '[BR-AI-14A]' }))],
      ['spaces around', rwDeclared(rwEntry(RW_TEST, { br: "[' BR-AI-14']" }))],
      ['a ruling id', rwDeclared(rwEntry(RW_TEST, { br: '[D10-1297]' }))],
      ['a duplicate', rwDeclared(rwEntry(RW_TEST, { br: '[BR-AI-14, BR-AI-15, BR-AI-14]' }))],
    ];
    for (const [name, text] of cases) {
      const message = messageOf(text, 'B2-02a.yaml');
      expect(message, name).toMatch(BR_PROBLEM(0));
      // The reason itself is valid: only br is at fault.
      expect(message, name).not.toContain('modify_existing[0].reason:');
    }
    // The index is the entry's own.
    expect(
      messageOf(
        rwDeclared(rwEntry('[AC-1] ok') + rwEntry(RW_TEST, { br: '[BR-AI-14, BR-AI-14]' })),
        'B2-02a.yaml',
      ),
    ).toMatch(BR_PROBLEM(1));
    expect(
      messageOf(rwDeclared(rwEntry('[AC-1] ok') + rwEntry(RW_TEST, { br: '' })), 'B2-02a.yaml'),
    ).toMatch(BR_PROBLEM(1));
  });

  it('[CT-06zzzzw] modify_existing br on tighten_only or flake_fix is refused (br only goes with rule_change)', () => {
    for (const reason of ['tighten_only', 'flake_fix']) {
      const message = messageOf(rwDeclared(rwEntry(RW_TEST, { reason })), 'B2-02a.yaml');
      expect(message, reason).toMatch(/modify_existing\[0\]\.br: /);
      expect(message, reason).not.toContain('modify_existing[0].reason:');
      // An empty list on another reason is refused too.
      expect(
        messageOf(rwDeclared(rwEntry(RW_TEST, { reason, br: '[]' })), 'B2-02a.yaml'),
        reason,
      ).toMatch(/modify_existing\[0\]\.br: /);
    }
    expect(
      messageOf(
        rwDeclared(rwEntry('[AC-1] ok') + rwEntry(RW_TEST, { reason: 'tighten_only' })),
        'B2-02a.yaml',
      ),
    ).toMatch(/modify_existing\[1\]\.br: /);
  });

  it('[CT-06zzzzw] modify_existing messages keep the five-field list; the reasons list names rule_change; other unknown fields are still refused next to br', () => {
    expect(messageOf(rwDeclared(' abc'), 'B2-02a.yaml')).toContain(
      'modify_existing: must be a list of mappings (file / test / reason / ruling / note)',
    );
    expect(messageOf(rwDeclared('\n  - abc'), 'B2-02a.yaml')).toContain(
      'modify_existing[0]: must be a mapping (file / test / reason / ruling / note)',
    );
    const loosen = messageOf(rwDeclared(rwEntry(RW_TEST, { reason: 'loosen' })), 'B2-02a.yaml');
    expect(loosen).toMatch(/modify_existing\[0\]\.reason: must be one of [^\n]*rule_change/);
    expect(loosen).toContain('flake_fix');
    expect(loosen).toContain('tighten_only');
    // br is a known field now: an extra field next to it is the only unknown one.
    const extra = messageOf(rwDeclared(`${rwEntry(RW_TEST)}\n    extra: x`), 'B2-02a.yaml');
    expect(extra).toContain('modify_existing[0].extra: unknown field');
    expect(extra).not.toContain('modify_existing[0].br: unknown field');
    expect(
      messageOf(rwDeclared(rwEntry(RW_TEST, { brs: '[BR-AI-14]', br: '' })), 'B2-02a.yaml'),
    ).toContain('modify_existing[0].brs: unknown field');
  });

  // CT-06zzzzzb (D10-1356 ②): "every br id is in the task's refs" is checked by parseTaskFile
  // itself, so every reader of the ledger (task.ts, red-check, evidence-check) refuses it whole.
  const EXAMPLE_REFS = 'refs: [BR-FUND-13, BR-FUND-16, BR-FUND-19]';
  /** The br problem lines of a parse message (one per refused entry). */
  const brLines = (message: string, i: number): string[] =>
    message.split('\n').filter((l) => l.includes(`modify_existing[${i}].br:`));

  it('[CT-06zzzzzb] parseTaskFile refuses a rule_change entry whose br id is not in the ledger refs, naming the entry and the missing id', () => {
    // One id in refs, one not: the entry is refused, the missing id named.
    const partly = messageOf(
      rwDeclared(rwEntry(RW_TEST, { br: '[BR-FUND-13, BR-AI-14]' }), EXAMPLE_REFS),
      'B2-02a.yaml',
    );
    expect(partly).toContain('B2-02a.yaml: invalid task file');
    expect(partly).toMatch(BR_PROBLEM(0));
    expect(brLines(partly, 0)).toHaveLength(1);
    expect(brLines(partly, 0)[0]).toContain('BR-AI-14');
    expect(() =>
      parseTaskFile(
        rwDeclared(rwEntry(RW_TEST, { br: '[BR-FUND-13, BR-AI-14]' }), EXAMPLE_REFS),
        'B2-02a.yaml',
      ),
    ).toThrow(/modify_existing\[0\]\.br: /);
    // Every missing id is named.
    const two = messageOf(
      rwDeclared(rwEntry(RW_TEST, { br: '[BR-AI-14, BR-WDR-3]' }), EXAMPLE_REFS),
      'B2-02a.yaml',
    );
    expect(brLines(two, 0)).toHaveLength(1);
    expect(brLines(two, 0)[0]).toContain('BR-AI-14');
    expect(brLines(two, 0)[0]).toContain('BR-WDR-3');
    // A ledger without refs at all.
    const none = messageOf(rwDeclared(rwEntry(RW_TEST), 'refs: []'), 'B2-02a.yaml');
    expect(none).toMatch(BR_PROBLEM(0));
    expect(brLines(none, 0)[0]).toContain('BR-AI-14');
    // The index is the entry's own: the first entry's ids are all in refs, the second's is not.
    const second = messageOf(
      rwDeclared(
        rwEntry('[AC-1] ok', { br: '[BR-FUND-16]' }) + rwEntry(RW_TEST, { br: '[BR-AI-15]' }),
        EXAMPLE_REFS,
      ),
      'B2-02a.yaml',
    );
    expect(second).toMatch(BR_PROBLEM(1));
    expect(brLines(second, 1)[0]).toContain('BR-AI-15');
    expect(brLines(second, 0)).toEqual([]);
    // The id must be in refs character for character (no prefix match, no case folding).
    expect(
      messageOf(rwDeclared(rwEntry(RW_TEST, { br: '[BR-FUND-16a]' }), EXAMPLE_REFS), 'B2-02a.yaml'),
    ).toMatch(BR_PROBLEM(0));
    expect(
      messageOf(rwDeclared(rwEntry(RW_TEST, { br: '[BR-FUND-1]' }), EXAMPLE_REFS), 'B2-02a.yaml'),
    ).toMatch(BR_PROBLEM(0));
  });

  it('[CT-06zzzzzb] parseTaskFile accepts a rule_change entry whose every br id is in refs; other reasons without br are not held to refs', () => {
    const inRefs = rwDeclared(
      rwEntry(RW_TEST, { br: '[BR-FUND-19, BR-FUND-13]' }) +
        rwEntry('[AC-1] b', { reason: 'tighten_only', br: '' }),
      EXAMPLE_REFS,
    );
    expect(messageOf(inRefs, 'B2-02a.yaml')).toBe('');
    expect(parseTaskFile(inRefs, 'B2-02a.yaml').modify_existing).toMatchObject([
      { test: RW_TEST, reason: 'rule_change', br: ['BR-FUND-19', 'BR-FUND-13'] },
      { test: '[AC-1] b', reason: 'tighten_only' },
    ]);
    // tighten_only and flake_fix carry no br, so refs: [] does not matter to them.
    expect(
      messageOf(
        rwDeclared(
          rwEntry('[AC-1] a', { reason: 'tighten_only', br: '' }) +
            rwEntry('[AC-1] b', { reason: 'flake_fix', br: '' }),
          'refs: []',
        ),
        'B2-02a.yaml',
      ),
    ).toBe('');
  });

  it('[CT-06zzzzzb] parseTaskFile refuses a rule_change entry without ruling (or with a malformed one)', () => {
    for (const [name, ruling] of [
      ['missing', ''],
      ['null', 'null'],
      ['not a ruling id', 'D10-x'],
      ['a BR id', 'BR-AI-14'],
    ] as const) {
      const message = messageOf(rwDeclared(rwEntry(RW_TEST, { ruling })), 'B2-02a.yaml');
      expect(message, name).toContain('B2-02a.yaml: invalid task file');
      expect(message, name).toContain(
        'modify_existing[0].ruling: must be the orchestrator ruling id, D10-<number>',
      );
      // Only the ruling is at fault: reason and br are valid.
      expect(message, name).not.toContain('modify_existing[0].reason:');
      expect(message, name).not.toContain('modify_existing[0].br:');
    }
    // The index is the entry's own.
    expect(
      messageOf(rwDeclared(rwEntry('[AC-1] ok') + rwEntry(RW_TEST, { ruling: '' })), 'B2-02a.yaml'),
    ).toContain('modify_existing[1].ruling: ');
  });

  it('[CT-06zxc] renames: quoted name literals, optional, every malformed entry refused', () => {
    const declared = (entries: string): string =>
      EXAMPLE.replace('tester: claude', `tester: claude\nrenames:${entries}`);
    const pair = (from: string, to: string): string => `\n  - from: ${from}\n    to: ${to}`;
    // The three pairs of B1-03w, as the ledger writes them.
    const b103w = declared(
      pair(`"'freeze-expiry'"`, `"'freeze_expiry'"`) +
        pair(`"'daily-alerts'"`, `"'daily_alerts'"`) +
        pair(`"'snapshot-retry'"`, `"'snapshot_retry'"`),
    );
    expect(parseTaskFile(b103w, 'B2-02a.yaml').renames).toEqual([
      { from: "'freeze-expiry'", to: "'freeze_expiry'" },
      { from: "'daily-alerts'", to: "'daily_alerts'" },
      { from: "'snapshot-retry'", to: "'snapshot_retry'" },
    ]);
    // Double quotes and backticks; every name character (letters, digits, _ . : / @ -).
    expect(
      parseTaskFile(
        declared(
          pair(`'"queue.job-a"'`, `'"queue.job_a"'`) + pair("'`@scope/x:1`'", "'`@scope/y:2`'"),
        ),
        'B2-02a.yaml',
      ).renames,
    ).toEqual([
      { from: '"queue.job-a"', to: '"queue.job_a"' },
      { from: '`@scope/x:1`', to: '`@scope/y:2`' },
    ]);
    // An older ledger without the field, an empty list: [].
    expect(parseTaskFile(EXAMPLE, 'B2-02a.yaml').renames).toEqual([]);
    expect(parseTaskFile(declared(' []'), 'B2-02a.yaml').renames).toEqual([]);
    // Not a list, not a mapping, an unknown key, a missing or empty side, a non-string value.
    expect(messageOf(declared(' abc'), 'B2-02a.yaml')).toContain(
      'renames: must be a list of mappings (from / to)',
    );
    expect(messageOf(declared('\n  - abc'), 'B2-02a.yaml')).toContain(
      'renames[0]: must be a mapping (from / to)',
    );
    expect(
      messageOf(declared(`${pair(`"'aaa'"`, `"'bbb'"`)}\n    regex: true`), 'B2-02a.yaml'),
    ).toContain('renames[0].regex: unknown field');
    expect(messageOf(declared(`\n  - from: "'aaa'"`), 'B2-02a.yaml')).toContain(
      'renames[0].to: must be a non-empty string',
    );
    expect(messageOf(declared(pair("''", `"'bbb'"`)), 'B2-02a.yaml')).toContain(
      'renames[0].from: must be a non-empty string',
    );
    expect(messageOf(declared(pair('1', `"'bbb'"`)), 'B2-02a.yaml')).toContain(
      'renames[0].from: must be a non-empty string',
    );
    // Not one quoted name literal: code that closes and reopens the quotes (review r2 S2-1: it
    // would delete an assertion), blanks, parentheses, operators, commas, a bare word, a half
    // quote, quotes, backslashes, line breaks.
    // D10-1083 / CT-06zzzzl：反引号串里的 ${标识符} 占位改为合法——"'`job-${x}`'" 移出本拒绝清单，
    // 改在下面作合法用例；占位以外的 $ { } 仍拒（见 [CT-06zzzzl] 各条）。
    const literal = 'must be one quoted name literal';
    for (const bad of [
      `"')).toBe('"`,
      `"')); void ('"`,
      `"' + '"`,
      `"' - '"`,
      `"'toBe(100)'"`,
      `"'a b c'"`,
      `"'a(b)c'"`,
      `"'a+b'"`,
      `"'a,b,c'"`,
      `"'a;b;c'"`,
      `"'a=b'"`,
      `"'a\\tb'"`,
      `"'ab\\"c'"`,
      `"'ab\\\\c'"`,
      `"'ab\\nc'"`,
      "' '",
      "'toBe(100)'",
      'freeze-expiry',
      `"'freeze-expiry"`,
    ]) {
      expect(messageOf(declared(pair(bad, `"'bbb'"`)), 'B2-02a.yaml'), bad).toContain(
        `renames[0].from: `,
      );
      expect(messageOf(declared(pair(bad, `"'bbb'"`)), 'B2-02a.yaml'), bad).toContain(literal);
      expect(messageOf(declared(pair(`"'bbb'"`, bad)), 'B2-02a.yaml'), bad).toContain(
        `renames[0].to: `,
      );
    }
    expect(messageOf(declared(pair(`"')).toBe('"`, `"')); void ('"`)), 'B2-02a.yaml')).toContain(
      `renames[0].from: "')).toBe('" ${literal}`,
    );
    expect(messageOf(declared(pair(`"'aaa'"`, 'daily_alerts')), 'B2-02a.yaml')).toContain(
      `renames[0].to: "daily_alerts" ${literal}`,
    );
    // D10-1083 / CT-06zzzzl：反引号串里的 ${标识符} 占位改为合法（原在上面的拒绝清单里）。
    expect(
      parseTaskFile(declared(pair("'`job-${x}`'", "'`job_${x}`'")), 'B2-02a.yaml').renames,
    ).toEqual([{ from: '`job-${x}`', to: '`job_${x}`' }]);
    // Too short inside its quotes.
    expect(messageOf(declared(pair(`"'ab'"`, `"'bbb'"`)), 'B2-02a.yaml')).toContain(
      `renames[0].from: "'ab'" must hold at least ${RENAME_CONTENT_MIN} characters between its quotes`,
    );
    expect(messageOf(declared(pair(`"''"`, `"'bbb'"`)), 'B2-02a.yaml')).toContain(
      'must hold at least',
    );
    // D10-379: a number is not a name — the content needs an ASCII letter (from and to alike).
    for (const numeric of [`"'500'"`, `"'-500'"`, `"'1.5'"`, `"'2026-10-27'"`]) {
      expect(messageOf(declared(pair(numeric, `"'bbb'"`)), 'B2-02a.yaml'), numeric).toContain(
        `renames[0].from: ${numeric} must hold at least one ASCII letter`,
      );
      expect(messageOf(declared(pair(`"'bbb'"`, numeric)), 'B2-02a.yaml'), numeric).toContain(
        `renames[0].to: ${numeric} must hold at least one ASCII letter`,
      );
    }
    expect(
      parseTaskFile(declared(pair(`"'freeze-expiry'"`, `"'freeze_expiry'"`)), 'B2-02a.yaml')
        .renames,
    ).toHaveLength(1);
    expect(parseTaskFile(declared(pair(`"'a1b'"`, `"'a2b'"`)), 'B2-02a.yaml').renames).toEqual([
      { from: "'a1b'", to: "'a2b'" },
    ]);
    // Different quotes, from = to, the same from twice.
    expect(messageOf(declared(pair(`"'aaa'"`, `'"bbb"'`)), 'B2-02a.yaml')).toContain(
      'renames[0]: from and to must use the same quote',
    );
    expect(messageOf(declared(pair(`"'aaa'"`, `"'aaa'"`)), 'B2-02a.yaml')).toContain(
      "renames[0]: from and to are the same ('aaa')",
    );
    expect(
      messageOf(declared(pair(`"'aaa'"`, `"'bbb'"`) + pair(`"'aaa'"`, `"'ccc'"`)), 'B2-02a.yaml'),
    ).toContain("renames[1].from: 'aaa' is renamed twice");
    // At most RENAMES_MAX entries.
    const many = (n: number): string =>
      declared(Array.from({ length: n }, (_, i) => pair(`"'old${i}'"`, `"'new${i}'"`)).join(''));
    expect(parseTaskFile(many(RENAMES_MAX), 'B2-02a.yaml').renames).toHaveLength(RENAMES_MAX);
    expect(messageOf(many(RENAMES_MAX + 1), 'B2-02a.yaml')).toContain(
      `renames: ${RENAMES_MAX + 1} entries, the limit is ${RENAMES_MAX}`,
    );
  });

  // CT-06zzzzl (D10-1083, B2-15x): a backtick rename literal may hold ${identifier(.identifier)*}
  // placeholders; every other `$`, `{` or `}` is still refused, and single / double quotes still
  // refuse all three. The values stay literal text (red-check: split / join, never a pattern).
  // A replacer function: the entries hold `$`, which a replacement string would read as $$ / $&.
  const RENAMES_YAML = (entries: string): string =>
    EXAMPLE.replace('tester: claude', () => `tester: claude\nrenames:${entries}`);
  /** One rename entry, each value written as a YAML double-quoted scalar (JSON escapes). */
  const renamePair = (from: string, to: string): string =>
    `\n  - from: ${JSON.stringify(from)}\n    to: ${JSON.stringify(to)}`;
  const NAME_LITERAL = 'must be one quoted name literal';

  it('[CT-06zzzzl] renames: a backtick literal may hold ${identifier(.identifier)*} placeholders, read character for character', () => {
    // The B2-15x pair, as the ledger writes it (YAML single quotes around the backtick literal).
    const b215x = RENAMES_YAML(
      "\n  - from: '`biz:${BIZ}:${order.biz_ref}`'\n    to: '`biz:${order.app_id}:${BIZ}:${order.biz_ref}`'",
    );
    expect(parseTaskFile(b215x, 'B2-02a.yaml').renames).toEqual([
      {
        from: '`biz:${BIZ}:${order.biz_ref}`',
        to: '`biz:${order.app_id}:${BIZ}:${order.biz_ref}`',
      },
    ]);
    // The same pair in YAML double quotes reads the same.
    expect(
      parseTaskFile(
        RENAMES_YAML(
          '\n  - from: "`biz:${BIZ}:${order.biz_ref}`"\n    to: "`biz:${order.app_id}:${BIZ}:${order.biz_ref}`"',
        ),
        'B2-02a.yaml',
      ).renames,
    ).toEqual(parseTaskFile(b215x, 'B2-02a.yaml').renames);
    // Placeholder shapes: a dotted chain, `$` and `_` in identifiers, digits after the first
    // character, placeholders side by side, at either end, alone, next to every name character.
    for (const ok of [
      '`job-${x}`',
      '`${a.b.c}-key`',
      '`${a}`',
      '`${a}${b}`',
      '`${$el}:${_x.$y1}`',
      '`${A_1.B2.c_3}`',
      '`key-${a.b}`',
      '`@scope/${pkg.name}:v1.0_x-y`',
      '`biz:${order.app_id}:${BIZ}:${order.biz_ref}`',
    ]) {
      expect(
        parseTaskFile(RENAMES_YAML(renamePair(ok, '`renamed-key`')), 'B2-02a.yaml').renames,
        ok,
      ).toEqual([{ from: ok, to: '`renamed-key`' }]);
      expect(
        parseTaskFile(RENAMES_YAML(renamePair('`old-key`', ok)), 'B2-02a.yaml').renames,
        ok,
      ).toEqual([{ from: '`old-key`', to: ok }]);
    }
    // Several placeholder pairs in one ledger, in ledger order.
    expect(
      parseTaskFile(
        RENAMES_YAML(
          renamePair('`job-${x}`', '`job_${x}`') +
            renamePair('`${a.b.c}-key`', '`${a.b.c}_key`') +
            renamePair("'freeze-expiry'", "'freeze_expiry'"),
        ),
        'B2-02a.yaml',
      ).renames,
    ).toEqual([
      { from: '`job-${x}`', to: '`job_${x}`' },
      { from: '`${a.b.c}-key`', to: '`${a.b.c}_key`' },
      { from: "'freeze-expiry'", to: "'freeze_expiry'" },
    ]);
  });

  it('[CT-06zzzzl] renames: outside a ${identifier} placeholder, $ { } are refused, in backtick literals too', () => {
    for (const bad of [
      '`${}`',
      '`ab${}cd`',
      '`ab${a b}`',
      '`ab${a+b}`',
      '`ab${a-b}`',
      '`ab${f()}`',
      '`ab${a[0]}`',
      '`ab${a.}`',
      '`ab${.a}`',
      '`ab${a..b}`',
      '`ab${1a}`',
      '`ab${${a}}`',
      '`ab${a`',
      '`ab$a`',
      '`{abc}`',
      '`ab$${a}`',
      '`ab${a}}`',
      "`ab${'x'}`",
      '`ab${a,b}`',
      '`ab${a/b}`',
      '`ab${a:b}`',
      '`ab${a@b}`',
      '`ab${ a}`',
      '`ab${a }`',
      '`ab${a.b-c}`',
      '`abc$`',
      '`abc{`',
      '`abc}`',
      '`a}b{c`',
      '`${a}-$b`',
      '`${a}{b}`',
      '`{${a}}`',
      '`$ {a}`',
      '`$\\{a}`',
    ]) {
      const asFrom = messageOf(RENAMES_YAML(renamePair(bad, '`bbb-key`')), 'B2-02a.yaml');
      expect(asFrom, bad).toContain(`renames[0].from: ${JSON.stringify(bad)} ${NAME_LITERAL}`);
      const asTo = messageOf(RENAMES_YAML(renamePair('`bbb-key`', bad)), 'B2-02a.yaml');
      expect(asTo, bad).toContain(`renames[0].to: ${JSON.stringify(bad)} ${NAME_LITERAL}`);
    }
  });

  it('[CT-06zzzzl] renames: single- and double-quoted literals still refuse $ { } altogether, placeholders included', () => {
    for (const bad of [
      "'${x}abc'",
      "'abc${x.y}'",
      "'${abc}'",
      "'$abc'",
      "'a{b}c'",
      '"a$bc"',
      '"${abc}"',
      '"{abc}"',
      '"biz:${BIZ}:${order.biz_ref}"',
    ]) {
      const partner = bad[0] === "'" ? "'bbb-key'" : '"bbb-key"';
      expect(messageOf(RENAMES_YAML(renamePair(bad, partner)), 'B2-02a.yaml'), bad).toContain(
        `renames[0].from: ${JSON.stringify(bad)} ${NAME_LITERAL}`,
      );
      expect(messageOf(RENAMES_YAML(renamePair(partner, bad)), 'B2-02a.yaml'), bad).toContain(
        `renames[0].to: ${JSON.stringify(bad)} ${NAME_LITERAL}`,
      );
    }
  });

  it('[CT-06zzzzl] renames: with placeholders the other rules stand (quotes, blanks, length, a letter, from ≠ to, no from twice, the limit)', () => {
    const KEY = '`biz:${BIZ}:${order.biz_ref}`';
    const NEW_KEY = '`biz:${order.app_id}:${BIZ}:${order.biz_ref}`';
    // Not one quoted literal: blanks, a backslash, a line break, another quote inside, a missing
    // or extra quote, two literals, a bare placeholder.
    for (const bad of [
      '`a ${b}`',
      '`a\\${b}`',
      '`a${b}\nc`',
      '`a\t${b}`',
      "`a'${b}`",
      '`a"${b}`',
      '`ab${c}',
      'ab${c}`',
      '`ab${c}`x`',
      '`${a}` + `${b}`',
      '${abc}',
      'biz:${BIZ}',
    ]) {
      expect(
        messageOf(RENAMES_YAML(renamePair(bad, '`bbb-key`')), 'B2-02a.yaml'),
        JSON.stringify(bad),
      ).toContain(`renames[0].from: ${JSON.stringify(bad)} ${NAME_LITERAL}`);
      expect(
        messageOf(RENAMES_YAML(renamePair('`bbb-key`', bad)), 'B2-02a.yaml'),
        JSON.stringify(bad),
      ).toContain(`renames[0].to: ${JSON.stringify(bad)} ${NAME_LITERAL}`);
    }
    // The content (placeholders included) needs an ASCII letter: identifiers of `$`, `_` and
    // digits only are no name.
    for (const noLetter of ['`${_}`', '`${$}`', '`${_.$}`', '`${_1}`', '`1-${_}`']) {
      expect(
        messageOf(RENAMES_YAML(renamePair(noLetter, '`bbb-key`')), 'B2-02a.yaml'),
        noLetter,
      ).toContain(
        `renames[0].from: ${JSON.stringify(noLetter)} must hold at least one ASCII letter`,
      );
      expect(
        messageOf(RENAMES_YAML(renamePair('`bbb-key`', noLetter)), 'B2-02a.yaml'),
        noLetter,
      ).toContain(`renames[0].to: ${JSON.stringify(noLetter)} must hold at least one ASCII letter`);
    }
    // Too short inside the backticks is refused as before; a lone placeholder is long enough.
    expect(messageOf(RENAMES_YAML(renamePair('`ab`', '`abc`')), 'B2-02a.yaml')).toContain(
      `renames[0].from: "\`ab\`" must hold at least ${RENAME_CONTENT_MIN} characters between its quotes`,
    );
    expect(
      parseTaskFile(RENAMES_YAML(renamePair('`${a}`', '`${b}`')), 'B2-02a.yaml').renames,
    ).toEqual([{ from: '`${a}`', to: '`${b}`' }]);
    // The same quote at both sides: a placeholder literal is renamed to a backtick literal only.
    for (const other of ["'biz-key'", '"biz-key"']) {
      expect(messageOf(RENAMES_YAML(renamePair(KEY, other)), 'B2-02a.yaml'), other).toContain(
        'renames[0]: from and to must use the same quote',
      );
      expect(messageOf(RENAMES_YAML(renamePair(other, KEY)), 'B2-02a.yaml'), other).toContain(
        'renames[0]: from and to must use the same quote',
      );
    }
    // from = to, the same from twice.
    expect(messageOf(RENAMES_YAML(renamePair(KEY, KEY)), 'B2-02a.yaml')).toContain(
      `renames[0]: from and to are the same (${KEY})`,
    );
    expect(
      messageOf(
        RENAMES_YAML(renamePair(KEY, NEW_KEY) + renamePair(KEY, '`biz:${x}`')),
        'B2-02a.yaml',
      ),
    ).toContain(`renames[1].from: ${KEY} is renamed twice`);
    // At most RENAMES_MAX entries, placeholders or not.
    const many = (n: number): string =>
      RENAMES_YAML(
        Array.from({ length: n }, (_, i) =>
          renamePair(`\`old${i}-\${k.v}\``, `\`new${i}-\${k.v}\``),
        ).join(''),
      );
    expect(parseTaskFile(many(RENAMES_MAX), 'B2-02a.yaml').renames).toHaveLength(RENAMES_MAX);
    expect(parseTaskFile(many(RENAMES_MAX), 'B2-02a.yaml').renames[0]).toEqual({
      from: '`old0-${k.v}`',
      to: '`new0-${k.v}`',
    });
    expect(messageOf(many(RENAMES_MAX + 1), 'B2-02a.yaml')).toContain(
      `renames: ${RENAMES_MAX + 1} entries, the limit is ${RENAMES_MAX}`,
    );
  });

  it('[CT-06zxe] expected_values: file / helper / from / to of the same value skeleton, optional, every malformed entry refused', () => {
    const declared = (entries: string): string =>
      EXAMPLE.replace('tester: claude', `tester: claude\nexpected_values:${entries}`);
    const entry = (from: string, to: string, helper = 'onlyAnomaly', file = NOTIFY): string =>
      `\n  - file: ${file}\n    helper: ${helper}\n    from: ${from}\n    to: ${to}`;
    const NOTIFY = 'test/spec/payment/result/notify.int.test.ts';
    // The B2-15l entry, as the ledger writes it (leading blanks kept by the quotes).
    expect(
      parseTaskFile(
        declared(entry(`'    diff_fen: AMOUNT,'`, `'    diff_fen: -AMOUNT,'`)),
        'B2-02a.yaml',
      ).expected_values,
    ).toEqual([
      {
        file: NOTIFY,
        helper: 'onlyAnomaly',
        from: '    diff_fen: AMOUNT,',
        to: '    diff_fen: -AMOUNT,',
      },
    ]);
    // Literals may change: numbers (bigint too), strings, a unary minus on a member chain.
    const ok = parseTaskFile(
      declared(
        entry(
          `'diff_fen: order.amount_fen,'`,
          `'diff_fen: -order.amount_fen,'`,
          'onlyAnomaly',
          'test/spec/a.test.ts',
        ) +
          entry(`'expect(x).toBe(500n);'`, `'expect(x).toBe(-1500n);'`, 'check') +
          entry(`"status: 'open',"`, `"status: 'closed',"`, '$h_1'),
      ),
      'B2-02a.yaml',
    ).expected_values;
    expect(ok.map((e) => e.helper)).toEqual(['onlyAnomaly', 'check', '$h_1']);
    // An older ledger without the field, an empty list: [].
    expect(parseTaskFile(EXAMPLE, 'B2-02a.yaml').expected_values).toEqual([]);
    expect(parseTaskFile(declared(' []'), 'B2-02a.yaml').expected_values).toEqual([]);
    // Not a list, not a mapping, unknown key, bad file, bad helper, missing or empty side.
    expect(messageOf(declared(' abc'), 'B2-02a.yaml')).toContain(
      'expected_values: must be a list of mappings (file / helper / from / to)',
    );
    expect(messageOf(declared('\n  - abc'), 'B2-02a.yaml')).toContain(
      'expected_values[0]: must be a mapping (file / helper / from / to)',
    );
    expect(
      messageOf(declared(`${entry("'a: 1'", "'a: 2'")}\n    regex: true`), 'B2-02a.yaml'),
    ).toContain('expected_values[0].regex: unknown field');
    expect(
      messageOf(declared(entry("'a: 1'", "'a: 2'", 'onlyAnomaly', '../x.test.ts')), 'B2-02a.yaml'),
    ).toContain('expected_values[0].file: "../x.test.ts"');
    for (const helper of ["'only Anomaly'", "'1abc'", "'a.b'", "''"]) {
      expect(messageOf(declared(entry("'a: 1'", "'a: 2'", helper)), 'B2-02a.yaml')).toContain(
        'expected_values[0].helper: must be the name (an identifier) of a top-level helper',
      );
    }
    expect(messageOf(declared(entry("''", "'a: 2'")), 'B2-02a.yaml')).toContain(
      'expected_values[0].from: must be a non-empty source snippet',
    );
    expect(messageOf(declared(entry("'a: 1'", "'   '")), 'B2-02a.yaml')).toContain(
      'expected_values[0].to: must be a non-empty source snippet',
    );
    expect(messageOf(declared(entry('"a: 1\\nb"', "'a: 2'")), 'B2-02a.yaml')).toContain(
      'expected_values[0].from: must be a single line',
    );
    expect(
      messageOf(
        declared(entry(`'a: ${'1'.repeat(EXPECTED_VALUE_LENGTH_MAX)}'`, "'a: 2'")),
        'B2-02a.yaml',
      ),
    ).toContain(`expected_values[0].from: longer than ${EXPECTED_VALUE_LENGTH_MAX} characters`);
    expect(messageOf(declared(entry("'a: 1'", "'a: 1'")), 'B2-02a.yaml')).toContain(
      'expected_values[0]: from and to are the same',
    );
    // A different skeleton: an assertion removed or added, another matcher or call, a renamed
    // variable, a literal turned into a name, a binary minus, spacing, a comment.
    for (const [from, to] of [
      ["'expect(a).toBe(1);'", "'expect(a);'"],
      ["'expect(a).toBe(1);'", "'expect(a).toBe(1); expect(b).toBe(2);'"],
      ["'expect(a).toBe(1);'", "'expect(a).toEqual(1);'"],
      ["'diff_fen: AMOUNT,'", "'diff_fen: OTHER,'"],
      ["'diff_fen: AMOUNT,'", "'diff_fen: 100n,'"],
      ["'diff_fen: AMOUNT,'", "'diff_fen: 0n - AMOUNT,'"],
      ["'diff_fen: a + 1,'", "'diff_fen: a - 1,'"],
      ["'diff_fen: AMOUNT,'", "'diff_fen:  -AMOUNT,'"],
      ["'diff_fen: 1, // x'", "'diff_fen: 1, // y'"],
      ['"x: `a${b}`,"', '"x: `a${c}`,"'],
    ] as const) {
      expect(messageOf(declared(entry(from, to)), 'B2-02a.yaml')).toContain(
        `must have ${EXPECTED_VALUE_SHAPE}`,
      );
    }
    // A tagged template is not a value (review r1 S2-1 ①).
    expect(
      messageOf(declared(entry("'sql`select 1`'", "'sql`select 2`'")), 'B2-02a.yaml'),
    ).toContain(`must have ${EXPECTED_VALUE_SHAPE}`);
    // Only an object property value or a matcher's expected argument (review r1 S2-1 ③).
    for (const [from, to] of [
      [`".where('status', '=', 'open')"`, `".where('status', '<>', 'open')"`],
      [`"const n = 1;"`, `"const n = 2;"`],
      [`"f(1)"`, `"f(2)"`],
    ] as const) {
      expect(messageOf(declared(entry(from, to)), 'B2-02a.yaml')).toMatch(
        /expected_values\[0\]: from .* → to .*: .* is changed (inside a where\( call|outside an object property value)/,
      );
    }
    // The same file + helper + from twice.
    expect(
      messageOf(declared(entry("'a: 1'", "'a: 2'") + entry("'a: 1'", "'a: 3'")), 'B2-02a.yaml'),
    ).toContain(`expected_values[1]: ${NOTIFY} / onlyAnomaly / "a: 1" is registered twice`);
    // At most EXPECTED_VALUES_MAX entries.
    const many = (n: number): string =>
      declared(Array.from({ length: n }, (_, i) => entry(`'a: ${i}'`, `'a: -${i}'`)).join(''));
    expect(parseTaskFile(many(EXPECTED_VALUES_MAX), 'B2-02a.yaml').expected_values).toHaveLength(
      EXPECTED_VALUES_MAX,
    );
    expect(messageOf(many(EXPECTED_VALUES_MAX + 1), 'B2-02a.yaml')).toContain(
      `expected_values: ${EXPECTED_VALUES_MAX + 1} entries, the limit is ${EXPECTED_VALUES_MAX}`,
    );
  });

  it('[CT-06zxh] expected_values: the value stands in an expectation, as red-check checks it in the whole helper (review r2 S2-2)', () => {
    const declared = (entries: string): string =>
      EXAMPLE.replace('tester: claude', `tester: claude\nexpected_values:${entries}`);
    const entry = (from: string, to: string): string =>
      `\n  - file: test/spec/a.test.ts\n    helper: h\n    from: ${from}\n    to: ${to}`;
    // Still accepted: B2-15l's two lines, a matcher at the end of an expect chain, a property of
    // an expectation's object.
    for (const [from, to] of [
      [`'    diff_fen: AMOUNT,'`, `'    diff_fen: -AMOUNT,'`],
      [`'    diff_fen: order.amount_fen,'`, `'    diff_fen: -order.amount_fen,'`],
      [`'expect.soft(x).not.toBe(1);'`, `'expect.soft(x).not.toBe(2);'`],
      [
        `'await expect(p).resolves.toEqual({ a: 1 });'`,
        `'await expect(p).resolves.toEqual({ a: 2 });'`,
      ],
      [`'.length).toBeGreaterThanOrEqual(1);'`, `'.length).toBeGreaterThanOrEqual(2);'`],
    ] as const) {
      expect(parseTaskFile(declared(entry(from, to)), 'B2-02a.yaml').expected_values).toHaveLength(
        1,
      );
    }
    // The review r2 bypasses: a ternary branch, a type annotation, a fixture input, a query
    // object, the actual side's input, a non-matcher .toXxx(.
    for (const [from, to] of [
      [`'const lim = strict ? 1 : 0;'`, `'const lim = strict ? 1 : 99;'`],
      [`"let s: 'open' = x;"`, `"let s: 'closed' = x;"`],
      [`"insertOrder(db, { status: 'open' })"`, `"insertOrder(db, { status: 'closed' })"`],
      [
        `"const q = { text: 'select 1 where a = 1' };"`,
        `"const q = { text: 'select 1 where false' };"`,
      ],
      [`'expect(f({ amount: 1 })).toBe(3);'`, `'expect(f({ amount: 2 })).toBe(3);'`],
      [`'n.toString(16)'`, `'n.toString(2)'`],
      [`'n.toFixed(2)'`, `'n.toFixed(0)'`],
    ] as const) {
      expect(messageOf(declared(entry(from, to)), 'B2-02a.yaml'), from).toMatch(
        /expected_values\[0\]: from .* → to .*: .* is changed (in an object property value that stands|outside an object property value)/,
      );
    }
  });

  it('[CT-06zxi] expected_values: a value inside a function body between it and the matcher is refused (D10-388)', () => {
    const declared = (entries: string): string =>
      EXAMPLE.replace('tester: claude', `tester: claude\nexpected_values:${entries}`);
    const entry = (from: string, to: string): string =>
      `\n  - file: test/spec/a.test.ts\n    helper: h\n    from: ${from}\n    to: ${to}`;
    for (const [from, to] of [
      [
        `'expect(actual).toEqual((() => { const input = { amount: 1 }; return makeExpected(input); })());'`,
        `'expect(actual).toEqual((() => { const input = { amount: 2 }; return makeExpected(input); })());'`,
      ],
      [
        `'expect(x).toEqual((function () { return { a: 1 }; })());'`,
        `'expect(x).toEqual((function () { return { a: 2 }; })());'`,
      ],
      [
        `'expect(x).toEqual(function () { return { a: 1 }; }());'`,
        `'expect(x).toEqual(function () { return { a: 2 }; }());'`,
      ],
      [
        `'expect(x).toEqual(((v) => ({ a: 1 }))(0));'`,
        `'expect(x).toEqual(((v) => ({ a: 2 }))(0));'`,
      ],
      [`'expect(x).toEqual((() => [1])());'`, `'expect(x).toEqual((() => [2])());'`],
      [`'expect(x).toEqual([() => 1]);'`, `'expect(x).toEqual([() => 2]);'`],
    ] as const) {
      expect(messageOf(declared(entry(from, to)), 'B2-02a.yaml'), from).toMatch(
        /expected_values\[0\]: from .* → to .*: .* is changed .*(inside a function body|outside an object property value)/,
      );
    }
    // Still accepted: B2-15l's two lines, an asymmetric matcher's nested object.
    for (const [from, to] of [
      [`'    diff_fen: AMOUNT,'`, `'    diff_fen: -AMOUNT,'`],
      [`'    diff_fen: order.amount_fen,'`, `'    diff_fen: -order.amount_fen,'`],
      [
        `'expect(x).toEqual(expect.objectContaining({ a: { b: 1 } }));'`,
        `'expect(x).toEqual(expect.objectContaining({ a: { b: 2 } }));'`,
      ],
      [`'expect(x).toEqual([{ a: [{ b: 1 }] }]);'`, `'expect(x).toEqual([{ a: [{ b: 2 }] }]);'`],
    ] as const) {
      expect(parseTaskFile(declared(entry(from, to)), 'B2-02a.yaml').expected_values).toHaveLength(
        1,
      );
    }
  });

  it('lists every problem in one error', () => {
    const text = [
      'id: b2',
      'repo: web',
      'title: ""',
      'type: feature',
      'refs: BR-FUND-13',
      'refs_hash: [x]',
      'deps: [nope]',
      'paths: []',
      'impl: gpt',
      'tester: nobody',
      'accept: []',
      'status: doing',
      'pr: -1',
      'risk: RV0',
    ].join('\n');
    const message = messageOf(text, 'b2.yaml');
    for (const field of [
      'risk: unknown field',
      'id: must look like',
      'repo: must be one of',
      'title: must be a single non-empty line',
      'type: must be one of',
      'refs: must be a list of strings',
      'refs_hash: must be a mapping',
      'deps: "nope" is not a task id',
      'paths: must not be empty',
      'impl: must be one of',
      'tester: must be one of',
      'accept: must not be empty',
      'status: must be one of',
      'pr: must be a positive integer or null',
    ]) {
      expect(message).toContain(field);
    }
  });

  it('reports missing fields', () => {
    const message = messageOf('id: B2-02a\n', 'B2-02a.yaml');
    for (const field of ['repo', 'title', 'type', 'refs', 'refs_hash', 'deps', 'paths', 'impl']) {
      expect(message).toContain(`${field}: missing`);
    }
    expect(message).not.toContain('pr: missing');
  });

  it('requires the id to match the file name', () => {
    expect(messageOf(EXAMPLE, 'ops/tasks/B2-02.yaml')).toContain(
      'id: "B2-02a" does not match the file name "B2-02.yaml"',
    );
  });

  it('rejects absolute, escaping and directory paths', () => {
    const text = EXAMPLE.replace(
      '  - "apps/api/src/modules/ledger/**"',
      '  - "/etc/passwd"\n  - "../couli/**"\n  - "apps/api/"\n  - "a\\\\b"',
    );
    const message = messageOf(text, 'B2-02a.yaml');
    expect(message).toContain('"/etc/passwd" must be relative');
    expect(message).toContain('"../couli/**" must not contain');
    expect(message).toContain('"apps/api/" must name files');
    expect(message).toContain('"a\\b" must use "/" separators');
  });

  it('rejects paths that hold control characters (a newline or NUL would split a guard call)', () => {
    for (const escape of ['\\n', '\\0', '\\r']) {
      const text = EXAMPLE.replace(
        '  - "apps/api/src/modules/ledger/**"',
        `  - "docs/a${escape}docs/b.md"`,
      );
      expect(messageOf(text, 'B2-02a.yaml')).toContain('must not contain control characters');
    }
  });

  it('wraps YAML errors with the file name and rejects non-mapping documents', () => {
    expect(messageOf('id: &a B2-02a\n', 'B2-02a.yaml')).toMatch(/^B2-02a\.yaml: yaml-lite: line 1/);
    expect(messageOf('- a\n', 'B2-02a.yaml')).toContain('the document must be a mapping');
  });
});

describe('loadTask and listTaskIds', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'couli-tasks-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns an empty list when ops/tasks does not exist', () => {
    expect(listTaskIds(root)).toEqual([]);
  });

  it('lists ids in order and skips the archive tree and other files', () => {
    const dir = join(root, 'ops', 'tasks');
    mkdirSync(join(dir, 'archive', '202610'), { recursive: true });
    writeFileSync(join(dir, 'B2-02a.yaml'), EXAMPLE);
    writeFileSync(join(dir, 'B1-01.yaml'), EXAMPLE.replace('id: B2-02a', 'id: B1-01'));
    writeFileSync(join(dir, 'README.md'), 'not a task\n');
    writeFileSync(join(dir, 'archive', '202610', 'A0-01.yaml'), 'id: A0-01\n');
    expect(listTaskIds(root)).toEqual(['B1-01', 'B2-02a']);
  });

  it('loads a task by id from the given root', () => {
    const dir = join(root, 'ops', 'tasks');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'B2-02a.yaml'), EXAMPLE);
    expect(loadTask('B2-02a', root).paths).toEqual(['apps/api/src/modules/ledger/**']);
  });

  it('refuses ids that are not task ids and reports missing files', () => {
    expect(() => loadTask('../../etc/passwd', root)).toThrow(/invalid task id/);
    expect(() => loadTask('B9-99', root)).toThrow(/task file not found/);
  });
});

describe('tester: claude-independent (ops/approvals.yaml id 36)', () => {
  it('accepts a fresh independent Claude context as the rule-test author, nothing else new', () => {
    const text = EXAMPLE.replace('impl: codex', 'impl: claude').replace(
      'tester: claude',
      'tester: claude-independent',
    );
    expect(parseTaskFile(text, 'B2-02a.yaml').tester).toBe('claude-independent');
    expect(
      messageOf(EXAMPLE.replace('tester: claude', 'tester: claude-agent'), 'B2-02a.yaml'),
    ).toContain('tester: must be one of codex / claude / claude-independent / none');
    // The implementer stays codex or claude: an independent Claude context never implements.
    expect(
      messageOf(EXAMPLE.replace('impl: codex', 'impl: claude-independent'), 'B2-02a.yaml'),
    ).toContain('impl: must be one of codex / claude');
  });
});
