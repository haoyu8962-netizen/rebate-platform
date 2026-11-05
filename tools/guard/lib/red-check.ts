// Red check of the rule tests (规划/11 §2.3 step 3): before the implementation, every rule test the
// task added must have run and be red, and red for the right reason — an assertion failure, a
// fast-check counterexample whose cause is an assertion (or a predicate that returned false), or
// the NotImplemented a skeleton throws. Red because a module is missing, a TypeError, a database
// that cannot be reached, a migration or fixture that failed, a server that is not up or a build
// that failed does not count: such a test has not been shown to have teeth. A wrapper (fast-check's
// "Property failed … Got error: …", a hook failure) never makes such a cause count (CR-11).
//
// Scope (default split of 2026-10-05, ops/approvals.yaml id 19; 规划/11 §2.3 step 3): every task
// that has a rule-test author (ledger `tester` is not `none`), at every risk level.
//
// Reconciliation (CR-10): the report is checked against the list of rule-test files the task
// added or changed (inside its `test_paths`); a file of that list that is missing from the report,
// ran no test, or has a skipped / todo / pending test fails the check.
//
// Input is the Vitest JSON report (`vitest run --reporter=json`) of the isolated red run
// (tools/ops/verify-container.sh --red): those tests are Codex-written and never run on the host.
//
// Browser tests (F1-01j; `*.browser.test.{ts,tsx}`, project spec-browser, Vitest browser mode in a
// real Chromium): red for an assertion, or because the element a test waits for never came, is a
// valid red (规划/11 §2.3 step 3). A wait is `expect.element(…)` / `expect.poll(…)`: when it runs
// out, vitest 5.0.1 rethrows its last error with an added innermost cause "Matcher did not succeed
// in time." (throwWithCause), so the innermost cause alone would refuse every such red. For the
// files the red reporter marks as run in a browser — and only there — browserCauseVerdict looks
// through that wrapper at the error it wraps: an AssertionError, a failed expect.element matcher
// (a `matcher` cause: jest-dom style matchers throw a plain Error), the locator error of an
// element that never appeared ("Cannot find element with locator", VitestBrowserElementError).
// The poll's own timeout ("expect.poll() function didn't resolve in time.") is what expect.element
// ends in when the wait runs out while the element lookup is still going, but also what any
// expect.poll whose function hangs ends in; it counts only when the wait can only have been
// expect.element: the failing call was made in the test file itself (`site`: the first stack frame
// outside the dependencies) and the file's code never uses `poll` (`poll_in_source`; comments and
// string literals do not count) — both recorded by the red reporter. Rule-test authors wait for
// elements with expect.element in the test file, never with expect.poll. A browser that did not
// start, an error thrown by the page, a module not found, a TypeError, a strict-mode violation
// (several elements) and a bare element lookup outside a wait stay invalid.
//
// Build smoke tests (F1-01k; `test/spec/**/*.smoke.test.ts`, project build-smoke: Node tests that
// open the entries the globalSetup built and serves, through the playwright library): red for an
// assertion, or because the element a test waits for never came — Playwright's TimeoutError of
// `locator.waitFor` ("locator.waitFor: Timeout <n>ms exceeded.") — is a valid red. Everything else
// stays invalid: a globalSetup that failed (a build, a server, the health check: no test runs), a
// browser that did not launch, a page.goto that failed or timed out, a `net::ERR_*`, any other
// Playwright timeout (screenshot, click …). A page that throws while rendering does not fail the
// test itself: Playwright only fires `pageerror`, the page stays blank and the wait runs out. The
// rule tests collect page events into an annotation whose JSON attachment is
// `{entry, url, diagnostics: [{kind, message}]}` (never asserted), and the red reporter keeps the
// annotations of every test. Before an assertion or a wait that ran out counts, the diagnostics
// are read: an error the page threw (`pageerror`; the skeleton's NotImplemented excepted), a
// request to the entry's own origin that failed (`requestfailed`; requests the test itself
// blocked excepted), a module of the page that did not load (`console.error` of a failed
// dynamic import) or a script error the page only logged (`console.error` carrying React
// Router's "caught the following error during render" — its errorElement catches a render error,
// so no `pageerror` fires — or naming a TypeError, ReferenceError, SyntaxError, RangeError …;
// the skeleton's NotImplemented excepted) make the red invalid. So do the errors a page swallows
// without either (F1-01m; the rule tests install a collector before any page script runs): a
// `preload-error` (Vite's `vite:preloadError`: a lazy chunk or a dependency that did not load or
// threw while initialising, e.g. a chunk served 200 whose module throws a TypeError), an
// `unhandled-rejection` (both with the skeleton's NotImplemented excepted), a `route-error` (the
// H5 route error page React Router's errorElement shows; excepted only when the same diagnostics
// carry the skeleton's NotImplemented that explains it) and a `diagnostics-incomplete` (the test
// could not read the page back: its events are not fully known). Only a page error whose first line starts with
// `NotImplemented` or `Error: NotImplemented` is the skeleton's (a TypeError, ReferenceError …
// mentioning it is not; those kinds are checked first, as on the Node side). A wait that ran out
// in a test without such an annotation is invalid (the page events are unknown); any other red of
// such a test is judged by its failure alone. Both are said in the result (`notes`). Smoke rule
// tests that open a page must write the annotation. On a green run the build-smoke project's
// strict reporter (tools/ops/build-smoke/strict-reporter.mjs) fails on the same page problems.
//
// Files that already existed at the base (CT-06p; orchestrator ruling of 2026-10-18 14:1x): a task
// that changes a rule-test file merged earlier (an exact assertion synchronised with its new
// column, a new test next to the old ones) needs only its new and changed tests red. Given the
// base and head content of the expected files (ruleTestBaselines; verify-container.sh --red passes
// the base and the snapshot tree), a test of such a file whose block is unchanged since the base
// (lib/test-blocks.ts: same test text under the same describe titles, same order, same code
// outside the tests) is exempt: it may pass on the skeleton; if it fails, the failure must still
// be a valid red; skipped / todo stays refused. The exempt tests are listed in `exempt` and in
// `notes`. Whatever cannot be read for certain counts as changed: the whole file is judged as
// before (every test red, the reason in `notes`) when code outside its tests changed, it cannot be
// tokenized (or is JSX), or it may read a test-support file the task changed inside its
// test_paths (a helper, fixture or data file; mayReadSupport), and only reports of the red
// reporter get exemptions. A file that existed at the base and has no new or changed test at all
// fails (nothing would be shown red; evidence-check wants a red test of every expected file). New
// files, the expected list (what the red run runs) and every other rule are unchanged.
// Another rule-test file the task changed is not a test-support file: it is in the expected list
// and judged on its own (CT-06zzz, D10-586, after B1-08zh). It makes a file judged as a whole only
// when a module of the file's closure explicitly imports it (mayImportRuleTest); a kit that loads
// by a computed name no longer counts as reading it. Helpers, fixtures and data files stay as above.
//
// Declared exemptions (CT-06r; orchestrator ruling of 2026-10-18 21:5x after B2-01l): a file that
// existed at the base, whose code outside the tests is unchanged and whose tests compare cleanly,
// but which is judged as a whole only because it may read a test-support file the task changed
// (a fixture, helper or data file inside test_paths: `kind: 'support'`), holds its unchanged
// tests to the red rule unless the task's trusted ledger declares them exempt one by one
// (`red_exempt`: file, the test's full name, a reason of at least 10 characters;
// tools/lib/task-file.ts). A structural test of a data-driven file (the format of a CSV, debits
// paired with credits) holds for the old data as well and cannot be shown red for a valid
// reason; forcing it red would be a fake. A declared test may pass on the skeleton (red still
// needs a valid reason); every other test of the file must be red, as before. A declaration does
// not apply to a new or changed test (it must be red), to a file judged as a whole for any other
// reason (code outside the tests changed, unreadable, JSX, not the red reporter), or when the
// comparison could not be made; what it does not cover stays as CT-06p. The declared tests are
// listed in `exempt` (with `declared` and the reason) and in `notes`, which say that the
// rule-test reviewer must confirm them: tools/ci/evidence-check.ts requires
// `spec_test_review.red_exempt_confirmed` when the ledger declares any. A file whose every test is
// declared fails (nothing would be shown red).
//
// Declared renames (CT-06zxc; orchestrator ruling D10-347 of 2026-10-25 after B1-03w, round 2 of
// 10-27): a task that renames a literal its frozen rule tests spell (a queue job name
// 'freeze-expiry' → 'freeze_expiry') must change those files in the same merge, which made a file
// judged as a whole ("code outside the tests changed") or its tests count as changed, and their
// unchanged tests, red on the old code for an unknown job name, red for no valid reason. The
// trusted ledger may declare such renames (`renames`: from / to, literal strings;
// tools/lib/task-file.ts). In the base content of a rule-test file that existed at the base, each
// `from` becomes its `to` (in ledger order, every occurrence, never a pattern: applyRenames).
// A file whose renamed base is its head character for character is an unchanged file: it is left
// out of the expected list (renamedOnlyFiles; red-check.ts --print-expected, the check itself and
// tools/ci/evidence-check.ts all leave it out), so it is neither run nor judged, and the notes say
// which, with the renames that hit, for the rule-test reviewer. A file that still differs is
// compared test by test against the renamed base (ruleTestBaselines): a test that differs only by
// the renames is unchanged, any other difference (an assertion, a helper, a title) is caught as
// before. The head, the support files and new files are never renamed; without renames nothing
// changes.
//
// Registered expected values (CT-06zxe; orchestrator ruling D10-371 after B2-15l, which changes
// `diff_fen: AMOUNT` to `-AMOUNT` in the top-level helper `onlyAnomaly` of a frozen test): a
// change in a helper made the file judged as a whole, and its tests that never call the helper
// are green on the old code. The trusted ledger may register such changes one by one
// (`expected_values`: file / helper / from / to, from and to of the same value skeleton;
// tools/lib/task-file.ts). In the base of the file (after the renames), inside the source range
// of the top-level helper `helper`, the one occurrence of `from` becomes `to`
// (applyExpectedValues). An entry does not apply — the file is judged as before, the notes say
// why — when the helper is not a top-level helper of the base (or is declared twice), when `from`
// occurs in it other than exactly once, when the helper's value skeleton changes (`from` cut
// out of a longer token), or when a changed value stands neither as an object property value of
// an expectation nor as the expected argument of an expect chain's matcher, or inside a query
// call (test-blocks.ts valueChangeRefusal; CT-06zxh: a fixture's or a query's input object, a
// ternary branch, a type annotation, `n.toString(16)` are refused; CT-06zxi, D10-388: so is a
// value inside a function body between it and the matcher, an IIFE's local input included).
// When the code outside the tests is then the head's character for
// character (every change outside the tests is registered), the file is judged test by test: a
// test block that calls a changed helper, directly or through other top-level helpers, a
// template's `${…}` included (test-blocks.ts helperImpact), counts as changed and must be red; every other block follows
// CT-06p (unchanged: exempt). A changed helper that no test block calls is a problem (the entry
// is void); a helper used anywhere else outside the tests (a hook, a describe body, a top-level
// table) judges the whole file, and so does a string, template or regular expression literal of
// the base, outside the changed helpers, naming one of the closure as a whole word (CT-06zxh,
// review r2 S2-1: `eval('h()')`, `m['h']()` after a dynamic import; helperNamedInLiteral).
// When the code outside the tests still differs, the file is
// judged as a whole, as before (if the head does not make a registered change at all, the file
// is compared without the entries). Without entries nothing changes.
//
// Declared outside changes (CT-06zzzc; orchestrator ruling D10-623 after F1-02zzzb, which must
// add an import to two frozen rule-test files, take a row group out of a top-level table of one
// and sign the fixture values of the other): a file whose code outside the tests changed is
// judged as a whole, so the ledger's red_exempt declarations of its unchanged tests did not
// apply. The trusted ledger may list such a file (`red_exempt_outside`: file / reason;
// tools/lib/task-file.ts; tools/ops/task.ts checks it is a rule-test file of test_paths that
// exists at the base). For a listed file only, after the renames and the registered expected
// values (in that order; when they leave it unchanged outside the tests nothing more is needed),
// a file still judged as a whole because its code outside the tests changed is compared with
// test-blocks.ts compareOutsideChanged: the file is then of kind `support` — every test must be
// red except the declared ones whose block is the base's (same text, describes, enclosing code,
// position among the aligned code outside the tests, order), which may pass. A test calling a
// registered changed helper still counts as changed. A new or changed test must still be red; a
// file that cannot be compared (not tokenized, JSX, not the red reporter's report, too many
// changes) stays judged as a whole; a file whose every test is declared still fails. The notes
// list the head lines of the changes outside the tests (`L10-12, L33`; a removal is shown at the
// lines around it) with the declared reason, for the rule-test reviewer, who confirms them with
// the exemptions (spec_test_review.red_exempt_confirmed, also required when the ledger has
// red_exempt_outside), and for the orchestrator. A file not listed is judged exactly as before.
// A listed file whose every test is unchanged and declared (CT-06zzzd; orchestrator rulings
// D10-629 / D10-630, after F1-02zzzb's config-etag/domain.int.test.ts, whose 22 tests are all
// declared) is left out of the expected list, as a renamed-only file (outsideOnlyFiles): not run,
// not judged, neither here nor in tools/ci/evidence-check.ts, whose coverage rule is unchanged.
// Only when every test block is unchanged, the exact full names of its tests are certain (a
// plain test with a static title, or an inline `.each([…])` array of literals whose titles are
// formatted as Vitest does, directly in plain describes; Codex review r1 S1: never by a wildcard)
// and the ledger declares exactly those names; the notes say which file, why, its changed lines and that the
// reviewer and the orchestrator confirm it. Otherwise the file stays expected: a file whose every
// test is declared still fails, listed or not.
import { matchesAny } from '../../lib/glob.ts';
import type { Change } from '../../lib/git.ts';
import { RED_EXEMPT_REASON_MIN } from '../../lib/task-file.ts';
import type {
  ExpectedValueDeclaration,
  RedExemptDeclaration,
  RedExemptOutsideDeclaration,
  RenameDeclaration,
  TaskFile,
} from '../../lib/task-file.ts';
import {
  type ComparedBlock,
  compareOutsideChanged,
  compareTestFile,
  helperImpact,
  helperNamedInLiteral,
  type PathKind,
  mayImportRuleTest,
  mayReadSupport,
  relativeClosure,
  topLevelHelpers,
  unchangedTest,
  valueChangeRefusal,
  valueSkeleton,
} from './test-blocks.ts';

