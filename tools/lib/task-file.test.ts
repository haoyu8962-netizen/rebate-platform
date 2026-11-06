import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EXPECTED_VALUE_LENGTH_MAX,
  EXPECTED_VALUE_SHAPE,
  EXPECTED_VALUES_MAX,
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
    // quote, quotes, backslashes, line breaks, a template expression.
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
      "'`job-${x}`'",
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
