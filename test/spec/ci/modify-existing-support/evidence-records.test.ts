// CT-06zzzzzi (D10-1662) 新条目 2: evidence-check lets the declared support files change after
// spec_commit outside their it blocks, with the owner label and one record per ledger entry
// ({ file, scope: 'support', reason, before_sha256, after_sha256, reverse_red, br? / overturned? /
// basis? }). Fixture repositories after tools/ci/evidence-check.test.ts (modRepo / modBranch /
// modCheck), under <repo>/.tmp/.
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  BASE_FILES,
  BR,
  HELPER_TEST,
  MONEY_KIT,
  OMIT,
  PROP,
  REPLAY,
  type Repo,
  SLOW,
  SUPPORT,
  SUPPORT_BASE,
  SUPPORT_HEAD,
  SUPPORT_RC,
  T2,
  T2_BASE,
  T2_HEAD,
  block,
  blockRecord,
  branch,
  check,
  cleanup,
  helperTest,
  kitSource,
  ledger,
  makeRepo,
  problemsOf,
  sha256,
  support,
  supportRecord,
  trusted,
} from './kit.ts';

let repo: Repo;
beforeAll(() => {
  repo = makeRepo('records');
});
afterAll(cleanup);

const supportOnly = (): string => trusted('support-only', ledger([support(SUPPORT)]));
const goodRecord = (extra: Record<string, unknown> = {}) =>
  supportRecord(SUPPORT, SUPPORT_BASE, SUPPORT_HEAD, extra);

it(
  '[CT-06zzzzzi#14] with the owner label, support files under test/spec, test/properties and test/replay may change outside their blocks, next to a declared block of the same file',
  () => {
    const entries = [
      support(SUPPORT),
      support(MONEY_KIT),
      support(PROP),
      support(REPLAY),
      support(HELPER_TEST),
      block(HELPER_TEST, T2),
    ];
    const dir = trusted('all-kinds', ledger(entries));
    const heads: Record<string, string> = {
      [SUPPORT]: SUPPORT_HEAD,
      [MONEY_KIT]: kitSource('applyKit', true),
      [PROP]: kitSource('withdrawalSequence', true),
      [REPLAY]: kitSource('replayFixture', true),
      [HELPER_TEST]: helperTest({ summary: true, t2: T2_HEAD }),
    };
    const records = [
      ...[SUPPORT, MONEY_KIT, PROP, REPLAY, HELPER_TEST].map((file) =>
        supportRecord(file, BASE_FILES[file] ?? '', heads[file] ?? ''),
      ),
      blockRecord(HELPER_TEST, T2, T2_BASE, T2_HEAD),
    ];
    const head = branch(repo, 'all-kinds', heads, records);
    const report = check(repo, head, dir);
    expect(report.problems).toEqual([]);
    expect(report).toMatchObject({ ok: true, risk: 'RV2', task: 'T9-01s', approval_wanted: true });
  },
  SLOW,
);

it(
  '[CT-06zzzzzi#15] br / overturned / basis of a support record follow the rules of a block record of the same reason',
  () => {
    // ruling_correction (a file that is not a money test): overturned and basis as the ledger's.
    const rcFields = {
      reason: 'ruling_correction',
      br: undefined,
      overturned: 'D10-1500',
      basis: '规划/02 §12.3',
    };
    const rcDir = trusted('rc', ledger([support(SUPPORT_RC, rcFields)]));
    const rcHead = kitSource('reverifyGate', true);
    const rcBase = BASE_FILES[SUPPORT_RC] ?? '';
    const rc = (extra: Record<string, unknown>) =>
      supportRecord(SUPPORT_RC, rcBase, rcHead, {
        reason: 'ruling_correction',
        br: undefined,
        overturned: 'D10-1500',
        basis: '规划/02 §12.3',
        ...extra,
      });
    const good = branch(repo, 'rc-good', { [SUPPORT_RC]: rcHead }, [rc({})]);
    expect(check(repo, good, rcDir).problems).toEqual([]);
    const rcCases: [string, Record<string, unknown>, RegExp][] = [
      ['no overturned', { overturned: undefined }, /modify_existing\[0\]\.overturned/],
      ['other overturned', { overturned: 'D10-1501' }, /modify_existing\[0\]\.overturned/],
      ['no basis', { basis: undefined }, /modify_existing\[0\]\.basis/],
      ['other basis', { basis: '规划/04 §1' }, /modify_existing\[0\]\.basis/],
      ['with br', { br: [BR] }, /modify_existing\[0\]\.br/],
    ];
    for (const [name, extra, want] of rcCases) {
      const head = branch(repo, `rc-${name.replace(/ /g, '-')}`, { [SUPPORT_RC]: rcHead }, [
        rc(extra),
      ]);
      const report = check(repo, head, rcDir);
      expect(report.ok, name).toBe(false);
      expect(problemsOf(report), name).toMatch(want);
    }
    // tighten_only: no br on the record.
    const tightDir = trusted(
      'tight',
      ledger([support(SUPPORT, { reason: 'tighten_only', br: undefined })]),
    );
    const tight = (extra: Record<string, unknown>) =>
      goodRecord({ reason: 'tighten_only', br: undefined, ...extra });
    const tightGood = branch(repo, 'tight-good', { [SUPPORT]: SUPPORT_HEAD }, [tight({})]);
    expect(check(repo, tightGood, tightDir).problems).toEqual([]);
    const tightBr = branch(repo, 'tight-br', { [SUPPORT]: SUPPORT_HEAD }, [tight({ br: [BR] })]);
    const refused = check(repo, tightBr, tightDir);
    expect(refused.ok).toBe(false);
    expect(problemsOf(refused)).toMatch(/modify_existing\[0\]\.br/);
  },
  SLOW,
);