/** True when the task must show red rule tests before it is implemented. */
export function redCheckRequired(task: Pick<TaskFile, 'tester'>): boolean {
  return task.tester !== 'none';
}

/** Test files that Vitest runs (the spec-tests package: unit and integration configs). */
export const RULE_TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

/**
 * The rule-test files a task added or changed: inside its test_paths and named like a test.
 * Removed files are not expected (and are refused by the add-only guard anyway).
 */
export function expectedRuleTests(
  changes: readonly Change[],
  testPaths: readonly string[],
): string[] {
  const out = new Set<string>();
  for (const c of changes) {
    if (c.status === 'D') continue;
    if (RULE_TEST_FILE.test(c.path) && matchesAny(c.path, testPaths)) out.add(c.path);
  }
  return [...out].sort();
}

type AssertionResult = {
  fullName?: unknown;
  title?: unknown;
  status?: unknown;
  failureMessages?: unknown;
  /** Failures with their cause chains (red reporter only). */
  failures?: unknown;
  /** The test's annotations, JSON attachments parsed (red reporter only, F1-01k). */
  annotations?: unknown;
};
type FileResult = {
  name?: unknown;
  /** The file ran in a real browser (red reporter, F1-01j). */
  browser?: unknown;
  /** The file's source mentions `poll`, or could not be read (red reporter, F1-01j). */
  poll_in_source?: unknown;
  status?: unknown;
  message?: unknown;
  assertionResults?: unknown;
  failures?: unknown;
};

export type RedProblem = { file: string; test: string | null; reason: string };
/**
 * A test of a file that existed at the base, unchanged since: not held to the red rule. With
 * `declared` (CT-06r) the exemption comes from the task's ledger (`red_exempt`) and needs the
 * rule-test reviewer's confirmation; `reason` is the declared reason.
 */
export type RedExempt = {
  file: string;
  test: string;
  status: 'passed' | 'failed';
  declared?: true;
  reason?: string;
};
export type RedResult = {
  ok: boolean;
  red: string[];
  problems: RedProblem[];
  /**
   * How a valid red was judged when that is worth saying (a smoke test without diagnostics), the
   * exempt tests and why a file that existed at the base was judged as a whole (CT-06p).
   */
  notes: string[];
  /** The exempt tests (present when baselines were given, CT-06p). */
  exempt?: RedExempt[];
};

/**
 * The declared renames that changed the base of a file (CT-06zxc): `applied` says each one and how
 * often it hit; `identical` whether the renamed base is the head, character for character (such a
 * file is normally left out of the expected list: renamedOnlyFiles).
 */
export type RenamedBase = { applied: string[]; identical: boolean };

