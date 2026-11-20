import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { repoRoot } from '../lib/paths.ts';
import { writeFiles } from './lib/fixture-kit.ts';
import {
  LEDGER_WRITERS_ALLOWLIST,
  blankSqlComments,
  blankTsComments,
  findLedgerWrites,
  isScanned,
  ledgerWritersCheck,
  parseLedgerAllowlist,
} from './ledger-writers.ts';

// Statements are assembled at run time so this file itself holds no ledger write.
const BALANCES = ['account', 'balances'].join('_');
const ENTRIES = ['ledger', 'entries'].join('_');
const update = (table: string): string => ['UPDATE', table, 'SET version = 1'].join(' ');

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const parent = join(repoRoot(), '.tmp');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'ledger-writers-unit-'));
  roots.push(root);
  writeFiles(root, files);
  return root;
}

it('blanks comments but keeps offsets, line breaks, strings and templates', () => {
  const source = `const a = '// not a comment'; // gone\n/* gone\n */ const b = \`x\${'y'}\`;`;
  const blanked = blankTsComments(source);
  expect(blanked).toHaveLength(source.length);
  expect(blanked).toContain("'// not a comment'");
  expect(blanked).not.toContain('gone');
  expect(blanked.split('\n')).toHaveLength(3);
  expect(blanked).toContain("`x${'y'}`");
  expect(blankSqlComments(`SELECT '--x' -- gone\n/* gone */ 1;`)).not.toContain('gone');
});

it('a regular expression literal with a quote or slashes does not start a string or comment', () => {
  const source = `const re = /["'\\/]+/g; ${JSON.stringify(update(BALANCES))};`;
  expect(findLedgerWrites('a.ts', source)).toEqual([
    { line: 1, table: BALANCES, operation: 'UPDATE' },
  ]);
});

it('an escaped line break before the keyword still counts, and FOR UPDATE does not', () => {
  const text =
    `const s = '-- note\\n${update(`app.${BALANCES}`)}';\n` +
    `const r = 'SELECT 1 FROM app.${ENTRIES} FOR UPDATE';\n`;
  expect(findLedgerWrites('a.ts', text)).toEqual([
    { line: 1, table: BALANCES, operation: 'UPDATE' },
  ]);
});

it('a table whose name only starts with a ledger table name is not a hit', () => {
  expect(findLedgerWrites('a.sql', update(`app.${ENTRIES}_default`))).toEqual([]);
  expect(findLedgerWrites('a.sql', update(`other_${ENTRIES}`))).toEqual([]);
});

it('only .ts and .sql sources outside dependencies and generated files are scanned', () => {
  expect(isScanned('apps/api/src/x.ts')).toBe(true);
  expect(isScanned('db/seeds/x.sql')).toBe(true);
  expect(isScanned('db/schema.sql')).toBe(false);
  expect(isScanned('packages/db/src/db.gen.ts')).toBe(false);
  expect(isScanned('packages/x/node_modules/y/index.ts')).toBe(false);
  expect(isScanned('apps/h5/src/x.tsx')).toBe(false);
});

it('allowlist rows need a Tab and a reason and a relative path without wildcards', () => {
  const { entries, problems } = parseLedgerAllowlist(
    ['# c', '', 'a.ts\treason', 'b.ts', 'c.ts\t ', 'd/*.ts\tr', '../e.ts\tr', '/f.ts\tr'].join(
      '\n',
    ),
  );
  expect(entries).toEqual([{ path: 'a.ts', reason: 'reason', line: 3 }]);
  expect(problems).toHaveLength(5);
});

it('a directory entry needs a trailing slash and a file entry must not have one', () => {
  const root = tree({
    [LEDGER_WRITERS_ALLOWLIST]: 'test/spec/x\tdir\napps/a.ts/\tfile\n',
    'test/spec/x/a.ts': '',
    'apps/a.ts': '',
  });
  const result = ledgerWritersCheck(root, {
    files: ['apps/a.ts', 'test/spec/x/a.ts'],
    mode: 'walk',
  });
  expect(result.status).toBe('fail');
  expect(result.problems).toHaveLength(2);
});

it('every write of an unlisted file is reported with its line', () => {
  const root = tree({
    'apps/a.ts': `\nconst q = ${JSON.stringify(update(BALANCES))};\ndb.deleteFrom('${ENTRIES}');\n`,
  });
  const result = ledgerWritersCheck(root, { files: ['apps/a.ts'], mode: 'walk' });
  expect(result.problems.map((p) => p.split('，')[0])).toEqual([
    'apps/a.ts:2: 直接写账务表',
    'apps/a.ts:3: 直接写账务表',
  ]);
  expect(result.notices).toHaveLength(1);
});