it(
  '[CT-06zzzzzi#16] a support record is refused with a field missing, a hash that is not the file at the merge base / head (lower-case hex), or an empty reverse_red',
  () => {
    const dir = supportOnly();
    const ok = branch(repo, 'rec-good', { [SUPPORT]: SUPPORT_HEAD }, [goodRecord()]);
    expect(check(repo, ok, dir).problems).toEqual([]);
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ['no before', { before_sha256: undefined }, /modify_existing\[0\]\.before_sha256/],
      [
        'before is the head',
        { before_sha256: sha256(SUPPORT_HEAD) },
        /modify_existing\[0\]\.before_sha256/,
      ],
      [
        'before upper-case',
        { before_sha256: sha256(SUPPORT_BASE).toUpperCase() },
        /modify_existing\[0\]\.before_sha256/,
      ],
      ['before not a hash', { before_sha256: 'x' }, /modify_existing\[0\]\.before_sha256/],
      ['no after', { after_sha256: undefined }, /modify_existing\[0\]\.after_sha256/],
      [
        'after is the base',
        { after_sha256: sha256(SUPPORT_BASE) },
        /modify_existing\[0\]\.after_sha256/,
      ],
      [
        'after of other text',
        { after_sha256: sha256(`${SUPPORT_HEAD}\n`) },
        /modify_existing\[0\]\.after_sha256/,
      ],
      ['no reverse_red', { reverse_red: undefined }, /modify_existing\[0\]\.reverse_red/],
      ['empty reverse_red', { reverse_red: [] }, /modify_existing\[0\]\.reverse_red/],
      ['blank reverse_red item', { reverse_red: [''] }, /modify_existing\[0\]\.reverse_red/],
      ['reverse_red not a list', { reverse_red: 'sms' }, /modify_existing\[0\]\.reverse_red/],
      ['reverse_red item not a string', { reverse_red: [1] }, /modify_existing\[0\]\.reverse_red/],
      ['no scope', { scope: undefined }, /modify_existing\[0\]\.(scope|test)/],
      ['other file', { file: MONEY_KIT }, /modify_existing\[0\]\.file/],
      ['other reason', { reason: 'tighten_only' }, /modify_existing\[0\]\.reason/],
      ['no br', { br: undefined }, /modify_existing\[0\]\.br/],
      ['other br', { br: ['BR-ID-09'] }, /modify_existing\[0\]\.br/],
    ];
    for (const [name, extra, want] of cases) {
      const head = branch(repo, `rec-${name.replace(/ /g, '-')}`, { [SUPPORT]: SUPPORT_HEAD }, [
        goodRecord(extra),
      ]);
      const report = check(repo, head, dir);
      expect(report.ok, name).toBe(false);
      expect(problemsOf(report), name).toMatch(want);
    }
  },
  SLOW,
);

it(
  '[CT-06zzzzzi#17] one support record per ledger entry, in ledger order',
  () => {
    const dir = trusted('two', ledger([support(SUPPORT), support(MONEY_KIT)]));
    const kitHead = kitSource('applyKit', true);
    const changes = { [SUPPORT]: SUPPORT_HEAD, [MONEY_KIT]: kitHead };
    const first = goodRecord();
    const second = supportRecord(MONEY_KIT, BASE_FILES[MONEY_KIT] ?? '', kitHead);
    const ok = branch(repo, 'order-good', changes, [first, second]);
    expect(check(repo, ok, dir).problems).toEqual([]);
    const swapped = check(repo, branch(repo, 'order-swapped', changes, [second, first]), dir);
    expect(swapped.ok).toBe(false);
    expect(problemsOf(swapped)).toMatch(/modify_existing\[0\]\.file/);
    expect(problemsOf(swapped)).toMatch(/modify_existing\[1\]\.file/);
    for (const [name, records] of [
      ['one', [first]],
      ['three', [first, second, second]],
      ['none', []],
      ['omitted', OMIT],
    ] as const) {
      const report = check(repo, branch(repo, `order-${name}`, changes, records), dir);
      expect(report.ok, name).toBe(false);
      expect(problemsOf(report), name).toMatch(/modify_existing: .*record/);
    }
  },
  SLOW,
);

it(
  '[CT-06zzzzzi#18] support entries apply only with the owner label owner-approved-<head 12>, as block entries',
  () => {
    const dir = supportOnly();
    const head = branch(repo, 'label', { [SUPPORT]: SUPPORT_HEAD }, [goodRecord()]);
    expect(check(repo, head, dir).problems).toEqual([]);
    const local = check(repo, head, dir, 'none');
    expect(local.ok).toBe(false);
    expect(local.approval_wanted).toBe(true);
    expect(problemsOf(local)).toContain(`owner-approved-${head.slice(0, 12)}`);
    const other = check(repo, head, dir, 'other');
    expect(other.ok).toBe(false);
    expect(other.approval_wanted).toBe(true);
    expect(problemsOf(other)).toContain('owner approval: no');
  },
  SLOW,
);