/**
 * The registered expected values of a file (CT-06zxe): `applied` the entries that changed its
 * base, `skipped` the entries of the file that did not apply (with why), `affected` the titles of
 * the test blocks that call a changed helper (they must be red), `void` the problems that make
 * the registration invalid (a changed helper no test calls), `whole` why they did not lead to a
 * test-by-test judgement (absent when they did).
 */
export type ExpectedValuesBase = {
  applied: ExpectedValueDeclaration[];
  skipped: string[];
  affected: string[];
  void: string[];
  whole?: string;
};

/**
 * How an expected rule-test file that existed at the base is judged (CT-06p). `renamed` (CT-06zxc)
 * is present only when a declared rename changed its base.
 */
export type RuleTestBaseline =
  /** Every test must be red, as for a new file (the reason goes into the notes). */
  (
    | { kind: 'whole'; reason: string }
    /** Only the tests of changed blocks must be red. */
    | { kind: 'tests'; blocks: ComparedBlock[] }
    /**
     * Every test must be red unless the ledger declares it exempt and its block is unchanged
     * (CT-06r): the file may read a test-support file the task changed, the reason says which.
     */
    | { kind: 'support'; reason: string; blocks: ComparedBlock[] }
  ) & {
    renamed?: RenamedBase;
    expectedValues?: ExpectedValuesBase;
    /**
     * CT-06zzzc (D10-623): the file is listed in the ledger's `red_exempt_outside`. `lines` (head
     * lines of the changes outside the tests) is present when the listing applied and the file is
     * of kind `support` because of it; `void` says why it did not apply or was not needed.
     */
    outside?: { reason: string; lines?: string; void?: string };
  };

/**
 * The base content with the declared renames applied (CT-06zxc): in order, every occurrence of
 * `from` becomes `to`, as literal text (split / join: no pattern, no `$` replacement syntax).
 * `applied` lists the renames that hit, with their count.
 */
export function applyRenames(
  text: string,
  renames: readonly RenameDeclaration[],
): { text: string; applied: string[] } {
  let out = text;
  const applied: string[] = [];
  for (const { from, to } of renames) {
    if (from === '') continue; // never declared (task-file.ts refuses it); an empty split is no rename
    const parts = out.split(from);
    if (parts.length === 1) continue;
    out = parts.join(to);
    applied.push(`${JSON.stringify(from)} → ${JSON.stringify(to)} ×${parts.length - 1}`);
  }
  return { text: out, applied };
}

/** How a registered expected value is shown in notes and messages. */
export function expectedValueLabel(e: ExpectedValueDeclaration): string {
  return `${e.file} / ${e.helper}: ${JSON.stringify(e.from)} → ${JSON.stringify(e.to)}`;
}

/**
 * The base content of `file` (renames already applied) with the registered expected values of
 * that file applied (CT-06zxe, see the header): in ledger order, each inside the current source
 * range of its top-level helper, where `from` must occur exactly once and the helper keep its
 * value skeleton. `applied` the entries that changed it, `skipped` why the others did not.
 */
export function applyExpectedValues(
  file: string,
  text: string,
  entries: readonly ExpectedValueDeclaration[],
): { text: string; applied: ExpectedValueDeclaration[]; skipped: string[] } {
  let out = text;
  const applied: ExpectedValueDeclaration[] = [];
  const skipped: string[] = [];
  for (const e of entries) {
    if (e.file !== file) continue;
    const skip = (why: string): void => {
      skipped.push(`${expectedValueLabel(e)}: does not apply (${why})`);
    };
    let found: ReturnType<typeof topLevelHelpers>;
    try {
      found = topLevelHelpers(out);
    } catch (err) {
      skip(`the base cannot be read (${String(err)})`);
      continue;
    }
    if (found.twice.has(e.helper)) {
      skip(`${e.helper} is declared twice at the top level of the base`);
      continue;
    }
    const helper = found.helpers.get(e.helper);
    if (helper === undefined) {
      skip(`the base has no top-level helper ${e.helper}`);
      continue;
    }
    const body = out.slice(helper.start, helper.end);
    const count = e.from === '' ? 0 : body.split(e.from).length - 1;
    if (count !== 1) {
      skip(`from occurs ${count} time(s) in ${e.helper} at the base, not exactly once`);
      continue;
    }
    const changed = body.replace(e.from, () => e.to);
    const skeleton = valueSkeleton(body);
    if (skeleton === null || skeleton !== valueSkeleton(changed)) {
      skip(`the change alters more than a value of ${e.helper} (its value skeleton differs)`);
      continue;
    }
    const refusal = valueChangeRefusal(body, changed);
    if (refusal !== null) {
      skip(`the change in ${e.helper} is not an expected value: ${refusal}`);
      continue;
    }
    out = out.slice(0, helper.start) + changed + out.slice(helper.end);
    applied.push(e);
  }
  return { text: out, applied, skipped };
}

/**
 * The registered expected values that apply to the base of at least one of `files` (after the
 * renames), in ledger order (CT-06zxe). evidence-check wants the rule-test reviewer to confirm
 * exactly these when there is any.
 */
export function expectedValuesHit(
  files: readonly string[],
  read: Pick<BaselineReader, 'base'>,
  renames: readonly RenameDeclaration[],
  entries: readonly ExpectedValueDeclaration[],
): ExpectedValueDeclaration[] {
  if (entries.length === 0) return [];
  const hit = new Set<ExpectedValueDeclaration>();
  for (const file of new Set(files)) {
    const before = read.base(file);
    if (before === null) continue;
    const { applied } = applyExpectedValues(file, applyRenames(before, renames).text, entries);
    for (const e of applied) hit.add(e);
  }
  return entries.filter((e) => hit.has(e));
}

/** Notes for the registered expected values whose file got no baseline (CT-06zxe). */
export function unusedExpectedValueNotes(
  entries: readonly ExpectedValueDeclaration[],
  baselines: ReadonlyMap<string, RuleTestBaseline>,
): string[] {
  return entries
    .filter((e) => baselines.get(e.file)?.expectedValues === undefined)
    .map(
      (e) =>
        `registered expected value ${expectedValueLabel(e)}: not applied (${e.file} is not an expected rule-test file that existed at the base and was compared test by test)`,
    );
}

/**
 * Notes for the red_exempt_outside entries (CT-06zzzc) of files that got no baseline: not an
 * expected rule-test file that existed at the base.
 */
export function unusedOutsideNotes(
  entries: readonly RedExemptOutsideDeclaration[],
  baselines: ReadonlyMap<string, RuleTestBaseline>,
): string[] {
  return entries
    .filter((e) => baselines.get(e.file)?.outside === undefined)
    .map(
      (e) =>
        `red_exempt_outside ${e.file}: not applied (not an expected rule-test file that existed at the base)`,
    );
}

export type BaselineReader = {
  /** Content of a file at the base, null when it does not exist there. */
  base(path: string): string | null;
  /** Content of a file at the head (the tree the red run ran), null when it does not exist. */
  head(path: string): string | null;
  /**
   * What a path is at the head (CT-06w, PathKind: a regular file, a directory, absent, or `other`
   * — a symbolic link, a spelling that is not the tree's; an import never resolves through
   * `other`). Without it, a path `head` finds is a file and any other is absent.
   */
  headKind?(path: string): PathKind;
};

/** Rule-test files compared test by test: TypeScript / JavaScript without JSX. */
const COMPARABLE = /\.[cm]?[jt]s$/;

/** A rule-test file that differs from its base only by the declared renames (CT-06zxc). */
export type RenamedOnly = { file: string; applied: string[] };

/**
 * The files among `files` that existed at the base, can be read at the head and whose base, with
 * the declared renames applied, is the head character for character (CT-06zxc): unchanged files,
 * left out of the expected list. Without renames, none. What cannot be read stays expected.
 */
export function renamedOnlyFiles(
  files: readonly string[],
  read: Pick<BaselineReader, 'base' | 'head'>,
  renames: readonly RenameDeclaration[],
): RenamedOnly[] {
  if (renames.length === 0) return [];
  const out: RenamedOnly[] = [];
  for (const file of [...new Set(files)].sort()) {
    const before = read.base(file);
    if (before === null) continue;
    const after = read.head(file);
    if (after === null) continue;
    const renamed = applyRenames(before, renames);
    if (renamed.applied.length > 0 && renamed.text === after) {
      out.push({ file, applied: renamed.applied });
    }
  }
  return out;
}

/**
 * The declared renames that hit the base of at least one of `files` (CT-06zxc review r1 S2-1), in
 * ledger order, each applied after the ones before it as applyRenames does. evidence-check wants
 * the rule-test reviewer to confirm exactly these (and the files left out) when there is any.
 */
export function renamesHit(
  files: readonly string[],
  read: Pick<BaselineReader, 'base'>,
  renames: readonly RenameDeclaration[],
): RenameDeclaration[] {
  if (renames.length === 0) return [];
  const hit = new Set<number>();
  for (const file of new Set(files)) {
    let text = read.base(file);
    if (text === null) continue;
    renames.forEach(({ from, to }, index) => {
      if (from === '' || text === null) return;
      const parts = text.split(from);
      if (parts.length === 1) return;
      hit.add(index);
      text = parts.join(to);
    });
  }
  return renames.filter((_, index) => hit.has(index));
}

/**
 * A rule-test file left out of the expected list because the ledger lists it in red_exempt_outside
 * and declares every one of its tests, all unchanged (CT-06zzzd, D10-629 / D10-630): `lines` the
 * head lines of its changes outside the tests, `reason` the listing's, `tests` how many.
 */
export type OutsideOnly = { file: string; lines: string; reason: string; tests: number };

/**
 * The files among `files` that existed at the base and are left out of the expected list
 * (CT-06zzzd, D10-630; see the header), as renamedOnlyFiles: red-check.ts --print-expected, the
 * check itself and tools/ci/evidence-check.ts all call it. A file qualifies only when all hold:
 * - it is listed in red_exempt_outside and, after the renames and the registered expected values,
 *   compareOutsideChanged applied to it (ruleTestBaselines: kind `support` with `outside.lines`);
 * - no registered expected value of it is void, and no test block is new or changed (a block
 *   calling a registered changed helper counts as changed);
 * - the exact full names of every block's tests are certain (ComparedBlock.names: static titles,
 *   inline `.each([…])` / `.for([…])` arrays of literals formatted as Vitest does; Codex review r1
 *   S1), distinct, and the file's red_exempt declarations are exactly those names (none missing,
 *   none extra), each with a reason of RED_EXEMPT_REASON_MIN characters.
 * Anything else stays expected and is judged as before (CT-06zzzc). Test-support files are not
 * consulted: whether the file may read one does not change the outcome (its tests are declared).
 */
export function outsideOnlyFiles(
  files: readonly string[],
  read: Pick<BaselineReader, 'base' | 'head'>,
  renames: readonly RenameDeclaration[],
  expectedValues: readonly ExpectedValueDeclaration[],
  outside: readonly RedExemptOutsideDeclaration[],
  declared: readonly RedExemptDeclaration[],
): OutsideOnly[] {
  if (outside.length === 0) return [];
  const listed = new Set(outside.map((o) => o.file));
  const candidates = [...new Set(files)].filter((f) => listed.has(f)).sort();
  const baselines = ruleTestBaselines(
    candidates,
    [],
    [],
    { base: read.base, head: read.head },
    renames,
    expectedValues,
    outside,
  );
  const out: OutsideOnly[] = [];
  for (const file of candidates) {
    const b = baselines.get(file);
    if (b?.kind !== 'support' || b.outside?.lines === undefined) continue;
    if ((b.expectedValues?.void.length ?? 0) > 0) continue;
    if (b.blocks.length === 0) continue;
    if (b.blocks.some((x) => x.changed || !Array.isArray(x.names) || x.names.length === 0)) {
      continue;
    }
    // Codex review r1 S1: the exact full names, never the blocks' wildcard patterns. They must be
    // distinct, and the file's declarations exactly these names, each with a reason.
    const names = b.blocks.flatMap((x) => x.names as string[]);
    const want = new Set(names);
    if (want.size !== names.length) continue;
    const mine = declared.filter((d) => d.file === file);
    const have = new Set(mine.map((d) => d.test));
    if (have.size !== mine.length || have.size !== want.size) continue;
    if (![...want].every((n) => have.has(n))) continue;
    if (mine.some((d) => d.reason.trim().length < RED_EXEMPT_REASON_MIN)) continue;
    const tests = names.length;
    out.push({ file, lines: b.outside.lines, reason: b.outside.reason, tests });
  }
  return out;
}

/** The note that says a file was left out by red_exempt_outside (CT-06zzzd, D10-630). */
export function outsideOnlyNote(r: OutsideOnly): string {
  return `${r.file}: all ${r.tests} tests unchanged and declared exempt; allowed because the file is declared in red_exempt_outside (D10-629 / D10-630; reason: ${r.reason}), left out of the expected list (not run, not judged): nothing in it is shown red; code outside the tests changed at ${r.lines} (head lines; a removal is shown at the lines around it); the rule-test reviewer confirms these changes with the exemptions (evidence spec_test_review.red_exempt_confirmed) and the orchestrator checks them one by one (#24)`;
}

/** The note that says a file was left out of the expected list (CT-06zxc). */
export function renamedOnlyNote(r: RenamedOnly): string {
  return `${r.file}: unchanged after the ledger's renames (D10-347: ${r.applied.join(', ')}), left out of the expected list (not run, not judged); the rule-test reviewer confirms the renames are literal follow-ups only`;
}

/**
 * The baselines of the expected files that existed at the base (same path; a renamed or new file
 * has none: every test must be red). `changes` are the task's changes against the base; the ones
 * inside `scope` (test_paths) other than the file itself are its test-support files. `renames`
 * (CT-06zxc, the trusted ledger's) are applied to each base before it is compared (see the header).
 */
export function ruleTestBaselines(
  expected: readonly string[],
  changes: readonly Change[],
  scope: readonly string[],
  read: BaselineReader,
  renames: readonly RenameDeclaration[] = [],
  expectedValues: readonly ExpectedValueDeclaration[] = [],
  outside: readonly RedExemptOutsideDeclaration[] = [],
): Map<string, RuleTestBaseline> {
  const out = new Map<string, RuleTestBaseline>();
  const support = new Set<string>();
  for (const c of changes) {
    for (const p of [c.path, c.oldPath]) {
      if (p !== undefined && matchesAny(p, scope)) support.add(p);
    }
  }
  // CT-06zzz: the expected files are judged on their own, so they are not helpers of each other.
  const judged = new Set(expected);
  // Test code only: implementation modules do not read test-support files.
  const follow = (p: string): boolean =>
    p.startsWith('test/') || p.startsWith('packages/testing/') || matchesAny(p, scope);
  for (const file of expected) {
    const original = read.base(file);
    if (original === null) continue;
    const after = read.head(file);
    const renamedBase = applyRenames(original, renames);
    const before = renamedBase.text;
    let ev: ExpectedValuesBase | undefined;
    // CT-06zzzc (D10-623): the ledger lists this file in red_exempt_outside.
    const listed = outside.find((o) => o.file === file);
    let outsideState: RuleTestBaseline['outside'] =
      listed === undefined ? undefined : { reason: listed.reason };
    const set = (baseline: RuleTestBaseline): void => {
      out.set(file, {
        ...baseline,
        ...(renamedBase.applied.length === 0
          ? {}
          : { renamed: { applied: renamedBase.applied, identical: before === after } }),
        ...(ev === undefined ? {} : { expectedValues: ev }),
        ...(outsideState === undefined ? {} : { outside: outsideState }),
      });
    };
    const outsideVoid = (why: string): void => {
      if (outsideState !== undefined && outsideState.lines === undefined) {
        outsideState = { ...outsideState, void: why };
      }
    };
    if (after === null) {
      set({ kind: 'whole', reason: 'its content in the red run cannot be read' });
      continue;
    }
    if (!COMPARABLE.test(file)) {
      set({
        kind: 'whole',
        reason: 'only .ts / .js rule-test files are compared test by test (JSX is not read)',
      });
      continue;
    }
    // CT-06zxe (D10-371): the registered expected values of this file (see the header).
    const registered = applyExpectedValues(file, before, expectedValues);
    let compared = compareTestFile(before, after);
    let affected: boolean[] | null = null;
    if (registered.applied.length > 0 || registered.skipped.length > 0) {
      ev = { applied: registered.applied, skipped: registered.skipped, affected: [], void: [] };
    }
    if (ev !== undefined && registered.applied.length > 0) {
      const withValues = compareTestFile(registered.text, after);
      if (withValues.whole) {
        ev.whole = compared.whole
          ? `${withValues.reason}, also after the registered expected values`
          : 'the head does not make the registered change (compared without the registered expected values)';
      } else {
        compared = withValues;
        const helpers = [...new Set(registered.applied.map((e) => e.helper))];
        const found = helperImpact(after, helpers);
        // CT-06zxh (review r2 S2-1): a literal of the base naming the closure, outside the
        // changed helpers, may call one by a string: the whole file.
        const named = found.ok ? helperNamedInLiteral(before, found.closure, helpers) : null;
        const impact: typeof found = named === null ? found : { ok: false, reason: named };
        if (!impact.ok) {
          ev.whole = impact.reason;
          compared = { whole: true, reason: `registered expected values: ${impact.reason}` };
        } else {
          affected = impact.affected;
          for (const h of helpers) {
            const alone = helperImpact(after, [h]);
            if (alone.ok && !alone.affected.some(Boolean)) {
              ev.void.push(
                `the registered helper ${h} is called by no test block: the registration is void`,
              );
            }
          }
          ev.affected = withValues.blocks.filter((_, i) => impact.affected[i]).map((b) => b.title);
        }
      }
    }
    // CT-06zzzc (D10-623): a listed file still judged as a whole because its code outside the
    // tests changed (after the renames and the registered expected values) is compared with
    // compareOutsideChanged; its declared exemptions may then apply (kind `support`, below).
    if (compared.whole && compared.outside === true && listed !== undefined) {
      const withValues = ev !== undefined && ev.applied.length > 0;
      const lenient = compareOutsideChanged(withValues ? registered.text : before, after);
      if (lenient.whole) {
        outsideVoid(lenient.reason);
      } else if (withValues && ev !== undefined) {
        // A test calling a registered changed helper still counts as changed (CT-06zxe).
        const helpers = [...new Set(ev.applied.map((e) => e.helper))];
        const found = helperImpact(after, helpers);
        const named = found.ok ? helperNamedInLiteral(before, found.closure, helpers) : null;
        if (!found.ok || named !== null) {
          outsideVoid(`registered expected values: ${found.ok ? (named as string) : found.reason}`);
        } else {
          compared = { whole: false, blocks: lenient.blocks };
          affected = found.affected;
          delete ev.whole;
          ev.affected = lenient.blocks.filter((_, i) => found.affected[i]).map((b) => b.title);
          for (const h of helpers) {
            const alone = helperImpact(after, [h]);
            if (alone.ok && !alone.affected.some(Boolean)) {
              ev.void.push(
                `the registered helper ${h} is called by no test block: the registration is void`,
              );
            }
          }
          outsideState = { reason: listed.reason, lines: lenient.lines };
        }
      } else {
        compared = { whole: false, blocks: lenient.blocks };
        outsideState = { reason: listed.reason, lines: lenient.lines };
      }
    } else if (compared.whole) {
      outsideVoid(`the file is judged as a whole for another reason: ${compared.reason}`);
    } else {
      outsideVoid("its code outside the tests is the base's (nothing to declare)");
    }
    if (compared.whole) {
      set({ kind: 'whole', reason: compared.reason });
      continue;
    }
    const blocks =
      affected === null
        ? compared.blocks
        : compared.blocks.map((b, i) => (affected[i] === true ? { ...b, changed: true } : b));
    const others = [...support].filter((s) => s !== file).sort();
    const closure =
      others.length === 0
        ? []
        : relativeClosure(
            file,
            (p) => read.head(p),
            follow,
            read.headKind === undefined ? undefined : (p) => read.headKind?.(p) ?? 'other',
          );
    let why: string | null = null;
    for (const s of others) {
      why = judged.has(s) ? mayImportRuleTest(s, closure) : mayReadSupport(file, s, closure);
      if (why !== null) break;
    }
    const outsideLines = outsideState?.lines;
    const reasons = [
      ...(outsideLines === undefined
        ? []
        : [
            `its code outside the tests changed at ${outsideLines} (declared in red_exempt_outside, D10-623)`,
          ]),
      ...(why === null ? [] : [`it may read a test-support file the task changed: ${why}`]),
    ];
    set(
      reasons.length === 0
        ? { kind: 'tests', blocks }
        : { kind: 'support', reason: reasons.join('; '), blocks },
    );
  }
  return out;
}

/** Failures that prove nothing about the rule; checked first, they win over any wrapper. */
const WRONG_RED: [RegExp, string][] = [
  [
    /browserType\.launch|Executable doesn't exist|Failed to launch the browser|Browser connection was closed|did not respond to a heartbeat|Target page, context or browser has been closed/,
    'browser not running',
  ],
  [
    /Cannot find (?:module|package)|Failed to load url|Failed to resolve import|ERR_MODULE_NOT_FOUND/,
    'module not found',
  ],
  [/\bTypeError\b/, 'TypeError'],
  [/\bReferenceError\b/, 'ReferenceError'],
  [/\bSyntaxError\b/, 'SyntaxError'],
  [/\bRangeError: Maximum call stack/, 'stack overflow'],
  [
    /ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|EAI_AGAIN|getaddrinfo/,
    'network or database unreachable',
  ],
  [
    /connection terminated|Connection terminated|password authentication failed|database "[^"]*" does not exist|role "[^"]*" does not exist|too many clients/i,
    'database connection failed',
  ],
  [/TEST_PG_ADMIN_URL/, 'test database not configured'],
  [/migrat(?:e|ion)[^\n]*(?:fail|error)|(?:fail|error)[^\n]*migrat(?:e|ion)/i, 'migration failed'],
  [/\b(?:fixture|seeding)\b[^\n]*\b(?:failed|error)\b/i, 'fixture failed'],
  [/Hook timed out|beforeAll|beforeEach|globalSetup|setupFiles/, 'test setup failed'],
  [/Test timed out/, 'timed out'],
  [
    /EADDRINUSE|server (?:is )?not (?:up|running|ready)|listen E[A-Z]+|health ?check/i,
    'server not up',
  ],
  [
    /[Bb]uild failed|Transform failed|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|Unexpected token/,
    'build failed',
  ],
  [/\bENOENT\b|\bEACCES\b|\bEPERM\b/, 'file system error'],
];
/** What counts: an assertion, the skeleton's NotImplemented. */
const RIGHT_CAUSE = /AssertionError|\bexpected\b[\s\S]*\bto\b|\bNotImplemented\b/;
const PROPERTY = /Property failed after/;
const RETURNED_FALSE = /Property failed by returning false/;

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export type Cause = {
  name: string;
  message: string;
  /** The expect.extend matcher that failed (red reporter; e.g. toBeVisible of expect.element). */
  matcher?: string;
};

/**
 * Why a failure is not a valid red, from its chain of causes (the red reporter keeps them:
 * tools/ops/verify-image/red-reporter.mjs), or null when it is one. The innermost cause decides:
 * an AssertionError, or the NotImplemented a skeleton throws. A property that merely returned
 * false shows no assertion and is refused; so is anything else (fail-closed, CR2-03).
 */
export function causeVerdict(causes: readonly Cause[]): string | null {
  const root = causes[causes.length - 1];
  if (root === undefined) return 'red for an unknown reason (the report carries no failure detail)';
  if (root.name === 'AssertionError') return null;
  const all = causes.map((c) => `${c.name}: ${c.message}`).join('\n');
  for (const [pattern, label] of WRONG_RED) {
    if (pattern.test(all)) return `red for the wrong reason (${label})`;
  }
  if (RETURNED_FALSE.test(root.message)) {
    return 'red for an unrecognised reason (the property returned false: assert with expect inside properties)';
  }
  if (/\bNotImplemented\b/.test(root.message) || /\bNotImplemented\b/.test(root.name)) return null;
  return `red for an unrecognised reason (${root.name}: not an assertion or NotImplemented)`;
}

/**
 * Why a failure message (a plain Vitest JSON report, without causes) is not a valid red, or null
 * when it is one. A fast-check failure counts only when the message itself shows an assertion or
 * NotImplemented under "Got error"; Vitest's own JSON reporter drops the cause, so a property
 * failure there is refused (CR2-03).
 */
export function wrongRedReason(message: string): string | null {
  for (const [pattern, label] of WRONG_RED) {
    if (pattern.test(message)) return `red for the wrong reason (${label})`;
  }
  if (PROPERTY.test(message)) {
    const at = message.search(/Got (?:an )?error/);
    const cause = at < 0 ? '' : message.slice(at);
    if (cause !== '' && RIGHT_CAUSE.test(cause)) return null;
    return 'red for an unrecognised reason (the property failure shows no underlying assertion: run it through verify-container.sh --red)';
  }
  if (RIGHT_CAUSE.test(message)) return null;
  return 'red for an unrecognised reason (not an assertion, a counterexample or NotImplemented)';
}

/** Build smoke rule-test files: the build-smoke project (red-projects.json, F1-01k). */
export const SMOKE_TEST_FILE = /\.smoke\.test\.[cm]?[jt]sx?$/;

/** Failures of a build smoke test that prove nothing about the page under test. */
const SMOKE_WRONG_RED: [RegExp, string][] = [
  [/\bnet::ERR_[A-Z_]+/, 'page did not load (net::ERR_*)'],
  [/\bpage\.goto:/, 'page did not load (page.goto failed)'],
  [/\bbrowserType\.launch\b|\bchromium\.launch\b/, 'browser not running'],
];

/** The message of the TimeoutError Playwright throws when locator.waitFor runs out. */
const LOCATOR_WAIT_RAN_OUT = /^locator\.waitFor: Timeout \d+ms exceeded\./;

/**
 * Verdict of a failure of a build smoke rule test (see the header): an AssertionError, or the
 * TimeoutError of a locator.waitFor whose element never came, is a valid red; a page that did not
 * load, a browser that did not launch, and everything causeVerdict refuses are not.
 */
export function smokeCauseVerdict(causes: readonly Cause[]): string | null {
  const all = causes.map((c) => `${c.name}: ${c.message}`).join('\n');
  for (const [pattern, label] of SMOKE_WRONG_RED) {
    if (pattern.test(all)) return `red for the wrong reason (${label})`;
  }
  const root = causes[causes.length - 1];
  if (
    root?.name === 'TimeoutError' &&
    causes.length === 1 &&
    LOCATOR_WAIT_RAN_OUT.test(root.message)
  ) {
    return null;
  }
  if (root?.name === 'TimeoutError') {
    return `red for the wrong reason (a Playwright timeout outside locator.waitFor: ${root.message.split('\n')[0] ?? ''})`;
  }
  return causeVerdict(causes);
}

/** True when a failure of the test is the TimeoutError of a locator.waitFor (red reporter causes). */
function waitedForAnElement(failures: unknown): boolean {
  if (!Array.isArray(failures)) return false;
  return (failures as Failure[]).some((f) => {
    const causes = causesOf(f);
    const root = causes[causes.length - 1];
    return root?.name === 'TimeoutError' && LOCATOR_WAIT_RAN_OUT.test(root.message);
  });
}

/** The page events a build smoke test collected for one entry (its diagnostics annotation). */
export type SmokeDiagnostics = {
  url: string;
  diagnostics: { kind: string; message: string }[];
};

/**
 * The diagnostics annotations of a test of the red report: every annotation whose JSON
 * attachment has a `diagnostics` array (the build smoke rule tests write one per entry they open).
 */
export function smokeDiagnosticsOf(annotations: unknown): SmokeDiagnostics[] {
  if (!Array.isArray(annotations)) return [];
  const out: SmokeDiagnostics[] = [];
  for (const a of annotations) {
    if (typeof a !== 'object' || a === null) continue;
    const json = (a as Record<string, unknown>)['json'];
    if (typeof json !== 'object' || json === null) continue;
    const list = (json as Record<string, unknown>)['diagnostics'];
    if (!Array.isArray(list)) continue;
    out.push({
      url: text((json as Record<string, unknown>)['url']),
      diagnostics: list.map((d) => {
        const r = (typeof d === 'object' && d !== null ? d : {}) as Record<string, unknown>;
        return { kind: text(r['kind']), message: text(r['message']) };
      }),
    });
  }
  return out;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** A failed dynamic import, as the browser logs it (Chromium and others). */
const MODULE_DID_NOT_LOAD =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/;

/**
 * True when the first line of an error the page threw is the skeleton's NotImplemented: it starts
 * with `NotImplemented` (the skeleton's own error class) or `Error: NotImplemented` (a plain Error
 * with that message). A TypeError, ReferenceError … that merely mentions NotImplemented does not
 * count: as on the Node side (causeVerdict), those kinds are checked first.
 */
export function skeletonPageError(first: string): boolean {
  for (const [pattern] of WRONG_RED) {
    if (pattern.test(first)) return false;
  }
  return /^(?:Error: )?NotImplemented\b/.test(first);
}

/**
 * The prefix React Router (and its <Await>) logs before an error its error boundary caught while
 * rendering: `console.error("React Router caught the following error during render", error)`,
 * which Playwright reads as that text, a space, then the error's stack.
 */
const CAUGHT_DURING_RENDER = /^.*?caught the following error during render\s*/;
/** Error kinds of a script fault, as a console.error of the page names them. */
const SCRIPT_ERROR_KIND =
  /\b(?:TypeError|ReferenceError|SyntaxError|RangeError|EvalError|URIError|InternalError|AggregateError)\b/;

/**
 * True when a `console.error` of the page reports a script fault (Codex review r3, S1 ②): an
 * error an error boundary caught while rendering (React Router's errorElement swallows it, no
 * `pageerror` fires, the page shows its error screen and the wait runs out), or any message
 * naming a TypeError, ReferenceError, SyntaxError, RangeError …. With `skeleton` the skeleton's
 * NotImplemented is excepted: the first line of the error itself (after React Router's prefix)
 * starts with `NotImplemented` or `Error: NotImplemented` (skeletonPageError).
 */
export function scriptFaultConsoleError(message: string, skeleton: boolean): boolean {
  const first = message.split('\n')[0] ?? '';
  if (!CAUGHT_DURING_RENDER.test(first) && !SCRIPT_ERROR_KIND.test(message)) return false;
  return !(skeleton && skeletonPageError(first.replace(CAUGHT_DURING_RENDER, '')));
}

/**
 * True when the diagnostics of one entry carry the skeleton's NotImplemented (an error the page
 * threw, an error an error boundary caught while rendering, a failed lazy module or an unhandled
 * rejection whose first line is the skeleton's): the one thing that excuses a `route-error`.
 */
function skeletonExplains(diagnostics: SmokeDiagnostics['diagnostics']): boolean {
  return diagnostics.some((x) => {
    const first = x.message.split('\n')[0] ?? '';
    if (['pageerror', 'preload-error', 'unhandled-rejection'].includes(x.kind)) {
      return skeletonPageError(first);
    }
    return (
      x.kind === 'console.error' &&
      CAUGHT_DURING_RENDER.test(first) &&
      !scriptFaultConsoleError(x.message, true)
    );
  });
}

/**
 * Why the page events of one entry make a red invalid (see the header), or null when they do
 * not: an error the page threw other than the skeleton's NotImplemented, a request to the entry's
 * own origin that failed and that the test did not block itself (a `blocked-request` of the same
 * URL), a dynamic import that failed, a script error the page only logged
 * (scriptFaultConsoleError), and what the page swallowed (F1-01m): a lazy module that failed
 * (`preload-error`) or an unhandled rejection, both other than the skeleton's NotImplemented, the
 * route error page unless the skeleton's NotImplemented explains it (skeletonExplains), and
 * diagnostics the test could not read back (`diagnostics-incomplete`). A URL that cannot be read
 * counts as the entry's own.
 */
export function smokeDiagnosticsVerdict(d: SmokeDiagnostics): string | null {
  const own = originOf(d.url);
  const blocked = new Set(
    d.diagnostics.filter((x) => x.kind === 'blocked-request').map((x) => x.message),
  );
  for (const x of d.diagnostics) {
    const first = x.message.split('\n')[0] ?? '';
    if (x.kind === 'pageerror' && !skeletonPageError(first)) {
      return `red for the wrong reason (the page threw: ${first})`;
    }
    if (x.kind === 'preload-error' && !skeletonPageError(first)) {
      return `red for the wrong reason (a lazy module of the page failed: ${first})`;
    }
    if (x.kind === 'unhandled-rejection' && !skeletonPageError(first)) {
      return `red for the wrong reason (the page left a rejection unhandled: ${first})`;
    }
    if (x.kind === 'route-error' && !skeletonExplains(d.diagnostics)) {
      return `red for the wrong reason (the page showed its route error page: ${first})`;
    }
    if (x.kind === 'diagnostics-incomplete') {
      return `red for an unproven reason (the page events are not fully known: ${first})`;
    }
    if (x.kind === 'requestfailed') {
      // "<url>: <errorText>" (the rule tests' format)
      const at = x.message.lastIndexOf(': ');
      const url = at < 0 ? x.message : x.message.slice(0, at);
      if (blocked.has(url)) continue;
      const origin = originOf(url);
      if (own === null || origin === null || origin === own) {
        return `red for the wrong reason (a request of the entry failed: ${first})`;
      }
    }
    if (x.kind === 'console.error' && MODULE_DID_NOT_LOAD.test(x.message)) {
      return `red for the wrong reason (a module of the page did not load: ${first})`;
    }
    if (x.kind === 'console.error' && scriptFaultConsoleError(x.message, true)) {
      return `red for the wrong reason (the page logged a script error: ${first})`;
    }
  }
  return null;
}

/** Browser rule-test files: the spec-browser project (tools/ops/verify-image/red-projects.json). */
export const BROWSER_TEST_FILE = /\.browser\.test\.[cm]?[jt]sx?$/;

/** The cause vitest 5.0.1 adds when an expect.poll / expect.element wait runs out. */
const WAIT_RAN_OUT = 'Matcher did not succeed in time.';
/** expect.poll's own timeout while the polled function (the element lookup) was still running. */
const LOOKUP_STILL_WAITING = "expect.poll() function didn't resolve in time.";
/** The error of a locator whose element never appeared (@vitest/browser getElementError). */
const ELEMENT_NOT_FOUND = 'Cannot find element with locator: ';

/** What a browser wait may wrap for its red to count: an assertion, or an element never seen. */
function waitedForTheRightThing(c: Cause): boolean {
  if (c.name === 'AssertionError') return true;
  if (c.matcher !== undefined && c.matcher !== '') return true;
  return c.name === 'VitestBrowserElementError' && c.message.startsWith(ELEMENT_NOT_FOUND);
}

export type BrowserWait = {
  /**
   * The wait can only have been expect.element: the failing call was made in the test file
   * itself and that file never mentions `poll` (see the header).
   */
  elementOnly: boolean;
};

/**
 * Verdict of a failure of a browser rule test (see the header): an expect.element / expect.poll
 * wait that ran out counts when what it waited for was an assertion or an element; the poll's own
 * timeout counts only for a wait that can only have been expect.element; a failed matcher counts
 * like an assertion. Everything else is judged by causeVerdict.
 */
export function browserCauseVerdict(
  causes: readonly Cause[],
  wait: BrowserWait = { elementOnly: false },
): string | null {
  const root = causes[causes.length - 1];
  if (root === undefined) return causeVerdict(causes);
  if (root.name === 'Error' && root.message === WAIT_RAN_OUT && causes.length >= 2) {
    const waited = causes[causes.length - 2];
    if (waited !== undefined && waitedForTheRightThing(waited)) return null;
    if (waited?.name === 'Error' && waited.message === LOOKUP_STILL_WAITING) {
      if (wait.elementOnly) return null;
      return (
        'red for an unrecognised reason (an expect.poll timed out and nothing shows it waited ' +
        'for an element: wait with expect.element in the test file itself, never expect.poll)'
      );
    }
    return causeVerdict(causes.slice(0, -1));
  }
  if (root.matcher !== undefined && root.matcher !== '') return null;
  return causeVerdict(causes);
}

/**
 * True when `site` (the first parsed stack frame the red reporter recorded) is the test file
 * `abs`: the same absolute path (also behind the browser's http://localhost:<port>, as `file://`
 * or Vite's `/@fs` URL), or the URL path below the test package (`/spec/…`), without a query.
 * The red reporter already records the first frame outside the dependencies, normalised.
 */
function siteIsFile(site: unknown, abs: string): boolean {
  if (typeof site !== 'object' || site === null) return false;
  const raw = text((site as Record<string, unknown>)['file']);
  const file = raw
    .replace(/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?=\/)/, '')
    .replace(/^file:\/\//, '')
    .replace(/^\/@fs(?=\/)/, '')
    .replace(/[?#].*$/, '');
  if (file === '' || abs === '') return false;
  return file === abs || (file.startsWith('/spec/') && abs.endsWith(`/test${file}`));
}

type Failure = { causes?: unknown; site?: unknown };

function causesOf(failure: Failure): Cause[] {
  return Array.isArray(failure.causes)
    ? failure.causes.map((c) => {
        const r = (typeof c === 'object' && c !== null ? c : {}) as Record<string, unknown>;
        const cause: Cause = { name: text(r['name']), message: text(r['message']) };
        const matcher = text(r['matcher']);
        if (matcher !== '') cause.matcher = matcher;
        return cause;
      })
    : [];
}

/** How a browser file of the report is read: null for every other file. */
type BrowserFile = { abs: string; pollFree: boolean } | null;

/** Verdict of one failed test: structured causes when the report has them, else the messages. */
function testVerdict(
  failures: unknown,
  messages: string[],
  browser: BrowserFile,
  smoke: boolean,
): string | null {
  if (Array.isArray(failures)) {
    if (failures.length === 0)
      return 'red for an unknown reason (the report carries no failure detail)';
    for (const f of failures as Failure[]) {
      const why =
        browser !== null
          ? browserCauseVerdict(causesOf(f), {
              elementOnly: browser.pollFree && siteIsFile(f.site, browser.abs),
            })
          : smoke
            ? smokeCauseVerdict(causesOf(f))
            : causeVerdict(causesOf(f));
      if (why !== null) return why;
    }
    return null;
  }
  return wrongRedReason(messages.join('\n'));
}

/** Why a declared exemption (CT-06r) does not apply, or null when it does. */
function declarationVerdict(
  declaration: RedExemptDeclaration,
  fullName: string,
  blocks: readonly ComparedBlock[],
): string | null {
  if (!unchangedTest(fullName, blocks)) {
    return 'the test is new or changed since the base (only an unchanged test may be declared exempt)';
  }
  if (declaration.reason.trim().length < RED_EXEMPT_REASON_MIN) {
    return `the reason is shorter than ${RED_EXEMPT_REASON_MIN} characters`;
  }
  return null;
}

/**
 * Checks Vitest JSON reports against the expected rule-test files (repository-relative). `root`
 * is stripped from the absolute file names Vitest reports. `baselines` (CT-06p) say how the
 * expected files that existed at the base are judged (see the header); without them every test
 * of every expected file must be red. `declared` (CT-06r) are the task's declared exemptions
 * (the trusted ledger's `red_exempt`); they apply only with baselines, to a file of kind
 * `support`, and to a test whose block is unchanged.
 */
export function checkRedReports(
  reports: readonly unknown[],
  expected: readonly string[],
  root: string,
  baselines?: ReadonlyMap<string, RuleTestBaseline>,
  declared: readonly RedExemptDeclaration[] = [],
): RedResult {
  const problems: RedProblem[] = [];
  const red: string[] = [];
  const notes: string[] = [];
  const exempt: RedExempt[] = [];
  const confirmation =
    "needs the rule-test reviewer's confirmation (evidence spec_test_review.red_exempt_confirmed)";
  // Declarations that named an expected file (the others are said in the notes at the end).
  const declaredSeen = new Set<RedExemptDeclaration>();
  const prefix = root.endsWith('/') ? root : `${root}/`;
  const seen = new Map<string, FileResult>();
  // Files reported by the trusted red reporter: only their full names are `describe > … > test`.
  const byRedReporter = new Set<FileResult>();
  for (const report of reports) {
    const files =
      typeof report === 'object' &&
      report !== null &&
      Array.isArray((report as { testResults?: unknown }).testResults)
        ? ((report as { testResults: unknown[] }).testResults as FileResult[])
        : null;
    if (files === null) {
      problems.push({ file: '', test: null, reason: 'not a Vitest JSON report' });
      continue;
    }
    // Errors outside any test (an unhandled rejection, a crashed worker) taint the whole run.
    const unhandled = (report as { unhandledErrors?: unknown }).unhandledErrors;
    if (Array.isArray(unhandled) && unhandled.length > 0) {
      const why =
        causeVerdict(causesOf(unhandled[0] as Failure)) ?? 'an assertion outside any test';
      problems.push({ file: '', test: null, reason: `the run had unhandled errors: ${why}` });
    }
    const fromRedReporter = (report as { reporter?: unknown }).reporter === 'couli-red-reporter';
    for (const entry of files) {
      const abs = text(entry.name);
      seen.set(abs.startsWith(prefix) ? abs.slice(prefix.length) : abs, entry);
      if (fromRedReporter) byRedReporter.add(entry);
    }
  }
  if (expected.length === 0) {
    problems.push({ file: '', test: null, reason: 'the task added no rule-test file to check' });
  }
  for (const file of expected) {
    const entry = seen.get(file);
    if (entry === undefined) {
      problems.push({
        file,
        test: null,
        reason: 'not in the report: this rule-test file did not run',
      });
      continue;
    }
    const tests = Array.isArray(entry.assertionResults)
      ? (entry.assertionResults as AssertionResult[])
      : [];
    // Browser leniency only for a browser rule-test file that the red reporter saw run in a
    // browser; Vitest's own JSON report (no `browser`, no causes) never gets it.
    const browser: BrowserFile =
      entry.browser === true && BROWSER_TEST_FILE.test(file)
        ? { abs: text(entry.name), pollFree: entry.poll_in_source === false }
        : null;
    // Build smoke leniency (locator.waitFor) only for a build smoke rule-test file of the
    // build-smoke project (test/spec/**/*.smoke.test.ts, red-projects.json) that ran in Node (not
    // in a browser), and only from the red reporter's causes; the plain messages of Vitest's JSON
    // report never get it.
    const smoke =
      entry.browser !== true && file.startsWith('test/spec/') && SMOKE_TEST_FILE.test(file);
    // File-level errors (an import that failed, a crashed beforeAll / afterAll) are never a valid
    // red: they taint every test of the file.
    const fileFailures = Array.isArray(entry.failures) ? (entry.failures as Failure[]) : [];
    const fileWhy = text(entry.message);
    const fileWrong =
      fileFailures.length > 0
        ? (causeVerdict(causesOf(fileFailures[0] as Failure)) ??
          'an error outside the tests of this file')
        : fileWhy === ''
          ? null
          : (wrongRedReason(fileWhy) ?? 'an error outside the tests of this file');
    if (tests.length === 0) {
      problems.push({
        file,
        test: null,
        reason:
          fileWrong === null
            ? 'no test ran in this rule-test file'
            : `the file did not load: ${fileWrong}`,
      });
      continue;
    }
    // CT-06p: a file that existed at the base needs only its new and changed tests red.
    // CT-06r: a file of kind `support` needs every test red except the declared, unchanged ones.
    const baseline = baselines?.get(file);
    if (baseline?.renamed !== undefined) {
      notes.push(
        `${file}: compared with its base after the ledger's renames (D10-347: ${baseline.renamed.applied.join(', ')})` +
          (baseline.renamed.identical
            ? '; the renamed base is identical to the head'
            : '; the renamed base still differs from the head'),
      );
    }
    const ev = baseline?.expectedValues;
    if (ev !== undefined) {
      for (const why of ev.skipped) notes.push(`${file}: registered expected value ${why}`);
      if (ev.applied.length > 0) {
        notes.push(
          `${file}: compared with its base after the registered expected values (D10-371: ${ev.applied
            .map(expectedValueLabel)
            .join('; ')})` +
            (ev.whole === undefined
              ? `; tests calling the changed helper(s), which must be red: ${ev.affected.length === 0 ? 'none' : ev.affected.join(' | ')}; the rule-test reviewer confirms the entries change expected values only`
              : `; not judged by the helpers' impact: ${ev.whole}`),
        );
      }
      for (const why of ev.void) problems.push({ file, test: null, reason: why });
    }
    // CT-06zzzc (D10-623): what the file's red_exempt_outside listing did.
    const listed = baseline?.outside;
    if (listed !== undefined) {
      if (listed.lines !== undefined) {
        notes.push(
          `${file}: code outside the tests changed at ${listed.lines} (head lines; a removal is shown at the lines around it), declared in red_exempt_outside (D10-623; reason: ${listed.reason}): the ledger's red_exempt declarations apply to its unchanged tests; the rule-test reviewer confirms these changes with the exemptions (evidence spec_test_review.red_exempt_confirmed) and the orchestrator checks them one by one`,
        );
      } else {
        notes.push(
          `${file}: declared in red_exempt_outside, but the declaration does not apply: ${listed.void ?? (baseline?.kind === 'whole' ? `the file is judged as a whole for another reason: ${baseline.reason}` : 'nothing to declare')}`,
        );
      }
    }
    const declaredHere = baselines === undefined ? [] : declared.filter((d) => d.file === file);
    for (const d of declaredHere) declaredSeen.add(d);
    let blocks: ComparedBlock[] | null = null;
    let declarable: ComparedBlock[] | null = null;
    const wholeDespite = (why: string): void => {
      if (declaredHere.length > 0) {
        notes.push(
          `${file}: ${declaredHere.length} declared exemption(s) do not apply: ${why} (a declaration applies only to a file judged as a whole because it may read a changed test-support file)`,
        );
      }
    };
    if (baseline?.kind === 'whole') {
      notes.push(
        `${file}: existed at the base, judged as a whole (every test must be red): ${baseline.reason}`,
      );
      wholeDespite(baseline.reason);
    } else if (
      (baseline?.kind === 'tests' || baseline?.kind === 'support') &&
      !byRedReporter.has(entry)
    ) {
      notes.push(
        `${file}: existed at the base, judged as a whole (every test must be red): the report is not from the red reporter`,
      );
      wholeDespite('the report is not from the red reporter');
    } else if (baseline?.kind === 'tests') {
      blocks = baseline.blocks;
      if (declaredHere.length > 0) {
        notes.push(
          `${file}: ${declaredHere.length} declared exemption(s) are not needed: the file is judged test by test (its unchanged tests are exempt by themselves)`,
        );
      }
    } else if (baseline?.kind === 'support') {
      declarable = baseline.blocks;
      notes.push(
        `${file}: existed at the base, judged as a whole except the tests the ledger declares exempt (every other test must be red): ${baseline.reason}`,
      );
    } else if (declaredHere.length > 0) {
      wholeDespite('the file is new, renamed or could not be compared with the base');
    }
    let required = 0;
    const matched = new Set<RedExemptDeclaration>();
    for (const t of tests) {
      const fullName = text(t.fullName);
      const name = fullName || text(t.title);
      const status = text(t.status);
      let unchanged = blocks !== null && unchangedTest(fullName, blocks);
      let declaration: RedExemptDeclaration | null = null;
      if (declarable !== null && fullName !== '') {
        const d = declaredHere.find((x) => x.test === fullName);
        if (d !== undefined) {
          matched.add(d);
          const why = declarationVerdict(d, fullName, declarable);
          if (why === null) {
            declaration = d;
            unchanged = true;
          } else {
            notes.push(
              `${file} > ${name}: declared exempt, but the declaration does not apply: ${why}; the test must be red`,
            );
          }
        }
      }
      if (!unchanged) required += 1;
      const exemptEntry = (status: 'passed' | 'failed'): RedExempt =>
        declaration === null
          ? { file, test: name, status }
          : { file, test: name, status, declared: true, reason: declaration.reason };
      const exemptNote = (how: string): string =>
        declaration === null
          ? `${file} > ${name}: unchanged since the base, exempt from the red rule (${how})`
          : `${file} > ${name}: unchanged since the base, exempt by the task's declaration (${how}; reason: ${declaration.reason}); ${confirmation}`;
      if (status === 'passed') {
        if (unchanged) {
          exempt.push(exemptEntry('passed'));
          notes.push(exemptNote('green'));
          continue;
        }
        problems.push({
          file,
          test: name,
          reason:
            blocks !== null
              ? 'green on the skeleton: the test has no teeth (new or changed since the base)'
              : declarable !== null
                ? 'green on the skeleton: the test has no teeth (the file may read a test-support file the task changed and the ledger does not declare this test exempt)'
                : 'green on the skeleton: the test has no teeth',
        });
        continue;
      }
      if (status !== 'failed') {
        problems.push({
          file,
          test: name,
          reason: `status "${status}" (skipped, todo or pending is not red)`,
        });
        continue;
      }
      const messages = Array.isArray(t.failureMessages) ? t.failureMessages.map(text) : [];
      let why = fileWrong ?? testVerdict(t.failures, messages, browser, smoke);
      if (why === null && smoke) {
        // The page events the test collected decide before its red counts (see the header).
        const diagnostics = smokeDiagnosticsOf(t.annotations);
        for (const d of diagnostics) {
          why = smokeDiagnosticsVerdict(d);
          if (why !== null) break;
        }
        if (why === null && diagnostics.length === 0) {
          if (waitedForAnElement(t.failures)) {
            // A wait that ran out says nothing without the page events: the page may have thrown.
            why =
              'red for an unproven reason (locator.waitFor ran out but the test wrote no browser diagnostics annotation)';
            notes.push(
              `${file} > ${name}: locator.waitFor timeout without browser diagnostics, judged invalid`,
            );
          } else {
            notes.push(
              `${file} > ${name}: no browser diagnostics in the report, judged by the failure alone`,
            );
          }
        }
      }
      if (why === null) {
        red.push(`${file} > ${name}`);
        if (unchanged) {
          exempt.push(exemptEntry('failed'));
          notes.push(exemptNote('red for a valid reason'));
        }
      } else {
        problems.push({ file, test: name, reason: why });
      }
    }
    for (const d of declaredHere) {
      if (declarable !== null && !matched.has(d)) {
        notes.push(
          `${file}: the declared exemption of "${d.test}" matches no test of the report (the full name must be exactly the red reporter's)`,
        );
      }
    }
    if (blocks !== null && required === 0) {
      problems.push({
        file,
        test: null,
        reason: `existed at the base and has no new or changed test: nothing is shown red (${tests.length} unchanged test(s))`,
      });
    }
    if (declarable !== null && required === 0) {
      problems.push({
        file,
        test: null,
        reason: `existed at the base and every test is declared exempt: nothing is shown red (${tests.length} test(s); evidence-check wants a red test of every expected file)`,
      });
    }
  }
  if (baselines !== undefined) {
    for (const d of declared) {
      if (!declaredSeen.has(d)) {
        notes.push(
          `declared exemption of ${d.file} > ${d.test}: ${d.file} is not an expected rule-test file (ignored)`,
        );
      }
    }
  }
  return {
    ok: problems.length === 0,
    red,
    problems,
    notes,
    ...(baselines === undefined ? {} : { exempt }),
  };
}
