// Unit tests of the red check (规划/11 §2.3 step 3; ops/approvals.yaml id 19; Codex review
// CR-10, CR-11 of 2026-10-05).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { Change } from '../../lib/git.ts';
import {
  type BaselineReader,
  type RenamedOnly,
  applyExpectedValues,
  applyRenames,
  browserCauseVerdict,
  causeVerdict,
  checkRedReports,
  expectedRuleTests,
  expectedValuesHit,
  modifiedOnlyFiles,
  modifiedOnlyNote,
  redCheckRequired,
  renamedOnlyFiles,
  renamedOnlyNote,
  ruleTestBaselines,
  scriptFaultConsoleError,
  unusedExpectedValueNotes,
  unusedOutsideNotes,
  outsideOnlyFiles,
  outsideOnlyNote,
  smokeCauseVerdict,
  smokeDiagnosticsOf,
  smokeDiagnosticsVerdict,
  wrongRedReason,
} from './red-check.ts';

const ROOT = '/work/repo';

type T = [string, string, string?];
function report(files: Array<{ name: string; message?: string; tests: T[] }>) {
  return {
    testResults: files.map((f) => ({
      name: `${ROOT}/${f.name}`,
      status: 'failed',
      message: f.message ?? '',
      assertionResults: f.tests.map(([title, status, message]) => ({
        fullName: title,
        title,
        status,
        failureMessages: message === undefined ? [] : [message],
      })),
    })),
  };
}

it('[ops/approvals.yaml id 19] applies to every task with a rule-test author, RV0 / RV1 included', () => {
  expect(redCheckRequired({ tester: 'codex' })).toBe(true);
  expect(redCheckRequired({ tester: 'claude' })).toBe(true);
  expect(redCheckRequired({ tester: 'none' })).toBe(false);
});

it('[规划/11 §2.3] red for the right reason: assertion, counterexample, NotImplemented', () => {
  expect(wrongRedReason('AssertionError: expected 3 to be 4')).toBeNull();
  // A plain property failure without its cause proves nothing (CR2-03).
  expect(wrongRedReason('Property failed after 1 tests\nCounterexample: [0]')).toContain(
    'shows no underlying assertion',
  );
  expect(
    wrongRedReason(
      'Property failed after 1 tests\nCounterexample: [0]\nGot error: AssertionError: x',
    ),
  ).toBeNull();
  expect(wrongRedReason('Error: NotImplemented: splitCommission')).toBeNull();
  expect(wrongRedReason("Error: Cannot find module '../src/split.ts'")).toContain(
    'module not found',
  );
  expect(wrongRedReason("TypeError: Cannot read properties of undefined (reading 'x')")).toContain(
    'TypeError',
  );
  expect(wrongRedReason('Error: boom')).toContain('unrecognised');
});

it('[CR-11] infrastructure failures wrapped by fast-check or a hook are never a valid red', () => {
  const wrapped = (cause: string): string =>
    `Property failed after 1 tests\n{ seed: 1 }\nCounterexample: [0]\nGot error: ${cause}`;
  expect(wrongRedReason(wrapped('Error: connect ECONNREFUSED 127.0.0.1:5432'))).toContain(
    'network or database unreachable',
  );
  expect(wrongRedReason(wrapped('error: password authentication failed for user "x"'))).toContain(
    'database connection failed',
  );
  expect(wrongRedReason('Error: migration 0007_ledger.sql failed: relation exists')).toContain(
    'migration failed',
  );
  expect(wrongRedReason('Error: Hook timed out in 10000ms.')).toContain('test setup failed');
  expect(wrongRedReason('Error: health check of the mock server failed')).toContain(
    'server not up',
  );
  expect(wrongRedReason('Error: Build failed with 1 error')).toContain('build failed');
  // A counterexample whose cause is not an assertion is not counted either.
  expect(wrongRedReason(wrapped('Error: boom'))).toContain('shows no underlying assertion');
});

it('[CR-10] the expected rule-test files are the ones the task added inside its test_paths', () => {
  expect(
    expectedRuleTests(
      [
        { path: 'test/spec/money/a.test.ts', status: '?' },
        { path: 'test/spec/money/b.int.test.ts', status: 'A' },
        { path: 'test/spec/money/arb.ts', status: '?' },
        { path: 'test/spec/other/c.test.ts', status: '?' },
        { path: 'test/spec/money/gone.test.ts', status: 'D' },
      ],
      ['test/spec/money/**'],
    ),
  ).toEqual(['test/spec/money/a.test.ts', 'test/spec/money/b.int.test.ts']);
});

it('[CR-10] every expected file must have run and be red; a partial report fails', () => {
  const a = 'test/spec/money/a.test.ts';
  const b = 'test/spec/money/b.test.ts';
  const both = [a, b];
  const good = checkRedReports(
    [
      report([
        { name: a, tests: [['splits [AC-1]', 'failed', 'AssertionError: expected 1 to be 2']] },
      ]),
      report([{ name: b, tests: [['sums', 'failed', 'Error: NotImplemented']] }]),
    ],
    both,
    ROOT,
  );
  expect(good).toEqual({
    ok: true,
    red: [`${a} > splits [AC-1]`, `${b} > sums`],
    problems: [],
    notes: [],
  });

  // B never ran: the run picked A only.
  const partial = checkRedReports(
    [report([{ name: a, tests: [['splits', 'failed', 'AssertionError: x']] }])],
    both,
    ROOT,
  );
  expect(partial.ok).toBe(false);
  expect(partial.problems).toEqual([
    { file: b, test: null, reason: 'not in the report: this rule-test file did not run' },
  ]);

  const bad = checkRedReports(
    [
      report([
        {
          name: a,
          tests: [
            ['green one', 'passed'],
            ['crashes', 'failed', 'TypeError: f is not a function'],
            ['skipped', 'skipped'],
          ],
        },
        { name: b, message: "Error: Failed to resolve import '../x.ts'", tests: [] },
      ]),
    ],
    both,
    ROOT,
  );
  expect(bad.problems.map((p) => `${p.test ?? '(file)'}: ${p.reason.split(' (')[0]}`)).toEqual([
    'green one: green on the skeleton: the test has no teeth',
    'crashes: red for the wrong reason',
    'skipped: status "skipped"',
    '(file): the file did not load: red for the wrong reason',
  ]);
  // A file-level setup failure taints the tests that failed next to it.
  const tainted = checkRedReports(
    [
      report([
        {
          name: a,
          message: 'Error: connect ECONNREFUSED pg:5432',
          tests: [['t', 'failed', 'AssertionError: x']],
        },
      ]),
    ],
    [a],
    ROOT,
  );
  expect(tainted.problems[0]?.reason).toContain('network or database unreachable');
  expect(checkRedReports([report([])], [], ROOT).problems[0]?.reason).toContain(
    'added no rule-test file',
  );
  expect(checkRedReports([{ nope: true }], [a], ROOT).ok).toBe(false);
});

const FIXTURES = join(import.meta.dirname, 'red-check-fixtures');
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as unknown;
const P = 'test/spec/zzprobe/p.test.ts';
const M = 'test/spec/zzprobe2/m.test.ts';

it('[CR2-03] real red-reporter output: only assertions and NotImplemented are a valid red', () => {
  // Written by tools/ops/verify-image/red-reporter.mjs on real Vitest 5 + fast-check 4 failures
  // (paths rewritten to the container's /work/repo).
  const result = checkRedReports([fixture('red-report.json')], [P, M], ROOT);
  expect(result.red).toEqual([
    `${P} > [AC-P#2] assertion inside property`,
    `${P} > [AC-P#5] NotImplemented inside property`,
    `${P} > [AC-P#6] plain assertion`,
  ]);
  expect(result.problems.map((p) => `${p.test ?? p.file}: ${p.reason.split(' (')[0]}`)).toEqual([
    '[AC-P#1] typeerror inside property: red for the wrong reason',
    '[AC-P#3] property returns false: red for an unrecognised reason',
    '[AC-P#4] database refused inside property: red for the wrong reason',
    '[AC-P#7] skipped: status "skipped"',
    `${M}: the file did not load: red for the wrong reason`,
  ]);
  expect(result.problems[0]?.reason).toContain('TypeError');
  expect(result.problems[1]?.reason).toContain('property returned false');
  expect(result.problems[2]?.reason).toContain('network or database unreachable');
});

it('[CR2-03] real Vitest JSON output (no causes): every property failure is refused', () => {
  const result = checkRedReports([fixture('json-report.json')], [P], ROOT);
  const property = result.problems.filter((p) =>
    p.reason.includes('shows no underlying assertion'),
  );
  // P#1..P#5 are properties: Vitest's JSON reporter drops the cause, so none of them counts.
  expect(property.map((p) => p.test)).toEqual([
    '[AC-P#1] typeerror inside property',
    '[AC-P#2] assertion inside property',
    '[AC-P#3] property returns false',
    '[AC-P#4] database refused inside property',
    '[AC-P#5] NotImplemented inside property',
  ]);
  expect(result.red).toEqual([`${P} > [AC-P#6] plain assertion`]);
});

it('[CR2-03] cause chains: the innermost cause decides; nothing known means refused', () => {
  expect(causeVerdict([])).toContain('no failure detail');
  expect(
    causeVerdict([
      { name: 'Error', message: 'Property failed after 1 tests' },
      { name: 'AssertionError', message: 'expected ECONNREFUSED to be 1' },
    ]),
  ).toBeNull();
  expect(causeVerdict([{ name: 'Error', message: 'boom' }])).toContain(
    'not an assertion or NotImplemented',
  );
  expect(
    checkRedReports(
      [
        {
          testResults: [
            {
              name: `${ROOT}/${P}`,
              assertionResults: [
                { title: 't', status: 'failed', failureMessages: ['x'], failures: [] },
              ],
            },
          ],
        },
      ],
      [P],
      ROOT,
    ).problems[0]?.reason,
  ).toContain('no failure detail');
  expect(
    checkRedReports(
      [
        {
          testResults: [],
          unhandledErrors: [{ causes: [{ name: 'Error', message: 'connect ECONNREFUSED' }] }],
        },
      ],
      [],
      ROOT,
    ).problems.map((p) => p.reason),
  ).toContain(
    'the run had unhandled errors: red for the wrong reason (network or database unreachable)',
  );
});

const B = 'test/spec/zzbrowser/b.browser.test.ts';
const LAUNCH = 'test/spec/zzbrowser/launch.browser.test.ts';
const WAIT = { name: 'Error', message: 'Matcher did not succeed in time.' };
const UNRECOGNISED = 'red for an unrecognised reason (Error: not an assertion or NotImplemented)';
const POLL = 'test/spec/zzbrowser/poll.browser.test.ts';
const POLL_REFUSED =
  'red for an unrecognised reason (an expect.poll timed out and nothing shows it waited for an ' +
  'element: wait with expect.element in the test file itself, never expect.poll)';

it('[F1-01j] browser rule tests: an assertion, or an element waited for that never came, is a valid red', () => {
  // Shapes of vitest 5.0.1 / @vitest/browser 5.0.1 / playwright-core 1.63.0 failures in the form
  // the red reporter writes; where each one comes from is noted in the fixture ("//").
  const result = checkRedReports([fixture('browser-report.json')], [B, LAUNCH, POLL], ROOT);
  expect(result.red).toEqual([
    `${B} > [AC-B#1] element never appears: locator error`,
    `${B} > [AC-B#2] element never appears: lookup still waiting`,
    `${B} > [AC-B#3] expect.element matcher fails`,
    `${B} > [AC-B#4] expect.poll assertion fails`,
    `${B} > [AC-B#5] plain assertion`,
    `${B} > [AC-B#6] matcher without a wait`,
    `${B} > [AC-B#16] lookup still waiting, site as the browser URL`,
  ]);
  expect(result.problems.map((p) => `${p.test ?? p.file}: ${p.reason}`)).toEqual([
    '[AC-B#7] TypeError inside the wait: red for the wrong reason (TypeError)',
    `[AC-B#8] several elements (strict mode): ${UNRECOGNISED}`,
    '[AC-B#9] element lookup outside a wait: red for an unrecognised reason ' +
      '(VitestBrowserElementError: not an assertion or NotImplemented)',
    `[AC-B#10] the polled assertion hangs: ${UNRECOGNISED}`,
    '[AC-B#11] test timed out: red for the wrong reason (timed out)',
    `[AC-B#12] page error inside the wait: ${UNRECOGNISED}`,
    '[AC-B#13] skipped: status "skipped" (skipped, todo or pending is not red)',
    // The poll's own timeout counts only for a wait started in the test file (B#2, B#16) of a
    // file that never mentions poll: not from a helper, not without a stack frame, not in a file
    // that uses expect.poll (a hung expect.poll looks exactly like this).
    `[AC-B#14] lookup still waiting, wait started in a helper: ${POLL_REFUSED}`,
    `[AC-B#15] lookup still waiting, no stack frame: ${POLL_REFUSED}`,
    `${LAUNCH}: the file did not load: red for the wrong reason (browser not running)`,
    `[AC-P#1] hung expect.poll: ${POLL_REFUSED}`,
  ]);
});

it('[F1-01j] the browser reading applies only to browser files the red reporter saw run in a browser', () => {
  const report = fixture('browser-report.json') as {
    testResults: Array<{ name: string; browser?: boolean }>;
  };
  // Not marked as run in a browser (a node project, or Vitest's own JSON report): the innermost
  // cause decides, as for every other rule test, so only the bare assertion is red.
  const unmarked = {
    ...report,
    testResults: report.testResults.map((entry) => ({ ...entry, browser: false })),
  };
  const plain = checkRedReports([unmarked], [B, LAUNCH], ROOT);
  expect(plain.red).toEqual([`${B} > [AC-B#5] plain assertion`]);
  const waited = [
    '[AC-B#1] element never appears: locator error',
    '[AC-B#4] expect.poll assertion fails',
  ];
  for (const title of waited) {
    expect(plain.problems.find((p) => p.test === title)?.reason).toBe(UNRECOGNISED);
  }
  // A file that is not a browser test file never gets it, marked or not.
  const nodeFile = B.replace('.browser.test.ts', '.test.ts');
  const renamed = {
    ...report,
    testResults: report.testResults.map((entry) => ({
      ...entry,
      name: entry.name.replace('.browser.test.ts', '.test.ts'),
    })),
  };
  const notBrowser = checkRedReports([renamed], [nodeFile], ROOT);
  expect(notBrowser.red).toEqual([`${nodeFile} > [AC-B#5] plain assertion`]);
});

it('[F1-01j] browserCauseVerdict looks through the wait only, at an assertion or a missing element', () => {
  const notFound = {
    name: 'VitestBrowserElementError',
    message: "Cannot find element with locator: getByText('x')",
  };
  const stillWaiting = { name: 'Error', message: "expect.poll() function didn't resolve in time." };
  expect(browserCauseVerdict([notFound, WAIT])).toBeNull();
  // The poll's own timeout: only for a wait that can only have been expect.element.
  expect(browserCauseVerdict([stillWaiting, WAIT], { elementOnly: true })).toBeNull();
  expect(browserCauseVerdict([stillWaiting, WAIT], { elementOnly: false })).toBe(POLL_REFUSED);
  expect(browserCauseVerdict([stillWaiting, WAIT])).toBe(POLL_REFUSED);
  const assertion = { name: 'AssertionError', message: 'expected 1 to be 2' };
  expect(browserCauseVerdict([assertion, WAIT])).toBeNull();
  const matcher = { name: 'Error', message: 'x', matcher: 'toBeVisible' };
  expect(browserCauseVerdict([matcher, WAIT])).toBeNull();
  // An outer wrapper does not change what the wait wrapped.
  const property = { name: 'Error', message: 'Property failed after 1 tests' };
  expect(browserCauseVerdict([property, notFound, WAIT])).toBeNull();
  // The wait alone, a wrapped TypeError, a locator message under another error name.
  expect(browserCauseVerdict([WAIT])).toBe(UNRECOGNISED);
  const typeError = { name: 'TypeError', message: 'Failed to fetch' };
  expect(browserCauseVerdict([typeError, WAIT])).toBe('red for the wrong reason (TypeError)');
  const renamed = { name: 'Error', message: notFound.message };
  expect(browserCauseVerdict([renamed, WAIT])).toBe(UNRECOGNISED);
  expect(browserCauseVerdict([])).toContain('no failure detail');
  // Outside the browser reading nothing changes: the wait's own cause is not an assertion.
  expect(causeVerdict([notFound, WAIT])).toBe(UNRECOGNISED);
  // .tsx rule tests (browser component tests) are expected like .ts ones.
  const tsx = 'test/spec/frontend/card.browser.test.tsx';
  expect(expectedRuleTests([{ path: tsx, status: 'A' }], ['test/spec/**'])).toEqual([tsx]);
  // A browser that could not start or went away: never a valid red, wherever it shows up.
  const closed = { name: 'Error', message: 'Target page, context or browser has been closed' };
  const notRunning = 'red for the wrong reason (browser not running)';
  expect(causeVerdict([closed])).toBe(notRunning);
  expect(browserCauseVerdict([closed, WAIT])).toBe(notRunning);
});

const DEMO = 'test/spec/frontend/browser-env/demo-red.browser.test.ts';

it('[F1-01j] real browser red runs: a missing element and an assertion are red, a TypeError is not', () => {
  // F1-01j red/1 and red/2 on the candidate copy (2026-10-06), see the fixtures' "//".
  const valid = checkRedReports([fixture('browser-red-1.json')], [DEMO], ROOT);
  expect(valid).toEqual({
    ok: true,
    red: [
      `${DEMO} > [demo] waits for an element that never appears`,
      `${DEMO} > [demo] plain assertion fails`,
    ],
    problems: [],
    notes: [],
  });
  const typeError = checkRedReports([fixture('browser-red-2.json')], [DEMO], ROOT);
  expect(typeError.ok).toBe(false);
  expect(typeError.problems).toEqual([
    {
      file: DEMO,
      test: '[demo] fails with a TypeError',
      reason: 'red for the wrong reason (TypeError)',
    },
  ]);
});

it('[F1-01j] the poll timeout of the real run counts only with the test file as its site', () => {
  type Entry = {
    poll_in_source: boolean;
    assertionResults: Array<{ failures: Array<{ causes: unknown; site: unknown }> }>;
  };
  // The real missing-element test, as if the poll timer had won the race (the other shape
  // expect.element ends in), with the site the current reporter would record.
  function variant(site: unknown, pollInSource = false): unknown {
    const report = fixture('browser-red-1.json') as { testResults: Entry[] };
    const entry = report.testResults[0];
    const failure = entry?.assertionResults[0]?.failures[0];
    if (entry === undefined || failure === undefined) throw new Error('fixture changed');
    entry.poll_in_source = pollInSource;
    failure.causes = [
      { name: 'Error', message: "expect.poll() function didn't resolve in time." },
      WAIT,
    ];
    failure.site = site;
    return report;
  }
  const missing = `${DEMO} > [demo] waits for an element that never appears`;
  const abs = `${ROOT}/${DEMO}`;
  // The test-file frame of the real stack: normalised by the reporter, or still as the browser URL.
  for (const file of [abs, `http://localhost:63315${abs}?import&browserv=1791261813481`]) {
    const result = checkRedReports([variant({ file, line: 8, column: 68 })], [DEMO], ROOT);
    expect(result.red, file).toContain(missing);
  }
  // What the round-2 reporter recorded (Vite's pre-bundled poll frame), no site, or a file that
  // uses expect.poll: refused.
  const deps =
    '/work/repo/test/node_modules/.vite/vitest/da39a3ee5e6b4b0d3255bfef95601890afd80709/deps/' +
    'index.m3L2HgmY-ClFbRdXj.js?v=b6c384b3';
  for (const report of [
    variant({ file: deps, line: 5767, column: 47 }),
    variant(null),
    variant({ file: abs, line: 8, column: 68 }, true),
  ]) {
    const result = checkRedReports([report], [DEMO], ROOT);
    expect(result.red).not.toContain(missing);
    expect(result.problems.map((p) => p.reason)).toEqual([POLL_REFUSED]);
  }
});

const SMOKE = 'test/spec/frontend/build-smoke/entries.smoke.test.ts';

it('[F1-01k] build smoke rule tests: an assertion, or a locator.waitFor that ran out, is a valid red', () => {
  const result = checkRedReports([fixture('smoke-report.json')], [SMOKE], ROOT);
  expect(result.ok).toBe(false);
  // The wait counts: the page's only error is the skeleton's NotImplemented, and its failed
  // requests are the ones the test blocked itself (the admin permission endpoint, another host).
  // The skeleton's NotImplemented caught by React Router's errorElement (a console.error only)
  // still counts (orchestrator's ruling on S1 ①).
  expect(result.red).toEqual([
    `${SMOKE} > [demo] element never came`,
    `${SMOKE} > [demo] assertion`,
    `${SMOKE} > [demo] skeleton caught by errorElement`,
  ]);
  expect(result.problems.map((p) => [p.test, p.reason])).toEqual([
    [
      '[demo] page threw',
      "red for the wrong reason (the page threw: TypeError: Cannot read properties of undefined (reading 'routes'))",
    ],
    // A render error React Router's errorElement caught fires no pageerror (Codex r3, S1 ②).
    [
      '[demo] render error caught by errorElement',
      "red for the wrong reason (the page logged a script error: React Router caught the following error during render TypeError: Cannot read properties of undefined (reading 'map'))",
    ],
    [
      '[demo] chunk did not load',
      'red for the wrong reason (a request of the entry failed: http://127.0.0.1:40125/assets/page-D5e6.js: net::ERR_FAILED)',
    ],
    ['[demo] goto timed out', 'red for the wrong reason (page did not load (page.goto failed))'],
    ['[demo] connection refused', 'red for the wrong reason (page did not load (net::ERR_*))'],
    ['[demo] no browser', 'red for the wrong reason (browser not running)'],
    [
      '[demo] screenshot timed out',
      'red for the wrong reason (a Playwright timeout outside locator.waitFor: page.screenshot: Timeout 10000ms exceeded.)',
    ],
    ['[demo] test code threw', 'red for the wrong reason (TypeError)'],
  ]);
  // The size budget opens no page: no diagnostics, judged by the assertion alone, and said so.
  expect(result.notes).toEqual([
    `${SMOKE} > [demo] assertion: no browser diagnostics in the report, judged by the failure alone`,
  ]);
});

it('[F1-01k] smokeDiagnosticsVerdict: page errors, own failed requests and failed imports refuse a red', () => {
  const url = 'http://127.0.0.1:40123/';
  const v = (diagnostics: { kind: string; message: string }[]): string | null =>
    smokeDiagnosticsVerdict({ url, diagnostics });
  expect(v([])).toBeNull();
  expect(v([{ kind: 'pageerror', message: 'Error: NotImplemented: page\n    at x' }])).toBeNull();
  expect(v([{ kind: 'pageerror', message: 'ReferenceError: x is not defined' }])).toMatch(
    /the page threw: ReferenceError/,
  );
  // NotImplemented further down a stack does not excuse another error.
  expect(
    v([{ kind: 'pageerror', message: 'TypeError: boom\n    at NotImplemented (x.js:1:1)' }]),
  ).toMatch(/the page threw: TypeError: boom/);
  // Another host's failure is not the entry's; the entry's own is, unless the test blocked it.
  expect(v([{ kind: 'requestfailed', message: 'https://cdn.invalid/a.js: net::ERR_FAILED' }])).toBe(
    null,
  );
  expect(
    v([{ kind: 'requestfailed', message: 'http://127.0.0.1:40123/assets/a.js: net::ERR_FAILED' }]),
  ).toMatch(/a request of the entry failed/);
  expect(
    v([
      { kind: 'blocked-request', message: 'http://127.0.0.1:40123/v1/config' },
      {
        kind: 'requestfailed',
        message: 'http://127.0.0.1:40123/v1/config: net::ERR_BLOCKED_BY_CLIENT',
      },
    ]),
  ).toBeNull();
  // A URL that cannot be read counts as the entry's own (fail closed).
  expect(v([{ kind: 'requestfailed', message: 'not a url' }])).toMatch(/request of the entry/);
  expect(
    smokeDiagnosticsVerdict({
      url: '',
      diagnostics: [
        { kind: 'requestfailed', message: 'https://cdn.invalid/a.js: net::ERR_FAILED' },
      ],
    }),
  ).toMatch(/request of the entry/);
  expect(
    v([
      {
        kind: 'console.error',
        message:
          'TypeError: Failed to fetch dynamically imported module: http://127.0.0.1:40123/assets/p.js',
      },
    ]),
  ).toMatch(/a module of the page did not load/);
  // Only a first line that starts with NotImplemented (or Error: NotImplemented) is the
  // skeleton's; other kinds mentioning it are checked first and refused (Claude review r2, S2).
  expect(v([{ kind: 'pageerror', message: 'NotImplemented: AdminShell\n    at x' }])).toBeNull();
  for (const message of [
    'TypeError: NotImplemented is not a constructor',
    'ReferenceError: NotImplemented is not defined',
    'Error: x failed (NotImplemented)',
    'Uncaught NotImplemented',
    'Error: NotImplementedYet TypeError: y',
  ]) {
    expect(v([{ kind: 'pageerror', message }]), message).toMatch(/the page threw/);
  }
  // Other console errors stay attachments.
  expect(v([{ kind: 'console.error', message: 'Warning: something' }])).toBeNull();
  expect(
    v([{ kind: 'console.error', message: 'Failed to load resource: net::ERR_BLOCKED_BY_CLIENT' }]),
  ).toBeNull();
  expect(v([{ kind: 'blocked-websocket', message: 'ws://127.0.0.1:40123/' }])).toBeNull();
});

it('[F1-01k] a script error the page only logged refuses a red; the skeleton NotImplemented does not (Codex r3, S1 ②)', () => {
  const url = 'http://127.0.0.1:40123/';
  const v = (message: string): string | null =>
    smokeDiagnosticsVerdict({ url, diagnostics: [{ kind: 'console.error', message }] });
  const stack = '\n    at Xe (http://127.0.0.1:40123/assets/index-E7f8.js:9:1234)';
  const RR = 'React Router caught the following error during render ';
  // React Router's errorElement: whatever it caught, unless it is the skeleton's NotImplemented.
  for (const error of [
    "TypeError: Cannot read properties of undefined (reading 'map')",
    'ReferenceError: t is not defined',
    'RangeError: Invalid time value',
    'Error: boom',
    'Invariant failed',
  ]) {
    expect(v(`${RR}${error}${stack}`), error).toBe(
      `red for the wrong reason (the page logged a script error: ${RR}${error})`,
    );
  }
  // <Await>'s boundary logs the same way.
  expect(v(`<Await> caught the following error during render TypeError: x${stack}`)).toMatch(
    /logged a script error: <Await> caught/,
  );
  // Error kinds of a script fault, also without React Router (React's own caught-error log).
  for (const message of [
    `TypeError: Cannot read properties of null (reading 'x')${stack}`,
    'Uncaught SyntaxError: Unexpected identifier',
    'RangeError: Maximum call stack size exceeded',
    'URIError: URI malformed',
    'EvalError: x',
    `Error: wrapped${stack}\nCaused by: ReferenceError: y is not defined`,
  ]) {
    expect(v(message), message).toMatch(/the page logged a script error/);
  }
  // The skeleton's NotImplemented (first line of the error) stays a valid red, caught or not.
  for (const message of [
    `${RR}Error: NotImplemented: AppShell${stack}`,
    `${RR}NotImplemented: AppShell${stack}`,
    `Error: NotImplemented: AppShell${stack}`,
  ]) {
    expect(v(message), message).toBeNull();
  }
  // … but not another kind that mentions it.
  for (const message of [
    `${RR}TypeError: NotImplemented is not a constructor${stack}`,
    `${RR}ReferenceError: NotImplemented is not defined`,
    `${RR}Error: failed (NotImplemented)`,
  ]) {
    expect(v(message), message).toMatch(/the page logged a script error/);
  }
  expect(scriptFaultConsoleError(`${RR}Error: NotImplemented: x`, true)).toBe(false);
  expect(scriptFaultConsoleError(`${RR}Error: NotImplemented: x`, false)).toBe(true);
  expect(scriptFaultConsoleError('Warning: something', false)).toBe(false);
});

it('[F1-01k] a locator.waitFor timeout without browser diagnostics is not a valid red', () => {
  type Entry = { assertionResults: { fullName: string; annotations?: unknown[] }[] };
  const report = fixture('smoke-report.json') as { testResults: Entry[] };
  const waited = report.testResults[0]!.assertionResults.find(
    (t) => t.fullName === '[demo] element never came',
  )!;
  // Only the screenshot is left: the page events are unknown, the page may have thrown.
  waited.annotations = waited.annotations!.slice(0, 1);
  const result = checkRedReports([report], [SMOKE], ROOT);
  expect(result.red).toEqual([
    `${SMOKE} > [demo] assertion`,
    `${SMOKE} > [demo] skeleton caught by errorElement`,
  ]);
  expect(result.problems[0]).toEqual({
    file: SMOKE,
    test: '[demo] element never came',
    reason:
      'red for an unproven reason (locator.waitFor ran out but the test wrote no browser diagnostics annotation)',
  });
  expect(result.notes).toEqual([
    `${SMOKE} > [demo] element never came: locator.waitFor timeout without browser diagnostics, judged invalid`,
    `${SMOKE} > [demo] assertion: no browser diagnostics in the report, judged by the failure alone`,
  ]);
});

it('[F1-01k] smokeDiagnosticsOf reads only diagnostics attachments of the red reporter', () => {
  expect(smokeDiagnosticsOf(undefined)).toEqual([]);
  expect(
    smokeDiagnosticsOf([
      { message: 'x 首屏截图', type: 'notice', path: '/a.png' },
      { message: 'other', type: 'notice', json: { hello: 1 } },
      null,
      {
        message: 'x 浏览器诊断（不作为断言）',
        type: 'notice',
        json: { entry: 'x', url: 'http://127.0.0.1:1/', diagnostics: [{ kind: 'pageerror' }, 3] },
      },
    ]),
  ).toEqual([
    {
      url: 'http://127.0.0.1:1/',
      diagnostics: [
        { kind: 'pageerror', message: '' },
        { kind: '', message: '' },
      ],
    },
  ]);
});

it('[F1-01k] the locator.waitFor reading applies only to smoke files run in Node, from the red reporter', () => {
  type Entry = { name: string; browser: boolean; assertionResults: { failures?: unknown }[] };
  const load = (): { testResults: Entry[] } =>
    fixture('smoke-report.json') as { testResults: Entry[] };
  const waited = (r: ReturnType<typeof checkRedReports>): boolean =>
    r.red.some((x) => x.endsWith('[demo] element never came'));
  // The same file name outside the smoke pattern: an ordinary unit test, the timeout is refused.
  const renamed = load();
  const other = 'test/spec/frontend/build-smoke/entries.test.ts';
  renamed.testResults[0]!.name = `${ROOT}/${other}`;
  expect(waited(checkRedReports([renamed], [other], ROOT))).toBe(false);
  // A smoke-named file outside test/spec/ is not a rule test of the build-smoke project.
  for (const elsewhere of [
    'packages/testing/src/entries.smoke.test.ts',
    'test/acceptance/entries.smoke.test.ts',
  ]) {
    const moved = load();
    moved.testResults[0]!.name = `${ROOT}/${elsewhere}`;
    expect(waited(checkRedReports([moved], [elsewhere], ROOT))).toBe(false);
  }
  // A smoke-named file that ran in a browser is not a build smoke test.
  const inBrowser = load();
  inBrowser.testResults[0]!.browser = true;
  expect(waited(checkRedReports([inBrowser], [SMOKE], ROOT))).toBe(false);
  // Vitest's own JSON report (messages only, no causes): refused.
  const plain = load();
  for (const t of plain.testResults[0]!.assertionResults) delete t.failures;
  expect(waited(checkRedReports([plain], [SMOKE], ROOT))).toBe(false);
  // A globalSetup that failed runs no test: the file is not in the report.
  expect(checkRedReports([{ testResults: [] }], [SMOKE], ROOT).problems).toEqual([
    { file: SMOKE, test: null, reason: 'not in the report: this rule-test file did not run' },
  ]);
});

it('[F1-01k] smokeCauseVerdict: only the bare locator.waitFor TimeoutError and assertions count', () => {
  const wait = 'locator.waitFor: Timeout 10000ms exceeded.\nCall log:\n  - waiting for x';
  expect(smokeCauseVerdict([{ name: 'TimeoutError', message: wait }])).toBeNull();
  expect(smokeCauseVerdict([{ name: 'AssertionError', message: 'expected 1 to be 2' }])).toBeNull();
  // Wrapped, or named otherwise, it is not the wait of the test.
  expect(
    smokeCauseVerdict([
      { name: 'Error', message: 'wrapper' },
      { name: 'TimeoutError', message: wait },
    ]),
  ).not.toBeNull();
  expect(smokeCauseVerdict([{ name: 'Error', message: wait }])).not.toBeNull();
  expect(
    smokeCauseVerdict([
      { name: 'TimeoutError', message: 'locator.click: Timeout 5000ms exceeded.' },
    ]),
  ).toMatch(/outside locator\.waitFor/);
  // A failed globalSetup reported as an error outside the tests.
  expect(
    smokeCauseVerdict([
      { name: 'Error', message: 'build smoke: the admin build (vite build) exited 1' },
    ]),
  ).toMatch(/unrecognised/);
  expect(smokeCauseVerdict([])).toMatch(/unknown reason/);
});

const ROUTE_ERROR = 'the route error page (RetryPage "页面加载失败，请重试") is showing at /rules';

it('[F1-01m] what the page swallowed refuses a wait that ran out; the skeleton NotImplemented does not', () => {
  const result = checkRedReports([fixture('smoke-swallowed-report.json')], [SMOKE], ROOT);
  expect(result.ok).toBe(false);
  // The skeleton's NotImplemented explains the route error page: the wait still counts.
  expect(result.red).toEqual([
    `${SMOKE} > [demo] skeleton lazy module`,
    `${SMOKE} > [demo] skeleton render caught by errorElement`,
  ]);
  expect(result.problems.map((p) => [p.test, p.reason])).toEqual([
    // A lazy chunk served 200 whose module throws while initialising (Codex money r4 S1 on
    // F1-01k): no console.error, no pageerror, only vite:preloadError and the retry page.
    [
      '[demo] lazy module threw while initialising',
      "red for the wrong reason (a lazy module of the page failed: TypeError: Cannot read properties of undefined (reading 'x'))",
    ],
    [
      '[demo] route error page only',
      `red for the wrong reason (the page showed its route error page: ${ROUTE_ERROR})`,
    ],
    [
      '[demo] unhandled rejection',
      'red for the wrong reason (the page left a rejection unhandled: Error: boom)',
    ],
    [
      '[demo] page could not be read',
      'red for an unproven reason (the page events are not fully known: the page could not be read: reading the page timed out (5000ms))',
    ],
  ]);
  expect(result.notes).toEqual([]);
});

it('[F1-01m] smokeDiagnosticsVerdict: preload errors, unhandled rejections, the route error page, unreadable pages', () => {
  const url = 'http://127.0.0.1:40123/';
  const v = (diagnostics: { kind: string; message: string }[]): string | null =>
    smokeDiagnosticsVerdict({ url, diagnostics });
  const stack = `\n    at ${url}assets/page-D5e6.js:1:88`;
  for (const kind of ['preload-error', 'unhandled-rejection']) {
    // Only a first line that starts with NotImplemented (or Error: NotImplemented) is excused.
    expect(v([{ kind, message: `Error: NotImplemented: RulesPage${stack}` }]), kind).toBeNull();
    expect(v([{ kind, message: `NotImplemented: RulesPage${stack}` }]), kind).toBeNull();
    for (const message of [
      `TypeError: Failed to fetch dynamically imported module: ${url}assets/page-D5e6.js`,
      `TypeError: NotImplemented is not a constructor${stack}`,
      'Error: Unable to preload CSS for /assets/page-D5e6.css',
      'undefined',
    ]) {
      expect(v([{ kind, message }]), `${kind}: ${message}`).toMatch(/^red for the wrong reason/);
    }
  }
  // The route error page alone, or beside a NotImplemented that is not the skeleton's.
  expect(v([{ kind: 'route-error', message: ROUTE_ERROR }])).toBe(
    `red for the wrong reason (the page showed its route error page: ${ROUTE_ERROR})`,
  );
  expect(
    v([
      { kind: 'pageerror', message: 'Error: x failed (NotImplemented)' },
      { kind: 'route-error', message: ROUTE_ERROR },
    ]),
  ).toMatch(/the page threw/);
  expect(
    v([
      { kind: 'console.error', message: 'Warning: NotImplemented: x' },
      { kind: 'route-error', message: ROUTE_ERROR },
    ]),
  ).toMatch(/route error page/);
  // … excused by the skeleton's NotImplemented in any of the kinds that carry an error.
  for (const skeleton of [
    { kind: 'pageerror', message: 'Error: NotImplemented: AppShell' },
    { kind: 'preload-error', message: 'NotImplemented: RulesPage' },
    { kind: 'unhandled-rejection', message: 'Error: NotImplemented: load' },
    {
      kind: 'console.error',
      message: `React Router caught the following error during render Error: NotImplemented: AppShell${stack}`,
    },
  ]) {
    expect(v([skeleton, { kind: 'route-error', message: ROUTE_ERROR }]), skeleton.kind).toBeNull();
  }
  // Unreadable page events: never a proven red.
  expect(v([{ kind: 'diagnostics-incomplete', message: 'the page could not be read: x' }])).toBe(
    'red for an unproven reason (the page events are not fully known: the page could not be read: x)',
  );
});

// CT-06p: files that existed at the base need only their new and changed tests red.
const BASE_FILE = 'test/spec/notify/send-log.int.test.ts';
const VITEST = "import { expect, it } from 'vitest';";
const spec = (title: string, body = 'expect(1).toBe(1);'): string =>
  `it('${title}', async () => {\n  ${body}\n});`;
const file = (...tests: string[]): string => `${[VITEST, ...tests].join('\n\n')}\n`;
const BASE_SOURCE = file(spec('[AC-1] a'), spec('[AC-2] b'), spec('[AC-3] c'), spec('[AC-4] d'));
/** Tests 1 and 4 changed, test 5 is new (the B1-12f shape plus a new test). */
const HEAD_SOURCE = file(
  spec('[AC-1] a', "expect(await columns()).toEqual(['app_id', 'variant']);"),
  spec('[AC-2] b'),
  spec('[AC-3] c'),
  spec('[AC-4] d', "expect(await primaryKey()).toEqual(['app_id', 'code', 'variant']);"),
  spec('[AC-5] e'),
);

type RedTest = [name: string, status: string, cause?: string];
/** A report as the red reporter writes it (reporter name, failure causes). */
function redReport(name: string, tests: RedTest[], reporter = 'couli-red-reporter') {
  const causesOf = (cause: string) => {
    const at = cause.indexOf(': ');
    return [{ name: cause.slice(0, at), message: cause.slice(at + 2) }];
  };
  return {
    reporter,
    testResults: [
      {
        name: `${ROOT}/${name}`,
        status: 'failed',
        message: '',
        failures: [],
        assertionResults: tests.map(([fullName, status, cause]) => ({
          fullName,
          title: fullName,
          status,
          failureMessages: cause === undefined ? [] : [cause],
          failures: cause === undefined ? [] : [{ causes: causesOf(cause) }],
        })),
      },
    ],
  };
}

function reader(base: Record<string, string>, head: Record<string, string>): BaselineReader {
  return { base: (p) => base[p] ?? null, head: (p) => head[p] ?? null };
}

const baselinesOf = (
  head: string,
  changes: Change[] = [{ path: BASE_FILE, status: 'M' }],
  extra: Record<string, string> = {},
) =>
  ruleTestBaselines(
    [BASE_FILE],
    changes,
    ['test/spec/notify/**'],
    reader({ [BASE_FILE]: BASE_SOURCE }, { [BASE_FILE]: head, ...extra }),
  );

it('[CT-06p] a file that existed at the base: only new and changed tests must be red, unchanged ones are listed', () => {
  const result = checkRedReports(
    [
      redReport(BASE_FILE, [
        ['[AC-1] a', 'failed', 'AssertionError: expected [ …(2) ] to deeply equal [ …(3) ]'],
        ['[AC-2] b', 'passed'],
        ['[AC-3] c', 'failed', 'Error: NotImplemented: columns'],
        ['[AC-4] d', 'failed', 'AssertionError: expected [ …(2) ] to deeply equal [ …(3) ]'],
        ['[AC-5] e', 'failed', 'Error: NotImplemented: insert'],
      ]),
    ],
    [BASE_FILE],
    ROOT,
    baselinesOf(HEAD_SOURCE),
  );
  expect(result).toEqual({
    ok: true,
    red: [
      `${BASE_FILE} > [AC-1] a`,
      `${BASE_FILE} > [AC-3] c`,
      `${BASE_FILE} > [AC-4] d`,
      `${BASE_FILE} > [AC-5] e`,
    ],
    problems: [],
    exempt: [
      { file: BASE_FILE, test: '[AC-2] b', status: 'passed' },
      { file: BASE_FILE, test: '[AC-3] c', status: 'failed' },
    ],
    notes: [
      `${BASE_FILE} > [AC-2] b: unchanged since the base, exempt from the red rule (green)`,
      `${BASE_FILE} > [AC-3] c: unchanged since the base, exempt from the red rule (red for a valid reason)`,
    ],
  });
});

it('[CT-06p] an unchanged test that is red still needs a valid reason; skipped stays refused; a changed green test has no teeth', () => {
  const result = checkRedReports(
    [
      redReport(BASE_FILE, [
        ['[AC-1] a', 'passed'],
        ['[AC-2] b', 'failed', 'TypeError: columns is not a function'],
        ['[AC-3] c', 'skipped'],
        ['[AC-4] d', 'failed', 'AssertionError: x'],
        ['[AC-5] e', 'passed'],
      ]),
    ],
    [BASE_FILE],
    ROOT,
    baselinesOf(HEAD_SOURCE),
  );
  expect(result.ok).toBe(false);
  expect(result.problems.map((p) => `${p.test}: ${p.reason}`)).toEqual([
    '[AC-1] a: green on the skeleton: the test has no teeth (new or changed since the base)',
    '[AC-2] b: red for the wrong reason (TypeError)',
    '[AC-3] c: status "skipped" (skipped, todo or pending is not red)',
    '[AC-5] e: green on the skeleton: the test has no teeth (new or changed since the base)',
  ]);
  expect(result.exempt).toEqual([]);
});

it('[CT-06p] a file that existed at the base and has no new or changed test fails: nothing is shown red', () => {
  const comments = BASE_SOURCE.replace('expect(1)', '// only a comment\n  expect(1)');
  const result = checkRedReports(
    [
      redReport(BASE_FILE, [
        ['[AC-1] a', 'passed'],
        ['[AC-2] b', 'passed'],
        ['[AC-3] c', 'passed'],
        ['[AC-4] d', 'passed'],
      ]),
    ],
    [BASE_FILE],
    ROOT,
    baselinesOf(comments),
  );
  expect(result.ok).toBe(false);
  expect(result.problems).toEqual([
    {
      file: BASE_FILE,
      test: null,
      reason:
        'existed at the base and has no new or changed test: nothing is shown red (4 unchanged test(s))',
    },
  ]);
  expect(result.exempt).toHaveLength(4);
});

it('[CT-06p] judged as a whole, as before: shared code changed, a support file it may read, not the red reporter', () => {
  const tests: RedTest[] = [
    ['[AC-1] a', 'failed', 'AssertionError: x'],
    ['[AC-2] b', 'passed'],
    ['[AC-3] c', 'passed'],
    ['[AC-4] d', 'failed', 'AssertionError: x'],
    ['[AC-5] e', 'failed', 'Error: NotImplemented: x'],
  ];
  const greenOnes = (r: ReturnType<typeof checkRedReports>) =>
    r.problems.map((p) => `${p.test}: ${p.reason}`);
  const teeth = 'green on the skeleton: the test has no teeth';

  // A helper outside the tests changed.
  const helper = HEAD_SOURCE.replace(VITEST, `${VITEST}\nconst helper = () => 2;`);
  const shared = checkRedReports(
    [redReport(BASE_FILE, tests)],
    [BASE_FILE],
    ROOT,
    baselinesOf(helper),
  );
  expect(greenOnes(shared)).toEqual([`[AC-2] b: ${teeth}`, `[AC-3] c: ${teeth}`]);
  expect(shared.notes).toEqual([
    `${BASE_FILE}: existed at the base, judged as a whole (every test must be red): code outside the tests changed (imports, helpers, hooks, top-level tables or describe titles)`,
  ]);
  expect(shared.exempt).toEqual([]);

  // A data file the task changed, which the test file names.
  const reads = HEAD_SOURCE.replace('[AC-5] e', '[AC-5] e reads ./expected.csv');
  const support = checkRedReports(
    [
      redReport(
        BASE_FILE,
        tests.map(([n, s, c]) =>
          n === '[AC-5] e' ? ['[AC-5] e reads ./expected.csv', s, c] : [n, s, c],
        ) as RedTest[],
      ),
    ],
    [BASE_FILE],
    ROOT,
    baselinesOf(reads, [
      { path: BASE_FILE, status: 'M' },
      { path: 'test/spec/notify/expected.csv', status: 'M' },
    ]),
  );
  // CT-06r: without a declaration in the ledger the file is whole, as before.
  expect(greenOnes(support)).toEqual([
    `[AC-2] b: ${teeth} (the file may read a test-support file the task changed and the ledger does not declare this test exempt)`,
    `[AC-3] c: ${teeth} (the file may read a test-support file the task changed and the ledger does not declare this test exempt)`,
  ]);
  expect(support.notes[0]).toBe(
    `${BASE_FILE}: existed at the base, judged as a whole except the tests the ledger declares exempt (every other test must be red): it may read a test-support file the task changed: ${BASE_FILE} names expected.csv`,
  );
  expect(support.exempt).toEqual([]);

  // Vitest's own JSON report (no reporter name): its full names are not `suite > test`.
  const plain = checkRedReports(
    [redReport(BASE_FILE, tests, 'vitest-json')],
    [BASE_FILE],
    ROOT,
    baselinesOf(HEAD_SOURCE),
  );
  expect(greenOnes(plain)).toEqual([`[AC-2] b: ${teeth}`, `[AC-3] c: ${teeth}`]);
  expect(plain.notes).toEqual([
    `${BASE_FILE}: existed at the base, judged as a whole (every test must be red): the report is not from the red reporter`,
  ]);
});

it('[CT-06p] ruleTestBaselines: new and renamed files keep the old rule; JSX, unreadable heads and support files are whole', () => {
  const NEW = 'test/spec/notify/override.int.test.ts';
  const RENAMED = 'test/spec/notify/renamed.test.ts';
  const JSX = 'test/spec/notify/page.browser.test.tsx';
  const GONE = 'test/spec/notify/gone.test.ts';
  const read = reader(
    {
      [BASE_FILE]: BASE_SOURCE,
      'test/spec/notify/old.test.ts': BASE_SOURCE,
      [JSX]: BASE_SOURCE,
      [GONE]: BASE_SOURCE,
    },
    { [BASE_FILE]: HEAD_SOURCE, [NEW]: HEAD_SOURCE, [RENAMED]: BASE_SOURCE, [JSX]: HEAD_SOURCE },
  );
  const changes: Change[] = [
    { path: BASE_FILE, status: 'M' },
    { path: NEW, status: 'A' },
    { path: RENAMED, status: 'R', oldPath: 'test/spec/notify/old.test.ts' },
    { path: JSX, status: 'M' },
    { path: GONE, status: 'M' },
    // Outside the test_paths: never a test-support file.
    { path: 'apps/api/src/modules/notification/expected.csv', status: 'M' },
  ];
  const b = ruleTestBaselines(
    [BASE_FILE, NEW, RENAMED, JSX, GONE],
    changes,
    ['test/spec/notify/**'],
    read,
  );
  expect([...b.keys()].sort()).toEqual([BASE_FILE, GONE, JSX].sort());
  expect(b.get(BASE_FILE)?.kind).toBe('tests');
  expect(b.get(JSX)).toEqual({
    kind: 'whole',
    reason: 'only .ts / .js rule-test files are compared test by test (JSX is not read)',
  });
  expect(b.get(GONE)).toEqual({
    kind: 'whole',
    reason: 'its content in the red run cannot be read',
  });
  // The renamed file's old path is a changed file in scope: a file that names it is whole.
  const naming = HEAD_SOURCE.replace('[AC-5] e', '[AC-5] e after old.test.ts');
  const n = ruleTestBaselines(
    [BASE_FILE],
    changes,
    ['test/spec/notify/**'],
    reader({ [BASE_FILE]: BASE_SOURCE }, { [BASE_FILE]: naming }),
  );
  // CT-06r: such a file keeps its compared blocks, so a declared exemption can be judged.
  expect(n.get(BASE_FILE)).toMatchObject({
    kind: 'support',
    reason: `it may read a test-support file the task changed: ${BASE_FILE} names old.test.ts`,
  });
  expect((n.get(BASE_FILE) as { blocks: unknown[] }).blocks).toHaveLength(5);
});

// CT-06r: declared exemptions for the unchanged tests of a file that may read a changed
// test-support file (the B2-01l shape: a data-driven test file whose structural tests hold for the
// old data too).
const SUPPORT_SOURCE = HEAD_SOURCE.replace('[AC-5] e', '[AC-5] e reads ./expected.csv');
const SUPPORT_CHANGES: Change[] = [
  { path: BASE_FILE, status: 'M' },
  { path: 'test/spec/notify/expected.csv', status: 'M' },
];
const supportBaselines = () => baselinesOf(SUPPORT_SOURCE, SUPPORT_CHANGES);
const SUPPORT_TESTS: RedTest[] = [
  ['[AC-1] a', 'failed', 'AssertionError: x'],
  ['[AC-2] b', 'passed'],
  ['[AC-3] c', 'passed'],
  ['[AC-4] d', 'failed', 'AssertionError: x'],
  ['[AC-5] e reads ./expected.csv', 'failed', 'Error: NotImplemented: x'],
];
const REASON = 'structural: holds for the old csv too, cannot be red';
const declare = (test: string, reason = REASON, file = BASE_FILE) => ({ file, test, reason });
const CONFIRM =
  "needs the rule-test reviewer's confirmation (evidence spec_test_review.red_exempt_confirmed)";

it('[CT-06r] a declared, unchanged test of a file that may read a changed data file may be green; the undeclared ones stay red', () => {
  const result = checkRedReports(
    [redReport(BASE_FILE, SUPPORT_TESTS)],
    [BASE_FILE],
    ROOT,
    supportBaselines(),
    [declare('[AC-2] b')],
  );
  // [AC-3] c is unchanged too but not declared: it must be red, as under CT-06p.
  expect(result.problems).toEqual([
    {
      file: BASE_FILE,
      test: '[AC-3] c',
      reason:
        'green on the skeleton: the test has no teeth (the file may read a test-support file the task changed and the ledger does not declare this test exempt)',
    },
  ]);
  expect(result.exempt).toEqual([
    { file: BASE_FILE, test: '[AC-2] b', status: 'passed', declared: true, reason: REASON },
  ]);
  expect(result.red).toEqual([
    `${BASE_FILE} > [AC-1] a`,
    `${BASE_FILE} > [AC-4] d`,
    `${BASE_FILE} > [AC-5] e reads ./expected.csv`,
  ]);
  expect(result.notes).toEqual([
    `${BASE_FILE}: existed at the base, judged as a whole except the tests the ledger declares exempt (every other test must be red): it may read a test-support file the task changed: ${BASE_FILE} names expected.csv`,
    `${BASE_FILE} > [AC-2] b: unchanged since the base, exempt by the task's declaration (green; reason: ${REASON}); ${CONFIRM}`,
  ]);
  // Both unchanged tests declared: the file passes with its three changed tests red.
  const both = checkRedReports(
    [redReport(BASE_FILE, SUPPORT_TESTS)],
    [BASE_FILE],
    ROOT,
    supportBaselines(),
    [declare('[AC-2] b'), declare('[AC-3] c', '[AC-3] 只核对 csv 列数，对旧 csv 同样成立')],
  );
  expect(both.ok).toBe(true);
  expect(both.exempt?.map((e) => e.test)).toEqual(['[AC-2] b', '[AC-3] c']);
  // A declared test that is red still needs a valid reason; it is listed as exempt (red).
  const redDeclared = checkRedReports(
    [
      redReport(
        BASE_FILE,
        SUPPORT_TESTS.map(([n, s, c]) =>
          n === '[AC-2] b' ? ['[AC-2] b', 'failed', 'Error: NotImplemented: x'] : [n, s, c],
        ) as RedTest[],
      ),
    ],
    [BASE_FILE],
    ROOT,
    supportBaselines(),
    [declare('[AC-2] b'), declare('[AC-3] c')],
  );
  expect(redDeclared.ok).toBe(true);
  expect(redDeclared.exempt).toEqual([
    { file: BASE_FILE, test: '[AC-2] b', status: 'failed', declared: true, reason: REASON },
    { file: BASE_FILE, test: '[AC-3] c', status: 'passed', declared: true, reason: REASON },
  ]);
  const wrong = checkRedReports(
    [
      redReport(
        BASE_FILE,
        SUPPORT_TESTS.map(([n, s, c]) =>
          n === '[AC-2] b'
            ? ['[AC-2] b', 'failed', 'TypeError: rows is not a function']
            : [n, s, c],
        ) as RedTest[],
      ),
    ],
    [BASE_FILE],
    ROOT,
    supportBaselines(),
    [declare('[AC-2] b'), declare('[AC-3] c')],
  );
  expect(wrong.problems.map((p) => `${p.test}: ${p.reason}`)).toEqual([
    '[AC-2] b: red for the wrong reason (TypeError)',
  ]);
});

it('[CT-06r] a declaration does not apply to a new or changed test, nor without a reason of 10 characters', () => {
  // [AC-1] a changed and [AC-5] e is new: declared or not, they must be red.
  const changed = checkRedReports(
    [
      redReport(BASE_FILE, [
        ['[AC-1] a', 'passed'],
        ['[AC-2] b', 'passed'],
        ['[AC-3] c', 'passed'],
        ['[AC-4] d', 'failed', 'AssertionError: x'],
        ['[AC-5] e reads ./expected.csv', 'passed'],
      ]),
    ],
    [BASE_FILE],
    ROOT,
    supportBaselines(),
    [
      declare('[AC-1] a'),
      declare('[AC-2] b'),
      declare('[AC-3] c'),
      declare('[AC-5] e reads ./expected.csv'),
    ],
  );
  expect(changed.ok).toBe(false);
  expect(changed.problems.map((p) => p.test)).toEqual([
    '[AC-1] a',
    '[AC-5] e reads ./expected.csv',
  ]);
  expect(changed.exempt?.map((e) => e.test)).toEqual(['[AC-2] b', '[AC-3] c']);
  expect(changed.notes).toContain(
    `${BASE_FILE} > [AC-1] a: declared exempt, but the declaration does not apply: the test is new or changed since the base (only an unchanged test may be declared exempt); the test must be red`,
  );
  expect(changed.notes).toContain(
    `${BASE_FILE} > [AC-5] e reads ./expected.csv: declared exempt, but the declaration does not apply: the test is new or changed since the base (only an unchanged test may be declared exempt); the test must be red`,
  );
  // A reason that is missing, blank or too short: the declaration does not apply.
  for (const reason of ['', '         ', 'too short']) {
    const short = checkRedReports(
      [redReport(BASE_FILE, SUPPORT_TESTS)],
      [BASE_FILE],
      ROOT,
      supportBaselines(),
      [declare('[AC-2] b', reason), declare('[AC-3] c')],
    );
    expect(short.ok, JSON.stringify(reason)).toBe(false);
    expect(short.problems.map((p) => p.test)).toEqual(['[AC-2] b']);
    expect(short.notes).toContain(
      `${BASE_FILE} > [AC-2] b: declared exempt, but the declaration does not apply: the reason is shorter than 10 characters; the test must be red`,
    );
  }
  // A declaration must name the test's full name exactly: a title, a prefix, another file do not.
  const miss = checkRedReports(
    [redReport(BASE_FILE, SUPPORT_TESTS)],
    [BASE_FILE],
    ROOT,
    supportBaselines(),
    [
      declare('[AC-2]'),
      declare('b'),
      declare('[AC-2] b', REASON, 'test/spec/notify/other.test.ts'),
    ],
  );
  expect(miss.problems.map((p) => p.test)).toEqual(['[AC-2] b', '[AC-3] c']);
  expect(miss.exempt).toEqual([]);
  expect(miss.notes).toContain(
    `${BASE_FILE}: the declared exemption of "[AC-2]" matches no test of the report (the full name must be exactly the red reporter's)`,
  );
  expect(miss.notes).toContain(
    'declared exemption of test/spec/notify/other.test.ts > [AC-2] b: test/spec/notify/other.test.ts is not an expected rule-test file (ignored)',
  );
});

it('[CT-06r] a declaration applies only to a file judged whole because of a changed test-support file; every test declared fails', () => {
  const declared = [declare('[AC-2] b'), declare('[AC-3] c')];
  const teeth = 'green on the skeleton: the test has no teeth';
  // Code outside the tests changed: whole, the declarations do not apply.
  const helper = HEAD_SOURCE.replace(VITEST, `${VITEST}\nconst helper = () => 2;`);
  const shared = checkRedReports(
    [redReport(BASE_FILE, SUPPORT_TESTS.slice(0, 4))],
    [BASE_FILE],
    ROOT,
    baselinesOf(helper, SUPPORT_CHANGES),
    declared,
  );
  expect(shared.problems.map((p) => `${p.test}: ${p.reason}`)).toEqual([
    `[AC-2] b: ${teeth}`,
    `[AC-3] c: ${teeth}`,
  ]);
  expect(shared.exempt).toEqual([]);
  expect(shared.notes[1]).toBe(
    `${BASE_FILE}: 2 declared exemption(s) do not apply: code outside the tests changed (imports, helpers, hooks, top-level tables or describe titles) (a declaration applies only to a file judged as a whole because it may read a changed test-support file)`,
  );
  // Not the red reporter: whole, the declarations do not apply.
  const plain = checkRedReports(
    [redReport(BASE_FILE, SUPPORT_TESTS, 'vitest-json')],
    [BASE_FILE],
    ROOT,
    supportBaselines(),
    declared,
  );
  expect(plain.problems.map((p) => p.test)).toEqual(['[AC-2] b', '[AC-3] c']);
  expect(plain.notes[1]).toContain(
    '2 declared exemption(s) do not apply: the report is not from the red reporter',
  );
  // A file judged test by test (no support file changed): the declarations are not needed.
  const tests = checkRedReports(
    [redReport(BASE_FILE, SUPPORT_TESTS)],
    [BASE_FILE],
    ROOT,
    baselinesOf(SUPPORT_SOURCE),
    declared,
  );
  expect(tests.ok).toBe(true);
  expect(tests.exempt).toEqual([
    { file: BASE_FILE, test: '[AC-2] b', status: 'passed' },
    { file: BASE_FILE, test: '[AC-3] c', status: 'passed' },
  ]);
  expect(tests.notes[0]).toBe(
    `${BASE_FILE}: 2 declared exemption(s) are not needed: the file is judged test by test (its unchanged tests are exempt by themselves)`,
  );
  // A new file: no baseline, the declarations do not apply (every test red).
  const NEW = 'test/spec/notify/new.test.ts';
  const fresh = checkRedReports(
    [redReport(NEW, [['[AC-1] a', 'passed']])],
    [NEW],
    ROOT,
    new Map(),
    [declare('[AC-1] a', REASON, NEW)],
  );
  expect(fresh.problems.map((p) => p.reason)).toEqual([teeth]);
  expect(fresh.notes).toEqual([
    `${NEW}: 1 declared exemption(s) do not apply: the file is new, renamed or could not be compared with the base (a declaration applies only to a file judged as a whole because it may read a changed test-support file)`,
  ]);
  // Without baselines (no --base) declarations are ignored and the result keeps its old shape.
  const old = checkRedReports(
    [redReport(BASE_FILE, SUPPORT_TESTS)],
    [BASE_FILE],
    ROOT,
    undefined,
    declared,
  );
  expect(old.exempt).toBeUndefined();
  expect(old.problems.map((p) => p.test)).toEqual(['[AC-2] b', '[AC-3] c']);
  expect(old.notes).toEqual([]);
  // Every test of the file unchanged and declared: nothing would be shown red.
  const same = SUPPORT_SOURCE.replace(
    "expect(await columns()).toEqual(['app_id', 'variant']);",
    'expect(1).toBe(1);',
  )
    .replace(
      "expect(await primaryKey()).toEqual(['app_id', 'code', 'variant']);",
      'expect(1).toBe(1);',
    )
    .replace(spec('[AC-5] e reads ./expected.csv'), '')
    .replace(/\n+$/, '\n');
  const all = checkRedReports(
    [
      redReport(BASE_FILE, [
        ['[AC-1] a', 'passed'],
        ['[AC-2] b', 'passed'],
        ['[AC-3] c', 'passed'],
        ['[AC-4] d', 'passed'],
      ]),
    ],
    [BASE_FILE],
    ROOT,
    baselinesOf(`${same.trimEnd()} // reads ./expected.csv\n`, SUPPORT_CHANGES),
    ['[AC-1] a', '[AC-2] b', '[AC-3] c', '[AC-4] d'].map((t) => declare(t)),
  );
  expect(all.ok).toBe(false);
  expect(all.problems).toEqual([
    {
      file: BASE_FILE,
      test: null,
      reason:
        'existed at the base and every test is declared exempt: nothing is shown red (4 test(s); evidence-check wants a red test of every expected file)',
    },
  ]);
  expect(all.exempt).toHaveLength(4);
});

it('[CT-06p] without baselines the result keeps its old shape (no exempt list)', () => {
  const result = checkRedReports(
    [redReport(BASE_FILE, [['[AC-1] a', 'passed']])],
    [BASE_FILE],
    ROOT,
  );
  expect(result.exempt).toBeUndefined();
  expect(result.problems[0]?.reason).toBe('green on the skeleton: the test has no teeth');
});

// CT-06w (B1-12g red/4): the two platform contract tests, unchanged in their tests, were judged
// whole because `./kit.ts` of their own directory shares its basename with the identity kit the
// task changed (test/spec/identity/step-up-verify/kit.ts). Imports are resolved to paths now.
it('[CT-06w] ruleTestBaselines: an import of a same-named file in another directory is not a read of the changed support file', () => {
  const fixture = (p: string): string => readFileSync(join(FIXTURES, `b112g-${p}.txt`), 'utf8');
  const EVENTS = 'test/spec/platform/events/contract.test.ts';
  const QUEUE = 'test/spec/platform/queue/contract.test.ts';
  const IDENTITY_KIT = 'test/spec/identity/step-up-verify/kit.ts';
  const tree: Record<string, string> = {
    // The implementation modules the fixtures import (outside the test code).
    ...Object.fromEntries(
      [
        'events/index.ts',
        'logging/redaction.ts',
        'logging/logger.ts',
        'queue/index.ts',
        'db/index.ts',
        'config/index.ts',
      ].map((p) => [`apps/api/src/modules/platform/${p}`, '']),
    ),
    [EVENTS]: fixture('events-contract.test.ts'),
    [QUEUE]: fixture('queue-contract.test.ts'),
    'test/spec/platform/events/kit.ts': fixture('events-kit.ts'),
    'test/spec/platform/queue/kit.ts': fixture('queue-kit.ts'),
    'test/spec/platform/db/kit.ts': fixture('db-kit.ts'),
    [IDENTITY_KIT]: fixture('identity-step-up-verify-kit.ts'),
  };
  const scope = [
    'test/spec/notification/risk-state-message/**',
    EVENTS,
    QUEUE,
    'test/spec/platform/idempotency/abandon-route/http-kit.ts',
    'test/spec/identity/identity-level/http-kit.ts',
    'test/spec/identity/bind-phone/http-kit.ts',
    IDENTITY_KIT,
    'test/spec/identity/sms-codes/http-kit.ts',
  ];
  const changes: Change[] = [
    { path: EVENTS, status: 'M' },
    { path: QUEUE, status: 'M' },
    { path: 'test/spec/platform/idempotency/abandon-route/http-kit.ts', status: 'M' },
    { path: 'test/spec/identity/identity-level/http-kit.ts', status: 'M' },
    { path: 'test/spec/identity/sms-codes/http-kit.ts', status: 'M' },
    { path: IDENTITY_KIT, status: 'M' },
    { path: 'test/spec/notification/risk-state-message/render.test.ts', status: 'A' },
    { path: 'test/spec/notification/risk-state-message/db-kit.ts', status: 'A' },
  ];
  // The test bodies did not change (the same text at the base), only the kits elsewhere did.
  const unchanged = ruleTestBaselines([EVENTS, QUEUE], changes, scope, reader(tree, tree));
  expect(unchanged.get(EVENTS)?.kind).toBe('tests');
  expect(unchanged.get(QUEUE)?.kind).toBe('tests');
  // The kit of its own directory changed: whole, through the resolved import.
  const own = ruleTestBaselines(
    [EVENTS, QUEUE],
    [...changes, { path: 'test/spec/platform/events/kit.ts', status: 'M' }],
    [...scope, 'test/spec/platform/events/kit.ts'],
    reader(tree, tree),
  );
  expect(own.get(EVENTS)).toMatchObject({
    kind: 'support',
    reason:
      'it may read a test-support file the task changed: it loads test/spec/platform/events/kit.ts',
  });
  expect(own.get(QUEUE)?.kind).toBe('tests');
  // An import that cannot be resolved keeps the old judgement, and the notes say so.
  const bare = {
    ...tree,
    [QUEUE]: tree[QUEUE]?.replace("from './kit.ts'", "from 'queue-kit/kit.ts'") ?? '',
  };
  const kept = ruleTestBaselines([EVENTS, QUEUE], changes, scope, reader(bare, bare));
  expect(kept.get(QUEUE)).toMatchObject({
    kind: 'support',
    // (r8: a package not known to read no files keeps the rule-test file open, so the first
    // specifier with the name, ../db/kit.ts, already counts.)
    reason: `it may read a test-support file the task changed: ${QUEUE} names kit.ts in an unresolved import ../db/kit.ts (${QUEUE} is not closed: it imports queue-kit/kit.ts, a package not known to read no files)`,
  });
});

// CT-06zxc (D10-347, B1-03w): the ledger's literal renames are applied to the base of a frozen
// rule-test file before it is compared with the head.
const SCHED = 'test/spec/risk/freeze-expiry/scheduling.test.ts';
const SCHED_KIT = 'test/spec/risk/freeze-expiry/kit.ts';
const SCHED_SCOPE = ['test/spec/risk/freeze-expiry/**'];
const schedFixture = (side: 'base' | 'head'): string =>
  readFileSync(join(FIXTURES, `ct06zxc-scheduling-${side}.test.ts.txt`), 'utf8');
const RENAMES = [
  { from: "'freeze-expiry'", to: "'freeze_expiry'" },
  { from: "'daily-alerts'", to: "'daily_alerts'" },
];
const SCHED_TESTS: RedTest[] = [
  ['[AC-1] seeds both jobs', 'failed', 'Error: NotImplemented: seed'],
  ['[AC-2] freeze-expiry reschedules on the next minute', 'passed'],
  ['[AC-3] daily-alerts reschedules on the next day', 'passed'],
  ['[AC-4] the queue is exclusive', 'passed'],
];
const schedBaselines = (
  head: string,
  renames: { from: string; to: string }[] = RENAMES,
  changes: Change[] = [{ path: SCHED, status: 'M' }],
) =>
  ruleTestBaselines(
    [SCHED],
    changes,
    SCHED_SCOPE,
    reader({ [SCHED]: schedFixture('base') }, { [SCHED]: head }),
    renames,
  );
const RENAMED_NOTE = `${SCHED}: compared with its base after the ledger's renames (D10-347: "'freeze-expiry'" → "'freeze_expiry'" ×3, "'daily-alerts'" → "'daily_alerts'" ×3)`;

it('[CT-06zxc] a file that differs only by the declared renames is unchanged: left out of the expected list', () => {
  const head = schedFixture('head');
  const read = reader({ [SCHED]: schedFixture('base') }, { [SCHED]: head });
  // Without the renames: the top-level table changed, the whole file must be red (as before).
  expect(renamedOnlyFiles([SCHED], read, [])).toEqual([]);
  expect(schedBaselines(head, [])).toEqual(
    new Map([
      [
        SCHED,
        {
          kind: 'whole',
          reason:
            'code outside the tests changed (imports, helpers, hooks, top-level tables or describe titles)',
        },
      ],
    ]),
  );
  // With them: unchanged, whatever its tests would have done (B1-03w: red for an unknown job name).
  const left = renamedOnlyFiles([SCHED, SCHED], read, RENAMES);
  expect(left).toEqual([
    {
      file: SCHED,
      applied: [
        `"'freeze-expiry'" → "'freeze_expiry'" ×3`,
        `"'daily-alerts'" → "'daily_alerts'" ×3`,
      ],
    },
  ]);
  expect(renamedOnlyNote(left[0] as RenamedOnly)).toBe(
    `${RENAMED_NOTE.replace(": compared with its base after the ledger's renames", ": unchanged after the ledger's renames")}, left out of the expected list (not run, not judged); the rule-test reviewer confirms the renames are literal follow-ups only`,
  );
  // It does not matter whether it may read a changed kit: only its own content is compared.
  // A head that cannot be read, a new file, a rename that does not hit: stays expected.
  const NEW = 'test/spec/risk/freeze-expiry/new.test.ts';
  expect(
    renamedOnlyFiles(
      [SCHED, NEW, BASE_FILE],
      reader(
        { [SCHED]: schedFixture('base'), [BASE_FILE]: BASE_SOURCE },
        { [NEW]: head, [BASE_FILE]: BASE_SOURCE },
      ),
      RENAMES,
    ),
  ).toEqual([]);
  // What ruleTestBaselines says of such a file when a caller still hands it over.
  expect(schedBaselines(head).get(SCHED)).toMatchObject({
    kind: 'tests',
    renamed: { identical: true },
  });
});

it('[CT-06zxc] renamed and still different, reading a changed kit: red_exempt applies as before against the renamed base', () => {
  const head = schedFixture('head').replace('toBe(86_400)', 'toBe(86_401)');
  const b = schedBaselines(head, RENAMES, [
    { path: SCHED, status: 'M' },
    { path: SCHED_KIT, status: 'M' },
  ]);
  expect(b.get(SCHED)).toMatchObject({ kind: 'support', renamed: { identical: false } });
  const reason = 'frozen test body unchanged, only the job-name literals follow D10-343';
  const declared = [
    { file: SCHED, test: '[AC-2] freeze-expiry reschedules on the next minute', reason },
    { file: SCHED, test: '[AC-4] the queue is exclusive', reason },
  ];
  const tests = SCHED_TESTS.map(([n, s, c]) =>
    n.startsWith('[AC-3]')
      ? [n, 'failed', 'AssertionError: expected 86400 to be 86401']
      : [n, s, c],
  ) as RedTest[];
  const result = checkRedReports([redReport(SCHED, tests)], [SCHED], ROOT, b, declared);
  expect(result.problems).toEqual([]);
  expect(result.ok).toBe(true);
  expect(result.exempt?.filter((e) => e.declared === true).map((e) => e.test)).toEqual([
    '[AC-2] freeze-expiry reschedules on the next minute',
    '[AC-4] the queue is exclusive',
  ]);
  // Undeclared: the unchanged test stays held to the red rule (the file may read the kit).
  const undeclared = checkRedReports(
    [redReport(SCHED, tests)],
    [SCHED],
    ROOT,
    b,
    declared.slice(0, 1),
  );
  expect(undeclared.problems.map((p) => p.test)).toEqual(['[AC-4] the queue is exclusive']);
  // A declaration of the changed test does not apply.
  const changed = checkRedReports([redReport(SCHED, SCHED_TESTS)], [SCHED], ROOT, b, [
    ...declared,
    { file: SCHED, test: '[AC-3] daily-alerts reschedules on the next day', reason },
  ]);
  expect(changed.problems.map((p) => p.test)).toEqual([
    '[AC-3] daily-alerts reschedules on the next day',
  ]);
});

it('[CT-06zxc] a rename plus any other change is still caught: a changed assertion, a changed helper', () => {
  const head = schedFixture('head');
  // One assertion weakened next to the renames: that test is changed and must be red.
  const weakened = head.replace('toBe(60)', 'toBeGreaterThan(0)');
  const b = schedBaselines(weakened);
  expect(b.get(SCHED)).toMatchObject({ kind: 'tests', renamed: { identical: false } });
  const result = checkRedReports([redReport(SCHED, SCHED_TESTS)], [SCHED], ROOT, b);
  expect(result.ok).toBe(false);
  expect(result.problems).toEqual([
    {
      file: SCHED,
      test: '[AC-2] freeze-expiry reschedules on the next minute',
      reason: 'green on the skeleton: the test has no teeth (new or changed since the base)',
    },
  ]);
  expect(result.notes[0]).toBe(`${RENAMED_NOTE}; the renamed base still differs from the head`);
  // A change outside the tests next to the renames: the whole file must be red, as before.
  const helper = head.replace('as const;', 'as const;\nconst extra = 1;');
  const whole = schedBaselines(helper);
  expect(whole.get(SCHED)).toMatchObject({ kind: 'whole', renamed: { identical: false } });
  const w = checkRedReports([redReport(SCHED, SCHED_TESTS)], [SCHED], ROOT, whole);
  expect(w.problems.map((p) => p.test)).toEqual([
    '[AC-2] freeze-expiry reschedules on the next minute',
    '[AC-3] daily-alerts reschedules on the next day',
    '[AC-4] the queue is exclusive',
  ]);
  // A rename the ledger does not declare is a change like any other.
  const partial = schedBaselines(head, [RENAMES[0] as { from: string; to: string }]);
  expect(partial.get(SCHED)).toMatchObject({ kind: 'whole' });
});

it('[CT-06zxc] renames are literal, ordered, and leave new files and renames without a hit alone', () => {
  expect(applyRenames('a.b a.b axb $&', [{ from: 'a.b', to: '$&-$1' }])).toEqual({
    text: '$&-$1 $&-$1 axb $&',
    applied: ['"a.b" → "$&-$1" ×2'],
  });
  // In ledger order: the second rename sees the first one's output.
  expect(
    applyRenames('x', [
      { from: 'x', to: 'y' },
      { from: 'y', to: 'z' },
      { from: 'never', to: 'there' },
    ]),
  ).toEqual({ text: 'z', applied: ['"x" → "y" ×1', '"y" → "z" ×1'] });
  // A new file has no baseline with or without renames; a file no rename hits has no `renamed`.
  const NEW = 'test/spec/risk/freeze-expiry/new.test.ts';
  const read = reader(
    { [BASE_FILE]: BASE_SOURCE },
    { [BASE_FILE]: HEAD_SOURCE, [NEW]: schedFixture('head') },
  );
  const changes: Change[] = [
    { path: BASE_FILE, status: 'M' },
    { path: NEW, status: 'A' },
  ];
  const scope = ['test/spec/notify/**', 'test/spec/risk/freeze-expiry/**'];
  const plain = ruleTestBaselines([BASE_FILE, NEW], changes, scope, read);
  const renamed = ruleTestBaselines([BASE_FILE, NEW], changes, scope, read, RENAMES);
  expect(renamed).toEqual(plain);
  expect([...renamed.keys()]).toEqual([BASE_FILE]);
  expect(renamed.get(BASE_FILE)).not.toHaveProperty('renamed');
});

// CT-06zxe (D10-371): registered expected values in a top-level helper of a frozen test.
const NOTIFY = 'test/spec/payment/result/notify.int.test.ts';
const NOTIFY_BASE = readFileSync(join(FIXTURES, 'ct06zxe-notify-base.test.ts.txt'), 'utf8');
const NOTIFY_HEAD = NOTIFY_BASE.replace('    diff_fen: AMOUNT,', '    diff_fen: -AMOUNT,');
const DIFF_FEN = {
  file: NOTIFY,
  helper: 'onlyAnomaly',
  from: '    diff_fen: AMOUNT,',
  to: '    diff_fen: -AMOUNT,',
};
const RED = 'AssertionError: expected 500n to be -500n';
const NOTIFY_CALLERS = [
  'notify > [AC-2] a notify on a closed order only records an anomaly',
  'notify > [AC-3] a repeated notify on a closed order records it once',
  'notify > [AC-4] wechat: a late notify records an anomaly',
  'notify > [AC-4] alipay: a late notify records an anomaly',
];
const NOTIFY_OTHERS = [
  'notify > [AC-1] a paid notify opens the order',
  'notify > [AC-5] a wrong amount is refused',
];
/** The red run of B2-15l: the callers of onlyAnomaly red, the others green on the old code. */
const notifyTests = (green: string[] = NOTIFY_OTHERS): RedTest[] =>
  [...NOTIFY_OTHERS, ...NOTIFY_CALLERS].map((n) =>
    green.includes(n) ? [n, 'passed'] : [n, 'failed', RED],
  );
const notifyBaselines = (
  head: string,
  entries: { file: string; helper: string; from: string; to: string }[] = [DIFF_FEN],
  renames: { from: string; to: string }[] = [],
  base = NOTIFY_BASE,
) =>
  ruleTestBaselines(
    [NOTIFY],
    [{ path: NOTIFY, status: 'M' }],
    ['test/spec/payment/**'],
    reader({ [NOTIFY]: base }, { [NOTIFY]: head }),
    renames,
    entries,
  );

it('[CT-06zxe] a registered expected value in a helper: only the tests calling it must be red, the others may pass', () => {
  const b = notifyBaselines(NOTIFY_HEAD);
  expect(b.get(NOTIFY)).toMatchObject({
    kind: 'tests',
    expectedValues: {
      applied: [DIFF_FEN],
      skipped: [],
      void: [],
      affected: [
        'notify > [AC-2] a notify on a closed order only records an anomaly',
        'notify > [AC-3] a repeated notify on a closed order records it once',
        'notify > [AC-4] *: a late notify records an anomaly',
      ],
    },
  });
  expect(b.get(NOTIFY)).not.toHaveProperty('expectedValues.whole');
  const result = checkRedReports([redReport(NOTIFY, notifyTests())], [NOTIFY], ROOT, b);
  expect(result.problems).toEqual([]);
  expect(result.ok).toBe(true);
  expect(result.exempt?.map((e) => [e.test, e.status])).toEqual(
    NOTIFY_OTHERS.map((n) => [n, 'passed']),
  );
  expect(result.notes[0]).toContain(
    `${NOTIFY}: compared with its base after the registered expected values (D10-371: ${NOTIFY} / onlyAnomaly: "    diff_fen: AMOUNT," → "    diff_fen: -AMOUNT,"); tests calling the changed helper(s), which must be red: notify > [AC-2]`,
  );
  // A caller green on the old code has no teeth.
  const green = checkRedReports(
    [redReport(NOTIFY, notifyTests([...NOTIFY_OTHERS, NOTIFY_CALLERS[1] as string]))],
    [NOTIFY],
    ROOT,
    b,
  );
  expect(green.problems).toEqual([
    {
      file: NOTIFY,
      test: NOTIFY_CALLERS[1],
      reason: 'green on the skeleton: the test has no teeth (new or changed since the base)',
    },
  ]);
  // Without the entry the helper change judges the whole file, as before: the others must be red.
  const whole = notifyBaselines(NOTIFY_HEAD, []);
  expect(whole.get(NOTIFY)).toMatchObject({ kind: 'whole' });
  expect(
    checkRedReports([redReport(NOTIFY, notifyTests())], [NOTIFY], ROOT, whole).problems.map(
      (p) => p.test,
    ),
  ).toEqual(NOTIFY_OTHERS);
  // The non-callers are still compared: one changed next to the entry must be red.
  const edited = NOTIFY_HEAD.replace("toBe('refused')", "toBe('rejected')");
  const e = checkRedReports(
    [redReport(NOTIFY, notifyTests())],
    [NOTIFY],
    ROOT,
    notifyBaselines(edited),
  );
  expect(e.problems.map((p) => p.test)).toEqual(['notify > [AC-5] a wrong amount is refused']);
});

it('[CT-06zxe] a change outside the tests beyond the registered ones judges the whole file', () => {
  for (const head of [
    NOTIFY_HEAD.replace("type: 'pay_anomaly',", "type: 'pay_other',"),
    NOTIFY_HEAD.replace('const AMOUNT = 500n;', 'const AMOUNT = 600n;'),
    NOTIFY_HEAD.replace('    expected_fen: 0n,\n', ''),
    NOTIFY_HEAD.replace(
      "describe('notify', () => {",
      "describe('notify', () => {\n  const extra = 1;",
    ),
  ]) {
    const b = notifyBaselines(head);
    expect(b.get(NOTIFY)).toMatchObject({
      kind: 'whole',
      reason:
        'code outside the tests changed (imports, helpers, hooks, top-level tables or describe titles)',
      expectedValues: { applied: [DIFF_FEN] },
    });
    expect(b.get(NOTIFY)?.expectedValues?.whole).toContain(
      'also after the registered expected values',
    );
    const result = checkRedReports([redReport(NOTIFY, notifyTests())], [NOTIFY], ROOT, b);
    expect(result.problems.map((p) => p.test)).toEqual(NOTIFY_OTHERS);
  }
  // A head that does not make the registered change is compared without it (as before).
  const same = notifyBaselines(NOTIFY_BASE.replace("toBe('refused')", "toBe('rejected')"));
  expect(same.get(NOTIFY)).toMatchObject({
    kind: 'tests',
    expectedValues: {
      whole:
        'the head does not make the registered change (compared without the registered expected values)',
    },
  });
  // A helper used by a hook: its impact cannot be bounded, the whole file.
  const hooked = (s: string): string =>
    s.replace("describe('notify', () => {", "describe('notify', () => {\n  void onlyAnomaly;");
  const h = notifyBaselines(hooked(NOTIFY_HEAD), [DIFF_FEN], [], hooked(NOTIFY_BASE));
  expect(h.get(NOTIFY)).toMatchObject({ kind: 'whole' });
  expect(h.get(NOTIFY)?.expectedValues?.whole).toContain(
    '"onlyAnomaly" is used outside the test blocks',
  );
});

it('[CT-06zxe] an entry that does not apply leaves the file judged as before: no helper, from 0 or 2 times, a cut token', () => {
  const cases: [typeof DIFF_FEN, string][] = [
    [{ ...DIFF_FEN, helper: 'nope' }, 'the base has no top-level helper nope'],
    [{ ...DIFF_FEN, helper: 'notify' }, 'the base has no top-level helper notify'],
    [{ ...DIFF_FEN, from: '    diff_fen: OTHER,' }, 'from occurs 0 time(s) in onlyAnomaly'],
    [{ ...DIFF_FEN, from: '_fen: ', to: '_fen: -' }, 'from occurs 2 time(s) in onlyAnomaly'],
    [
      { ...DIFF_FEN, from: 'MOUNT,', to: '-MOUNT,' },
      'the change alters more than a value of onlyAnomaly',
    ],
    [{ ...DIFF_FEN, helper: 'prepared' }, 'from occurs 0 time(s) in prepared'],
  ];
  for (const [entry, why] of cases) {
    const b = notifyBaselines(NOTIFY_HEAD, [entry]);
    expect(b.get(NOTIFY)).toMatchObject({ kind: 'whole', expectedValues: { applied: [] } });
    expect(b.get(NOTIFY)?.expectedValues?.skipped[0]).toContain(why);
    const result = checkRedReports([redReport(NOTIFY, notifyTests())], [NOTIFY], ROOT, b);
    expect(result.problems.map((p) => p.test)).toEqual(NOTIFY_OTHERS);
    expect(result.notes[0]).toContain(
      `${NOTIFY}: registered expected value ${NOTIFY} / ${entry.helper}`,
    );
  }
  // A helper declared twice is ambiguous.
  const twice = NOTIFY_BASE.replace('function legacyShape()', 'function onlyAnomaly()');
  expect(applyExpectedValues(NOTIFY, twice, [DIFF_FEN]).skipped).toEqual([
    `${NOTIFY} / onlyAnomaly: "    diff_fen: AMOUNT," → "    diff_fen: -AMOUNT,": does not apply (onlyAnomaly is declared twice at the top level of the base)`,
  ]);
  // Entries of another file are ignored; the replacement is literal ($& is no pattern).
  expect(applyExpectedValues('other.test.ts', NOTIFY_BASE, [DIFF_FEN])).toEqual({
    text: NOTIFY_BASE,
    applied: [],
    skipped: [],
  });
  const literal = applyExpectedValues(NOTIFY, NOTIFY_BASE, [
    { ...DIFF_FEN, from: "'pay_anomaly'", to: "'$&$&'" },
  ]);
  expect(literal.text).toContain("type: '$&$&',");
});

it('[CT-06zxe] an entry whose value stands inside a query call of the helper, or in a tagged template, does not apply (review r1 S2-1)', () => {
  const base = [
    "import { expect, it } from 'vitest';",
    'async function open(db: Db) {',
    "  const rows = await db.selectFrom('app.pay_anomaly').where({",
    "    status: 'open',",
    '  }).execute();',
    "  const raw = await db.run(sql`select * from app.pay_anomaly where status = 'open'`);",
    '  expect(rows).toHaveLength(1);',
    '}',
    "it('[AC-1] a', async () => { await open(db); });",
  ].join('\n');
  const at = 'test/spec/q.test.ts';
  const entry = (from: string, to: string) => ({ file: at, helper: 'open', from, to });
  // The fragment alone is a property value; the whole helper shows the where( around it.
  expect(
    applyExpectedValues(at, base, [entry("    status: 'open',", "    status: 'closed',")]).skipped,
  ).toEqual([
    `${at} / open: "    status: 'open'," → "    status: 'closed',": does not apply (the change in open is not an expected value: "'open'" is changed inside a where( call (a query, not an expectation))`,
  ]);
  expect(
    applyExpectedValues(at, base, [
      entry(
        "sql`select * from app.pay_anomaly where status = 'open'`",
        'sql`select 1 where false`',
      ),
    ]).skipped[0],
  ).toContain('the change alters more than a value of open (its value skeleton differs)');
  // A matcher's expected argument still applies.
  expect(
    applyExpectedValues(at, base, [entry('toHaveLength(1)', 'toHaveLength(2)')]).applied,
  ).toHaveLength(1);
});

it('[CT-06zxh] a literal of the base naming the changed helper or a caller judges the whole file (review r2 S2-1)', () => {
  const tail = "  it('[AC-5] a wrong amount is refused'";
  for (const [label, use] of [
    ['eval', "  it('[AC-6] by eval', () => { eval('onlyAnomaly()'); });\n"],
    [
      'a dynamic import',
      "  it('[AC-6] by a key', async () => { const m = await import('./notify.int.test.ts'); await m['onlyAnomaly' as 'onlyAnomaly']({ id: 'o' }, 't'); });\n",
    ],
    ['a template', "  it('[AC-6] by a template', () => { void `onlyAnomaly`; });\n"],
    ['a regex', "  it('[AC-6] by a regex', () => { void /onlyAnomaly/; });\n"],
  ] as const) {
    const base = NOTIFY_BASE.replace(tail, `${use}${tail}`);
    const head = base.replace('    diff_fen: AMOUNT,', '    diff_fen: -AMOUNT,');
    const b = notifyBaselines(head, [DIFF_FEN], [], base).get(NOTIFY);
    expect(b, label).toMatchObject({
      kind: 'whole',
      reason: expect.stringContaining('registered expected values: a literal names "onlyAnomaly"'),
      expectedValues: { applied: [DIFF_FEN], whole: expect.stringContaining('a literal names') },
    });
    // The others must be red again, as before CT-06zxe.
    const problems = checkRedReports(
      [redReport(NOTIFY, notifyTests())],
      [NOTIFY],
      ROOT,
      notifyBaselines(head, [DIFF_FEN], [], base),
    ).problems;
    expect(
      problems.map((p) => p.test),
      label,
    ).toEqual(NOTIFY_OTHERS);
  }
  // A literal inside the changed helper itself is no call by a string.
  const inside = NOTIFY_BASE.replace(
    "type: 'pay_anomaly',",
    "type: 'pay_anomaly', note: 'onlyAnomaly',",
  );
  expect(
    notifyBaselines(
      inside.replace('    diff_fen: AMOUNT,', '    diff_fen: -AMOUNT,'),
      [DIFF_FEN],
      [],
      inside,
    ).get(NOTIFY),
  ).toMatchObject({ kind: 'tests' });
});

it('[CT-06zxh] the whole helper shows a fragment that is no expected value: a fixture input, a returned object, a non-matcher (review r2 S2-2)', () => {
  const base = [
    "import { expect, it } from 'vitest';",
    'async function open(db: Db, n: number) {',
    '  await insertOrder(db, {',
    "    status: 'open',",
    '  });',
    '  const q = {',
    "    text: 'select 1',",
    '  };',
    '  expect(n.toString(16)).toBe(x);',
    '  expect(await rows(db, q)).toMatchObject({',
    '    n: 1,',
    '  });',
    '}',
    "it('[AC-1] a', async () => { await open(db, 1); });",
  ].join('\n');
  const at = 'test/spec/q.test.ts';
  const entry = (from: string, to: string) => ({ file: at, helper: 'open', from, to });
  const refused = (from: string, to: string): string | undefined =>
    applyExpectedValues(at, base, [entry(from, to)]).skipped[0];
  expect(refused("    status: 'open',", "    status: 'closed',")).toContain(
    'stands the argument of a insertOrder( call',
  );
  expect(refused("    text: 'select 1',", "    text: 'select 2',")).toContain(
    'stands outside any expectation',
  );
  expect(refused('toString(16)', 'toString(2)')).toContain("a matcher's expected argument");
  expect(applyExpectedValues(at, base, [entry('    n: 1,', '    n: 2,')]).applied).toHaveLength(1);
});

it('[CT-06zxi] a value inside a function body called in a matcher argument does not apply: the whole file is judged (D10-388)', () => {
  const at = 'test/spec/iife.test.ts';
  const base = [
    "import { expect, it } from 'vitest';",
    'function check(actual: unknown) {',
    '  expect(actual).toEqual((() => {',
    '    const input = {',
    '      amount: 1,',
    '    };',
    '    return makeExpected(input);',
    '  })());',
    '  expect(actual).toEqual((function () {',
    '    return { fee: 3 };',
    '  })());',
    '  expect(actual).toEqual(((v: number) => ({',
    '    rate: 5,',
    '  }))(0));',
    '  expect(actual).toEqual(expect.objectContaining({',
    '    total: { fen: 7 },',
    '  }));',
    '}',
    "it('[AC-1] a', () => { check(x); });",
    "it('[AC-2] b', () => { expect(1).toBe(1); });",
  ].join('\n');
  const entry = (from: string, to: string) => ({ file: at, helper: 'check', from, to });
  const baselines = (from: string, to: string) =>
    ruleTestBaselines(
      [at],
      [{ path: at, status: 'M' }],
      ['test/spec/**'],
      reader({ [at]: base }, { [at]: base.replace(from, to) }),
      [],
      [entry(from, to)],
    );
  // The review probe (arrow block body), a function body, an arrow's expression body.
  for (const [from, to] of [
    ['      amount: 1,', '      amount: 2,'],
    ['    return { fee: 3 };', '    return { fee: 4 };'],
    ['    rate: 5,', '    rate: 6,'],
  ] as const) {
    const b = baselines(from, to);
    expect(b.get(at), from).toMatchObject({ kind: 'whole', expectedValues: { applied: [] } });
    expect(b.get(at)?.expectedValues?.skipped[0], from).toContain('inside a function body');
    const result = checkRedReports(
      [
        redReport(at, [
          ['[AC-1] a', 'failed', RED],
          ['[AC-2] b', 'passed'],
        ]),
      ],
      [at],
      ROOT,
      b,
    );
    expect(result.problems.map((p) => p.test)).toEqual(['[AC-2] b']);
  }
  // A nested object of an asymmetric matcher still applies: judged by test.
  const nested = baselines('    total: { fen: 7 },', '    total: { fen: 8 },');
  expect(nested.get(at)).toMatchObject({ kind: 'tests', expectedValues: { skipped: [] } });
  expect(nested.get(at)?.expectedValues?.applied).toHaveLength(1);
});

it('[CT-06zxe] a registered helper no test calls is void; renames run first; without entries nothing changes', () => {
  const legacy = { file: NOTIFY, helper: 'legacyShape', from: 'fen: 1n', to: 'fen: 2n' };
  const head = NOTIFY_BASE.replace('fen: 1n', 'fen: 2n');
  const b = notifyBaselines(head, [legacy]);
  expect(b.get(NOTIFY)).toMatchObject({ kind: 'tests', expectedValues: { affected: [] } });
  const result = checkRedReports([redReport(NOTIFY, notifyTests())], [NOTIFY], ROOT, b);
  expect(result.ok).toBe(false);
  expect(result.problems).toContainEqual({
    file: NOTIFY,
    test: null,
    reason:
      'the registered helper legacyShape is called by no test block: the registration is void',
  });
  // Renames first, then the entry (written as the renamed base spells it).
  const renamedBase = NOTIFY_BASE.replace("'pay_anomaly'", "'pay-anomaly'");
  const r = notifyBaselines(
    NOTIFY_HEAD,
    [DIFF_FEN],
    [{ from: "'pay-anomaly'", to: "'pay_anomaly'" }],
    renamedBase,
  );
  expect(r.get(NOTIFY)).toMatchObject({ kind: 'tests', renamed: { identical: false } });
  expect(checkRedReports([redReport(NOTIFY, notifyTests())], [NOTIFY], ROOT, r).ok).toBe(true);
  // Without the field: the same baselines as before CT-06zxe, no expectedValues anywhere.
  const read = reader({ [NOTIFY]: NOTIFY_BASE }, { [NOTIFY]: NOTIFY_HEAD });
  const changes: Change[] = [{ path: NOTIFY, status: 'M' }];
  const before = ruleTestBaselines([NOTIFY], changes, ['test/spec/payment/**'], read);
  expect(ruleTestBaselines([NOTIFY], changes, ['test/spec/payment/**'], read, [], [])).toEqual(
    before,
  );
  expect(before.get(NOTIFY)).not.toHaveProperty('expectedValues');
  // An entry of another file: no expectedValues on this one, a note for the entry.
  const other = { ...DIFF_FEN, file: 'test/spec/payment/other.int.test.ts' };
  const o = ruleTestBaselines([NOTIFY], changes, ['test/spec/payment/**'], read, [], [other]);
  expect(o).toEqual(before);
  expect(unusedExpectedValueNotes([other, DIFF_FEN], o)).toEqual([
    `registered expected value test/spec/payment/other.int.test.ts / onlyAnomaly: "    diff_fen: AMOUNT," → "    diff_fen: -AMOUNT,": not applied (test/spec/payment/other.int.test.ts is not an expected rule-test file that existed at the base and was compared test by test)`,
    `registered expected value ${NOTIFY} / onlyAnomaly: "    diff_fen: AMOUNT," → "    diff_fen: -AMOUNT,": not applied (${NOTIFY} is not an expected rule-test file that existed at the base and was compared test by test)`,
  ]);
  // The entries evidence-check wants confirmed: the ones that apply to a base, in ledger order.
  const nope = { ...DIFF_FEN, helper: 'nope' };
  expect(
    expectedValuesHit([NOTIFY, 'missing.test.ts'], read, [], [nope, legacy, DIFF_FEN]),
  ).toEqual([legacy, DIFF_FEN]);
  expect(expectedValuesHit([NOTIFY], read, [], [])).toEqual([]);
});

// CT-06zzz (D10-586, after B1-08zh): a kit that loads by a computed name made every changed sibling
// rule-test file a possible read, so every unchanged test of the directory had to be red.
const ZZZ_A = 'test/spec/z/a.int.test.ts';
const ZZZ_B = 'test/spec/z/b.int.test.ts';
const ZZZ_KIT = 'test/spec/z/kit.ts';
const zzzKit = 'export const load = async (name: string) => await import(`./${name}`);\n';
const zzzFile = (extra: string, body: string): string =>
  `import { it, expect } from 'vitest';\nimport { load } from './kit.ts';\n${extra}` +
  `it('kept', async () => { expect(await load('x')).toBe(1); });\n` +
  `it('changed', () => { expect(${body}).toBe(1); });\n`;

it('[AC-CT-06zzz#2] a kit with a computed import: a changed sibling rule test does not make the file whole, its unchanged test stays exempt', () => {
  const base = { [ZZZ_A]: zzzFile('', '1'), [ZZZ_B]: zzzFile('', '1'), [ZZZ_KIT]: zzzKit };
  const head = { ...base, [ZZZ_A]: zzzFile('', '2 - 1'), [ZZZ_B]: zzzFile('', '3 - 2') };
  const changes: Change[] = [
    { path: ZZZ_A, status: 'M' },
    { path: ZZZ_B, status: 'M' },
  ];
  const b = ruleTestBaselines([ZZZ_A, ZZZ_B], changes, ['test/spec/z/**'], reader(base, head));
  expect(b.get(ZZZ_A)?.kind).toBe('tests');
  expect(b.get(ZZZ_B)?.kind).toBe('tests');
});

it('[AC-CT-06zzz#3] a rule test that explicitly imports a changed sibling rule test is still judged as a whole', () => {
  const importing = "import './b.int.test.ts';\n";
  const base = { [ZZZ_A]: zzzFile(importing, '1'), [ZZZ_B]: zzzFile('', '1'), [ZZZ_KIT]: zzzKit };
  const head = { ...base, [ZZZ_A]: zzzFile(importing, '2 - 1'), [ZZZ_B]: zzzFile('', '3 - 2') };
  const changes: Change[] = [
    { path: ZZZ_A, status: 'M' },
    { path: ZZZ_B, status: 'M' },
  ];
  const b = ruleTestBaselines([ZZZ_A, ZZZ_B], changes, ['test/spec/z/**'], reader(base, head));
  expect(b.get(ZZZ_A)).toMatchObject({
    kind: 'support',
    reason: `it may read a test-support file the task changed: it loads ${ZZZ_B}`,
  });
  expect(b.get(ZZZ_B)?.kind).toBe('tests');
});

it('[AC-CT-06zzz#4] helpers keep the conservative rules: a changed kit or data file is still a possible read through a computed import', () => {
  const data = 'test/spec/z/data.json';
  const base = {
    [ZZZ_A]: zzzFile('', '1'),
    [ZZZ_B]: zzzFile('', '1'),
    [ZZZ_KIT]: zzzKit,
    [data]: '{}',
  };
  const head = { ...base, [ZZZ_A]: zzzFile('', '2 - 1'), [data]: '{"a":1}' };
  const changes: Change[] = [
    { path: ZZZ_A, status: 'M' },
    { path: data, status: 'M' },
  ];
  const b = ruleTestBaselines([ZZZ_A], changes, ['test/spec/z/**'], reader(base, head));
  expect(b.get(ZZZ_A)?.kind).toBe('support');
  // A sibling rule test the task did not put in the expected list is an ordinary support file.
  const outside = ruleTestBaselines(
    [ZZZ_A],
    [
      { path: ZZZ_A, status: 'M' },
      { path: ZZZ_B, status: 'M' },
    ],
    ['test/spec/z/**'],
    reader(base, { ...head, [ZZZ_B]: zzzFile('', '3 - 2') }),
  );
  expect(outside.get(ZZZ_A)?.kind).toBe('support');
});

// CT-06zzzc (D10-623, after F1-02zzzb): red_exempt_outside lets the declared exemptions of a file
// whose code outside the tests changed apply to its unchanged tests.
const CFG = 'test/spec/content/config/delivery.int.test.ts';
const CFG_BASE = [
  "import { describe, expect, it } from 'vitest';",
  "import { a } from './a.ts';",
  '',
  'const GROUPS = [',
  "  ['alpha', 1],",
  "  ['bridge_origins', 2],",
  "  ['gamma', 3],",
  '];',
  '',
  "describe('cfg', () => {",
  "  it('[AC-1] one', () => {",
  '    expect(a(1)).toBe(1);',
  '  });',
  '',
  '  for (const [name, n] of GROUPS) {',
  '    it(`[AC-2] group ${name}`, () => {',
  '      expect(a(n)).toBe(n);',
  '    });',
  '  }',
  '',
  "  it('[AC-3] three', () => {",
  '    expect(a(3)).toBe(3);',
  '  });',
  '',
  "  it('[AC-4] four', () => {",
  '    expect(a(4)).toBe(4);',
  '  });',
  '});',
  '',
].join('\n');
/** F1-02zzzb's shape: an import added, a row group taken out of the table, [AC-4] changed, [AC-5] new. */
const CFG_HEAD = CFG_BASE.replace(
  "import { a } from './a.ts';",
  "import { a } from './a.ts';\nimport { sign } from './sign.ts';",
)
  .replace("  ['bridge_origins', 2],\n", '')
  .replace('expect(a(4)).toBe(4);', 'expect(sign(a(4))).toBe(4);')
  .replace(
    /\n\}\);\n$/,
    "\n\n  it('[AC-5] five', () => {\n    expect(sign(5)).toBe(5);\n  });\n});\n",
  );
const CFG_REASON = 'the import and the bridge_origins group follow the new contract';
const CFG_OUTSIDE = [{ file: CFG, reason: CFG_REASON }];
const cfgBaselines = (
  head = CFG_HEAD,
  outside: { file: string; reason: string }[] = CFG_OUTSIDE,
  base = CFG_BASE,
  file = CFG,
) =>
  ruleTestBaselines(
    [file],
    [{ path: file, status: 'M' }],
    ['test/spec/content/**'],
    reader({ [file]: base }, { [file]: head }),
    [],
    [],
    outside,
  );
const CFG_UNCHANGED = [
  'cfg > [AC-1] one',
  'cfg > [AC-2] group alpha',
  'cfg > [AC-2] group gamma',
  'cfg > [AC-3] three',
];
const cfgTests = (green: string[] = CFG_UNCHANGED): RedTest[] =>
  [...CFG_UNCHANGED, 'cfg > [AC-4] four', 'cfg > [AC-5] five'].map((n) =>
    green.includes(n) ? [n, 'passed'] : [n, 'failed', 'AssertionError: x'],
  );
const cfgDeclared = (tests: string[] = CFG_UNCHANGED) =>
  tests.map((test) => ({ file: CFG, test, reason: REASON }));
const CFG_LINES = 'L3, L7';

it('[CT-06zzzc] a file not listed in red_exempt_outside: judged as a whole as before, its declarations do not apply', () => {
  const b = cfgBaselines(CFG_HEAD, []);
  expect(b.get(CFG)).toEqual({
    kind: 'whole',
    reason:
      'code outside the tests changed (imports, helpers, hooks, top-level tables or describe titles)',
  });
  const result = checkRedReports([redReport(CFG, cfgTests())], [CFG], ROOT, b, cfgDeclared());
  expect(result.ok).toBe(false);
  expect(result.problems.map((p) => p.test)).toEqual(CFG_UNCHANGED);
  expect(result.exempt).toEqual([]);
  expect(result.notes).toEqual([
    `${CFG}: existed at the base, judged as a whole (every test must be red): code outside the tests changed (imports, helpers, hooks, top-level tables or describe titles)`,
    `${CFG}: 4 declared exemption(s) do not apply: code outside the tests changed (imports, helpers, hooks, top-level tables or describe titles) (a declaration applies only to a file judged as a whole because it may read a changed test-support file)`,
  ]);
  // Listing another file changes nothing for this one.
  expect(
    cfgBaselines(CFG_HEAD, [{ file: 'test/spec/content/x.test.ts', reason: CFG_REASON }]),
  ).toEqual(b);
});

it('[CT-06zzzc] listed: the declared unchanged tests may pass, the changed and new ones must be red, the notes give the changed lines', () => {
  const b = cfgBaselines();
  expect(b.get(CFG)).toMatchObject({
    kind: 'support',
    reason: `its code outside the tests changed at ${CFG_LINES} (declared in red_exempt_outside, D10-623)`,
    outside: { reason: CFG_REASON, lines: CFG_LINES },
  });
  const result = checkRedReports([redReport(CFG, cfgTests())], [CFG], ROOT, b, cfgDeclared());
  expect(result.problems).toEqual([]);
  expect(result.ok).toBe(true);
  expect(result.red).toEqual([`${CFG} > cfg > [AC-4] four`, `${CFG} > cfg > [AC-5] five`]);
  expect(result.exempt).toEqual(
    CFG_UNCHANGED.map((test) => ({
      file: CFG,
      test,
      status: 'passed',
      declared: true,
      reason: REASON,
    })),
  );
  expect(result.notes.slice(0, 2)).toEqual([
    `${CFG}: code outside the tests changed at ${CFG_LINES} (head lines; a removal is shown at the lines around it), declared in red_exempt_outside (D10-623; reason: ${CFG_REASON}): the ledger's red_exempt declarations apply to its unchanged tests; the rule-test reviewer confirms these changes with the exemptions (evidence spec_test_review.red_exempt_confirmed) and the orchestrator checks them one by one`,
    `${CFG}: existed at the base, judged as a whole except the tests the ledger declares exempt (every other test must be red): its code outside the tests changed at ${CFG_LINES} (declared in red_exempt_outside, D10-623)`,
  ]);
  // A changed or a new test green on the skeleton has no teeth, declared or not.
  const green = checkRedReports(
    [redReport(CFG, cfgTests([...CFG_UNCHANGED, 'cfg > [AC-4] four', 'cfg > [AC-5] five']))],
    [CFG],
    ROOT,
    b,
    cfgDeclared([...CFG_UNCHANGED, 'cfg > [AC-4] four']),
  );
  expect(green.problems.map((p) => p.test)).toEqual(['cfg > [AC-4] four', 'cfg > [AC-5] five']);
  expect(green.notes).toContain(
    `${CFG} > cfg > [AC-4] four: declared exempt, but the declaration does not apply: the test is new or changed since the base (only an unchanged test may be declared exempt); the test must be red`,
  );
  // An unchanged test that is not declared must still be red.
  const undeclared = checkRedReports(
    [redReport(CFG, cfgTests())],
    [CFG],
    ROOT,
    b,
    cfgDeclared(CFG_UNCHANGED.slice(1)),
  );
  expect(undeclared.problems).toEqual([
    {
      file: CFG,
      test: 'cfg > [AC-1] one',
      reason:
        'green on the skeleton: the test has no teeth (the file may read a test-support file the task changed and the ledger does not declare this test exempt)',
    },
  ]);
});

it('[CT-06zzzc] listed: a declared test whose own block changed still fails; so do a moved one and a file whose every test is declared', () => {
  const own = CFG_HEAD.replace('expect(a(1)).toBe(1);', 'expect(a(1)).toBe(2);');
  const changed = checkRedReports(
    [redReport(CFG, cfgTests())],
    [CFG],
    ROOT,
    cfgBaselines(own),
    cfgDeclared(),
  );
  expect(changed.problems.map((p) => p.test)).toEqual(['cfg > [AC-1] one']);
  // [AC-3] wrapped in a new branch: changed, though its text is the base's.
  const wrapped = CFG_HEAD.replace(
    "  it('[AC-3] three', () => {\n    expect(a(3)).toBe(3);\n  });",
    "  if (a(0)) {\n  it('[AC-3] three', () => {\n    expect(a(3)).toBe(3);\n  });\n  }",
  );
  expect(
    checkRedReports(
      [redReport(CFG, cfgTests())],
      [CFG],
      ROOT,
      cfgBaselines(wrapped),
      cfgDeclared(),
    ).problems.map((p) => p.test),
  ).toEqual(['cfg > [AC-3] three']);
  // No changed or new test left and every test declared: nothing is shown red.
  const only = CFG_BASE.replace(
    "import { a } from './a.ts';",
    "import { a } from './a.ts';\nimport { sign } from './sign.ts';",
  );
  const all = [...CFG_UNCHANGED, 'cfg > [AC-2] group bridge_origins', 'cfg > [AC-4] four'];
  const every = checkRedReports(
    [
      redReport(
        CFG,
        all.map((n) => [n, 'passed'] as RedTest),
      ),
    ],
    [CFG],
    ROOT,
    cfgBaselines(only),
    cfgDeclared(all),
  );
  expect(every.ok).toBe(false);
  expect(every.problems).toEqual([
    {
      file: CFG,
      test: null,
      reason:
        'existed at the base and every test is declared exempt: nothing is shown red (6 test(s); evidence-check wants a red test of every expected file)',
    },
  ]);
});

it('[CT-06zzzc] listed but not comparable (unreadable, JSX, not the red reporter, nothing changed outside): the listing does not apply', () => {
  const broken = checkRedReports(
    [redReport(CFG, cfgTests())],
    [CFG],
    ROOT,
    cfgBaselines(`${CFG_HEAD}\nconst s = 'open`),
    cfgDeclared(),
  );
  expect(broken.problems.map((p) => p.test)).toEqual(CFG_UNCHANGED);
  expect(broken.notes[0]).toMatch(
    new RegExp(
      `^${CFG.replace(/[.]/g, '\\.')}: declared in red_exempt_outside, but the declaration does not apply: the file is judged as a whole for another reason: the file cannot be read as tests`,
    ),
  );
  const JSX = 'test/spec/content/config/page.test.tsx';
  const jsx = cfgBaselines(CFG_HEAD, [{ file: JSX, reason: CFG_REASON }], CFG_BASE, JSX);
  expect(jsx.get(JSX)).toMatchObject({ kind: 'whole', outside: { reason: CFG_REASON } });
  const jsxResult = checkRedReports([redReport(JSX, cfgTests())], [JSX], ROOT, jsx, []);
  expect(jsxResult.notes[0]).toBe(
    `${JSX}: declared in red_exempt_outside, but the declaration does not apply: the file is judged as a whole for another reason: only .ts / .js rule-test files are compared test by test (JSX is not read)`,
  );
  const plain = checkRedReports(
    [redReport(CFG, cfgTests(), 'vitest-json')],
    [CFG],
    ROOT,
    cfgBaselines(),
    cfgDeclared(),
  );
  expect(plain.problems.map((p) => p.test)).toEqual(CFG_UNCHANGED);
  expect(plain.notes).toContain(
    `${CFG}: 4 declared exemption(s) do not apply: the report is not from the red reporter (a declaration applies only to a file judged as a whole because it may read a changed test-support file)`,
  );
  // Nothing changed outside the tests: judged test by test, the listing is not needed.
  const inside = CFG_BASE.replace('expect(a(4)).toBe(4);', 'expect(a(4)).toBe(5);');
  const tests = cfgBaselines(inside);
  expect(tests.get(CFG)).toMatchObject({
    kind: 'tests',
    outside: {
      reason: CFG_REASON,
      void: "its code outside the tests is the base's (nothing to declare)",
    },
  });
  // A listed file that is not expected: said in the notes.
  expect(
    unusedOutsideNotes(
      [...CFG_OUTSIDE, { file: 'test/spec/content/y.test.ts', reason: CFG_REASON }],
      tests,
    ),
  ).toEqual([
    'red_exempt_outside test/spec/content/y.test.ts: not applied (not an expected rule-test file that existed at the base)',
  ]);
});

it('[CT-06zzzc] with renames and registered expected values: they apply first; a listed file still differing is compared leniently, callers of a changed helper must be red', () => {
  // Renames first: a rename that explains the only difference outside the tests needs no listing.
  const renamedHead = CFG_BASE.replace("'bridge_origins'", "'bridge-origins'");
  const renamed = ruleTestBaselines(
    [CFG],
    [{ path: CFG, status: 'M' }],
    ['test/spec/content/**'],
    reader({ [CFG]: CFG_BASE }, { [CFG]: renamedHead.replace('toBe(4);', 'toBe(5);') }),
    [{ from: "'bridge_origins'", to: "'bridge-origins'" }],
    [],
    CFG_OUTSIDE,
  );
  expect(renamed.get(CFG)).toMatchObject({ kind: 'tests', outside: { void: expect.any(String) } });
  // Registered expected values next: NOTIFY with an import added as well.
  const head = NOTIFY_HEAD.replace(
    "import { describe, expect, it } from 'vitest';",
    "import { describe, expect, it } from 'vitest';\nimport { sign } from './sign.ts';",
  );
  expect(head).not.toBe(NOTIFY_HEAD);
  const without = notifyBaselines(head);
  expect(without.get(NOTIFY)?.kind).toBe('whole');
  const listed = ruleTestBaselines(
    [NOTIFY],
    [{ path: NOTIFY, status: 'M' }],
    ['test/spec/payment/**'],
    reader({ [NOTIFY]: NOTIFY_BASE }, { [NOTIFY]: head }),
    [],
    [DIFF_FEN],
    [{ file: NOTIFY, reason: CFG_REASON }],
  );
  const line = head.split('\n').indexOf("import { sign } from './sign.ts';") + 1;
  // The inserted import (the alignment may take the next line's `import` for the new one).
  expect(listed.get(NOTIFY)).toMatchObject({
    kind: 'support',
    outside: { lines: `L${line}-${line + 1}` },
    expectedValues: { applied: [DIFF_FEN] },
  });
  expect(listed.get(NOTIFY)).not.toHaveProperty('expectedValues.whole');
  // Every test declared: the callers of onlyAnomaly still must be red, the others may pass.
  const all = [...NOTIFY_OTHERS, ...NOTIFY_CALLERS].map((test) => ({
    file: NOTIFY,
    test,
    reason: REASON,
  }));
  const ok = checkRedReports([redReport(NOTIFY, notifyTests())], [NOTIFY], ROOT, listed, all);
  expect(ok.problems).toEqual([]);
  expect(ok.exempt?.map((e) => e.test)).toEqual(NOTIFY_OTHERS);
  const green = checkRedReports(
    [redReport(NOTIFY, notifyTests([...NOTIFY_OTHERS, NOTIFY_CALLERS[0] as string]))],
    [NOTIFY],
    ROOT,
    listed,
    all,
  );
  expect(green.problems.map((p) => p.test)).toEqual([NOTIFY_CALLERS[0]]);
});

it('[CT-06zzzc] listed: a declared test inside do { … } while (cond) whose condition changed must be red; unchanged it may pass (Codex review r1 S2)', () => {
  const loop = (cond: string, head: string): string =>
    head.replace(
      "  it('[AC-3] three', () => {\n    expect(a(3)).toBe(3);\n  });",
      `  let n = 0;\n  do {\n  it('[AC-3] three', () => {\n    expect(a(3)).toBe(3);\n  });\n    n += 1;\n  } while (${cond});`,
    );
  const base = loop('n < 2', CFG_BASE);
  const run = (cond: string) =>
    checkRedReports(
      [redReport(CFG, cfgTests())],
      [CFG],
      ROOT,
      cfgBaselines(loop(cond, CFG_HEAD), CFG_OUTSIDE, base),
      cfgDeclared(),
    );
  const changed = run('n < 3');
  expect(changed.problems.map((p) => `${p.test}: ${p.reason}`)).toEqual([
    'cfg > [AC-3] three: green on the skeleton: the test has no teeth (the file may read a test-support file the task changed and the ledger does not declare this test exempt)',
  ]);
  expect(changed.notes).toContain(
    `${CFG} > cfg > [AC-3] three: declared exempt, but the declaration does not apply: the test is new or changed since the base (only an unchanged test may be declared exempt); the test must be red`,
  );
  expect(run('n < 2').ok).toBe(true);
});

// CT-06zzzd (D10-629 / D10-630, after F1-02zzzb's config-etag/domain.int.test.ts): a listed file
// whose every test is unchanged and declared is left out of the expected list.
const ETAG = 'test/spec/content/config-etag/domain.int.test.ts';
const ETAG_BASE = [
  "import { describe, expect, it } from 'vitest';",
  "import { configEtag } from './etag.ts';",
  '',
  "const data = () => ({ bridge_origins: ['a'] });",
  '',
  "it('[AC-30] normalises keys', () => {",
  '  expect(configEtag(data())).toBe(configEtag(data()));',
  '});',
  '',
  "describe('order', () => {",
  "  it('[AC-31] keeps arrays', () => {",
  '    expect(configEtag([1, 2])).not.toBe(configEtag([2, 1]));',
  '  });',
  '',
  '  it.each([',
  "    ['x', 1],",
  "    ['y', 2],",
  "  ])('[AC-32] case %s', (k, n) => {",
  "    expect(configEtag({ [k]: n })).toBeTypeOf('string');",
  '  });',
  '});',
  '',
].join('\n');
/** The F1-02zzzb shape: an import for a contract type and a signed fixture value; no test touched. */
const ETAG_HEAD = ETAG_BASE.replace(
  "import { configEtag } from './etag.ts';",
  "import { configEtag } from './etag.ts';\nimport { signedFixture } from './sign.ts';",
).replace("bridge_origins: ['a']", 'bridge_origins: signedFixture()');
const ETAG_TESTS = [
  '[AC-30] normalises keys',
  'order > [AC-31] keeps arrays',
  'order > [AC-32] case x',
  'order > [AC-32] case y',
];
const ETAG_REASON = 'the contract type needs the import and a signed fixture value';
const ETAG_OUTSIDE = [{ file: ETAG, reason: ETAG_REASON }];
const etagDeclared = (tests: string[] = ETAG_TESTS) =>
  tests.map((test) => ({ file: ETAG, test, reason: REASON }));
const etagRead = (head = ETAG_HEAD) => reader({ [ETAG]: ETAG_BASE }, { [ETAG]: head });
const etagBaselines = (head = ETAG_HEAD, outside = ETAG_OUTSIDE) =>
  ruleTestBaselines(
    [ETAG],
    [{ path: ETAG, status: 'M' }],
    ['test/spec/content/**'],
    etagRead(head),
    [],
    [],
    outside,
  );
const etagReport = (green: string[] = ETAG_TESTS) =>
  redReport(
    ETAG,
    ETAG_TESTS.map((n) => (green.includes(n) ? [n, 'passed'] : [n, 'failed', 'AssertionError: x'])),
  );

it('[CT-06zzzd] listed, every test unchanged and declared: left out of the expected list (not run, not judged), the note says why', () => {
  const left = outsideOnlyFiles([ETAG], etagRead(), [], [], ETAG_OUTSIDE, etagDeclared());
  expect(left).toEqual([{ file: ETAG, lines: 'L3, L5', reason: ETAG_REASON, tests: 4 }]);
  expect(outsideOnlyNote(left[0] as (typeof left)[number])).toBe(
    `${ETAG}: all 4 tests unchanged and declared exempt; allowed because the file is declared in red_exempt_outside (D10-629 / D10-630; reason: ${ETAG_REASON}), left out of the expected list (not run, not judged): nothing in it is shown red; code outside the tests changed at L3, L5 (head lines; a removal is shown at the lines around it); the rule-test reviewer confirms these changes with the exemptions (evidence spec_test_review.red_exempt_confirmed) and the orchestrator checks them one by one (#24)`,
  );
  // Without the listing nothing is left out.
  expect(outsideOnlyFiles([ETAG], etagRead(), [], [], [], etagDeclared())).toEqual([]);
});

it('[CT-06zzzd] not listed: unchanged; every test declared still fails with the same problem', () => {
  expect(outsideOnlyFiles([ETAG], etagRead(), [], [], [], etagDeclared())).toEqual([]);
  const notListed = checkRedReports(
    [etagReport()],
    [ETAG],
    ROOT,
    etagBaselines(ETAG_HEAD, []),
    etagDeclared(),
  );
  expect(notListed.problems.map((p) => p.test)).toEqual(ETAG_TESTS);
  expect(notListed.notes).toContain(
    `${ETAG}: 4 declared exemption(s) do not apply: code outside the tests changed (imports, helpers, hooks, top-level tables or describe titles) (a declaration applies only to a file judged as a whole because it may read a changed test-support file)`,
  );
  // Not listed, every test declared, only a support file changed (CT-06r): the same failure.
  const support = ruleTestBaselines(
    [ETAG],
    [
      { path: ETAG, status: 'M' },
      { path: 'test/spec/content/config-etag/etag.ts', status: 'M' },
    ],
    ['test/spec/content/**'],
    reader(
      { [ETAG]: ETAG_BASE },
      { [ETAG]: ETAG_BASE, 'test/spec/content/config-etag/etag.ts': 'export {};\n' },
    ),
  );
  const every = checkRedReports([etagReport()], [ETAG], ROOT, support, etagDeclared());
  expect(every.problems).toEqual([
    {
      file: ETAG,
      test: null,
      reason:
        'existed at the base and every test is declared exempt: nothing is shown red (4 test(s); evidence-check wants a red test of every expected file)',
    },
  ]);
});

it('[CT-06zzzd] listed with a new or a changed test, or a declared test that changed: not left out; those tests must be red', () => {
  const added = ETAG_HEAD.replace(
    '\n});\n',
    "\n\n  it('[AC-33] new', () => {\n    expect(1).toBe(1);\n  });\n});\n",
  );
  expect(added).not.toBe(ETAG_HEAD);
  expect(outsideOnlyFiles([ETAG], etagRead(added), [], [], ETAG_OUTSIDE, etagDeclared())).toEqual(
    [],
  );
  // A declared test whose own block changed: not left out, it must be red (green is a problem).
  const changed = ETAG_HEAD.replace('not.toBe(configEtag([2, 1]))', 'toBe(configEtag([2, 1]))');
  expect(outsideOnlyFiles([ETAG], etagRead(changed), [], [], ETAG_OUTSIDE, etagDeclared())).toEqual(
    [],
  );
  const result = checkRedReports(
    [etagReport()],
    [ETAG],
    ROOT,
    etagBaselines(changed),
    etagDeclared(),
  );
  expect(result.problems.map((p) => p.test)).toEqual(['order > [AC-31] keeps arrays']);
  expect(result.notes).toContain(
    `${ETAG} > order > [AC-31] keeps arrays: declared exempt, but the declaration does not apply: the test is new or changed since the base (only an unchanged test may be declared exempt); the test must be red`,
  );
  // Red for a valid reason, it passes (the file stays expected and is judged).
  expect(
    checkRedReports(
      [etagReport(ETAG_TESTS.filter((t) => t !== 'order > [AC-31] keeps arrays'))],
      [ETAG],
      ROOT,
      etagBaselines(changed),
      etagDeclared(),
    ).ok,
  ).toBe(true);
});

it('[CT-06zzzd] listed but not every test certainly declared: a missing case, a table by name, a loop, a modifier, a declaration matching two blocks', () => {
  const left = (head: string, declared = etagDeclared()) =>
    outsideOnlyFiles([ETAG], etagRead(head), [], [], ETAG_OUTSIDE, declared);
  // One case of the .each table not declared.
  expect(left(ETAG_HEAD, etagDeclared(ETAG_TESTS.slice(0, 3)))).toEqual([]);
  // A declaration with a short reason.
  expect(
    left(ETAG_HEAD, [
      ...etagDeclared(ETAG_TESTS.slice(1)),
      declare(ETAG_TESTS[0] as string, 'short', ETAG),
    ]),
  ).toEqual([]);
  // The same edit on bases where the number of tests cannot be told for certain.
  const variant = (from: string, to: string) => {
    const base = ETAG_BASE.replace(from, to);
    const head = ETAG_HEAD.replace(from, to);
    expect(head).not.toBe(ETAG_HEAD);
    return outsideOnlyFiles(
      [ETAG],
      reader({ [ETAG]: base }, { [ETAG]: head }),
      [],
      [],
      ETAG_OUTSIDE,
      etagDeclared(),
    );
  };
  expect(variant("  it.each([\n    ['x', 1],\n    ['y', 2],\n  ])", '  it.each(ROWS)')).toEqual([]);
  expect(variant("    ['y', 2],\n", '    ...MORE,\n')).toEqual([]);
  // Split so that this file holds no modifier literal (test-guard no-skip-only).
  expect(variant("it('[AC-30]", `it.${'skipIf'}(a)('[AC-30]`)).toEqual([]);
  expect(variant("describe('order', () => {", "describe.each([1])('order', () => {")).toEqual([]);
  expect(
    variant(
      "it('[AC-30] normalises keys', () => {\n  expect(configEtag(data())).toBe(configEtag(data()));\n});",
      "for (const k of [1]) {\n  it('[AC-30] normalises keys', () => {\n    expect(k).toBe(1);\n  });\n}",
    ),
  ).toEqual([]);
  expect(variant("it('[AC-30]", "if (a) it('[AC-30]")).toEqual([]);
  // The control: the plain shape is left out.
  expect(left(ETAG_HEAD)).toHaveLength(1);
});

it('[CT-06zzzd] Codex review r1 S1: a name in the .each array (a top-level const changed, the block text the same): not left out', () => {
  const CODEX = 'test/spec/content/codex-s1.int.test.ts';
  const source = (value: string): string =>
    [
      "import { expect, it } from 'vitest';",
      `const value = '${value}';`,
      "it.each(['x', value])('[AC-1] case %s', (v) => {",
      "  expect(typeof v).toBe('string');",
      '});',
      '',
    ].join('\n');
  const declared = ['[AC-1] case x', '[AC-1] case y'].map((test) => ({
    file: CODEX,
    test,
    reason: REASON,
  }));
  const left = outsideOnlyFiles(
    [CODEX],
    reader({ [CODEX]: source('y') }, { [CODEX]: source('z') }),
    [],
    [],
    [{ file: CODEX, reason: ETAG_REASON }],
    declared,
  );
  expect(left).toEqual([]);
});

it('[CT-06zzzd] .each of literals: exact full names declared → left out; one missing, one extra or a wrong name → not; an unknown placeholder → not', () => {
  const run = (head: string, declared = etagDeclared(), base = ETAG_BASE) =>
    outsideOnlyFiles(
      [ETAG],
      reader({ [ETAG]: base }, { [ETAG]: head }),
      [],
      [],
      ETAG_OUTSIDE,
      declared,
    );
  expect(run(ETAG_HEAD)).toHaveLength(1);
  // One missing, one extra, a wrong name (a wildcard-like prefix match is not enough).
  expect(run(ETAG_HEAD, etagDeclared(ETAG_TESTS.slice(1)))).toEqual([]);
  expect(run(ETAG_HEAD, etagDeclared([...ETAG_TESTS, 'order > [AC-32] case z']))).toEqual([]);
  expect(
    run(ETAG_HEAD, etagDeclared([...ETAG_TESTS.slice(0, 3), 'outer > order > [AC-32] case y'])),
  ).toEqual([]);
  // Placeholders: %# / %$ / %d / %i are formatted exactly; %o, %j, %f, %%, $name are not certain.
  const titled = (title: string, rows = "[\n    ['x', 1],\n    ['y', 2],\n  ]") => {
    const swap = (src: string) =>
      src
        .replace("'[AC-32] case %s'", `'${title}'`)
        .replace("[\n    ['x', 1],\n    ['y', 2],\n  ]", rows);
    return { base: swap(ETAG_BASE), head: swap(ETAG_HEAD) };
  };
  const named = (title: string, names: string[], rows?: string) => {
    const { base, head } = titled(title, rows);
    return run(head, etagDeclared([...ETAG_TESTS.slice(0, 2), ...names]), base);
  };
  expect(
    named('[AC-32] %# %$ %s=%d', ['order > [AC-32] 0 1 x=1', 'order > [AC-32] 1 2 y=2']),
  ).toHaveLength(1);
  expect(
    named(
      '[AC-32] %s %i',
      ['order > [AC-32] -1.5 7', 'order > [AC-32] true 0'],
      '[[-1.5, 7], [true, -0]]',
    ),
  ).toHaveLength(1);
  for (const unknown of [
    '[AC-32] %o',
    '[AC-32] %j',
    '[AC-32] %f',
    '[AC-32] 100%% %s',
    '[AC-32] $0',
  ]) {
    expect(named(unknown, ['order > [AC-32] x', 'order > [AC-32] y']), unknown).toEqual([]);
  }
  // %i of a non-integer, %d of a string, more placeholders than items: not certain.
  expect(named('[AC-32] %i', ['order > [AC-32] 1', 'order > [AC-32] 2'], '[1.5, 2]')).toEqual([]);
  expect(named('[AC-32] %d', ['order > [AC-32] NaN', 'order > [AC-32] 2'], "['a', 2]")).toEqual([]);
  expect(
    named(
      '[AC-32] %s %s',
      ['order > [AC-32] x undefined', 'order > [AC-32] y undefined'],
      "['x', 'y']",
    ),
  ).toEqual([]);
  // Rows with an object, a call, a nested array, a `${}` template: not certain.
  for (const rows of [
    '[{ a: 1 }, { a: 2 }]',
    "[f('x'), 'y']",
    "[[['x']], ['y']]",
    '[`${a}`, `y`]',
  ]) {
    expect(named('[AC-32] %s', ['order > [AC-32] x', 'order > [AC-32] y'], rows), rows).toEqual([]);
  }
  // A plain test whose title is a template with ${…}: not certain.
  const tpl = ETAG_HEAD.replace("it('[AC-30] normalises keys'", 'it(`[AC-30] ${KIND}`');
  expect(
    run(
      tpl,
      etagDeclared(),
      ETAG_BASE.replace("it('[AC-30] normalises keys'", 'it(`[AC-30] ${KIND}`'),
    ),
  ).toEqual([]);
});

it('[CT-06zzzd] object rows with $name: literal title fields give exact names (other fields may be code); a field that is a name, missing or a path does not; long strings truncate as Vitest does', () => {
  const OBJ = 'test/spec/content/object-rows.int.test.ts';
  const source = (rows: string, title = '[AC-1] $label：结果 $hit', extra = ''): string =>
    [
      "import { expect, it } from 'vitest';",
      "import { ETAG } from './etag.ts';",
      extra,
      `it.each([\n${rows}\n])('${title}', ({ header, hit }) => {`,
      '  expect(Boolean(header)).toBe(hit);',
      '});',
      '',
    ].join('\n');
  const ROWS = [
    "  { label: '精确', header: ETAG, hit: true },",
    "  { label: '弱', header: `W/${ETAG}`, hit: true },",
    "  { label: '裸', header: ETAG.slice(1, -1), hit: false },",
    "  { label: '空', header: '', hit: null },",
    "  { label: 'n', header: f(), hit: -0 },",
  ].join('\n');
  const NAMES = [
    '[AC-1] 精确：结果 true',
    '[AC-1] 弱：结果 true',
    '[AC-1] 裸：结果 false',
    '[AC-1] 空：结果 null',
    '[AC-1] n：结果 -0',
  ];
  const run = (base: string, head: string, names: string[]) =>
    outsideOnlyFiles(
      [OBJ],
      reader({ [OBJ]: base }, { [OBJ]: head }),
      [],
      [],
      [{ file: OBJ, reason: ETAG_REASON }],
      names.map((test) => ({ file: OBJ, test, reason: REASON })),
    );
  const edit = (src: string) =>
    src.replace(
      "import { ETAG } from './etag.ts';",
      "import { ETAG } from './etag.ts';\nimport type { T } from './t.ts';",
    );
  // Literal $label / $hit, the other fields code: exact names, left out when declared exactly.
  expect(run(source(ROWS), edit(source(ROWS)), NAMES)).toHaveLength(1);
  expect(run(source(ROWS), edit(source(ROWS)), NAMES.slice(1))).toEqual([]);
  // Codex's case with objects: $label is a name (a top-level const the task changed).
  const named = ROWS.replace("label: '精确'", 'label: value');
  expect(
    run(
      source(named, undefined, "const value = 'y';"),
      edit(source(named, undefined, "const value = 'z';")),
      ['[AC-1] y：结果 true', ...NAMES.slice(1)],
    ),
  ).toEqual([]);
  // A shorthand field, a `${}` template, a field missing in one row, a path, a % placeholder.
  for (const rows of [
    ROWS.replace("label: '精确',", 'label,'),
    ROWS.replace("label: '精确'", 'label: `${ETAG}`'),
    ROWS.replace("label: '精确', ", ''),
  ]) {
    expect(run(source(rows), edit(source(rows)), NAMES), rows).toEqual([]);
  }
  expect(
    run(source(ROWS, '[AC-1] $label.x'), edit(source(ROWS, '[AC-1] $label.x')), NAMES),
  ).toEqual([]);
  expect(
    run(source(ROWS, '[AC-1] $label %s'), edit(source(ROWS, '[AC-1] $label %s')), NAMES),
  ).toEqual([]);
  // %# with object rows and $name: known.
  expect(
    run(source(ROWS, '[AC-1] %# $label'), edit(source(ROWS, '[AC-1] %# $label')), [
      '[AC-1] 0 精确',
      '[AC-1] 1 弱',
      '[AC-1] 2 裸',
      '[AC-1] 3 空',
      '[AC-1] 4 n',
    ]),
  ).toHaveLength(1);
  // A string longer than 40 characters: truncated to 39 and "…" (truncateString).
  const long = 'a'.repeat(45);
  const longRows = ROWS.replace("label: '精确'", `label: '${long}'`);
  const truncated = ['[AC-1] ' + 'a'.repeat(39) + '…：结果 true', ...NAMES.slice(1)];
  expect(run(source(longRows), edit(source(longRows)), truncated)).toHaveLength(1);
  expect(
    run(source(longRows), edit(source(longRows)), [`[AC-1] ${long}：结果 true`, ...NAMES.slice(1)]),
  ).toEqual([]);
});

// CT-06zzze (D10-657, after B1-05zc): red_exempt_rows lets the declared kept rows of a split .each
// table pass when the table is the base's with rows removed only.
const ROWS = 'test/spec/z/rows.test.ts';
const ROWS_TABLE = [
  "it.each(['feed', 'pool', 'search', null])(",
  "  '[AC-8] source %s inherits',",
  '  async (source) => {',
  '    expect(await f(source)).toBe(1);',
  '  },',
  ');',
].join('\n');
const ROWS_ALL = "['feed', 'pool', 'search', null]";
const ROWS_NEW = ROWS_TABLE.replace(ROWS_ALL, "['search', null]")
  .replace('inherits', 'single')
  .replace('toBe(1)', 'toBe(2)');
const ROWS_BASE_SRC = file(spec('[AC-0] plain'), ROWS_TABLE, spec('[AC-9] other'));
const rowsHeadSrc = (table = "['feed', 'pool']", kept = ROWS_TABLE.replace(ROWS_ALL, table)) =>
  file(spec('[AC-0] plain'), kept, ROWS_NEW, spec('[AC-9] other'));
const ROW_NAMES = ['[AC-8] source feed inherits', '[AC-8] source pool inherits'];
const ROW_REASON = 'the kept rows are the base cases; the risk rows moved out (D10-641)';
const rowsDeclared = (tests: string[] = ROW_NAMES, file = ROWS) =>
  tests.map((test) => ({ file, test, reason: ROW_REASON }));
const rowsBaselines = (
  head = rowsHeadSrc(),
  declared = rowsDeclared(),
  outside: { file: string; reason: string }[] = [],
  base: string | null = ROWS_BASE_SRC,
) =>
  ruleTestBaselines(
    [ROWS],
    [{ path: ROWS, status: base === null ? 'A' : 'M' }],
    ['test/spec/z/**'],
    reader(base === null ? {} : { [ROWS]: base }, { [ROWS]: head }),
    [],
    [],
    outside,
    declared,
  );
const NEW_ROWS: RedTest[] = [
  ['[AC-8] source search single', 'failed', 'AssertionError: expected 1 to be 2'],
  ['[AC-8] source null single', 'failed', 'AssertionError: expected 1 to be 2'],
];
const rowsTests = (kept: string[] = ROW_NAMES, status = 'passed'): RedTest[] => [
  ['[AC-0] plain', 'passed'],
  ...kept.map((n): RedTest => (status === 'passed' ? [n, 'passed'] : [n, 'failed', status])),
  ...NEW_ROWS,
  ['[AC-9] other', 'passed'],
];
const ROW_NOTE = (name: string, how = 'green') =>
  `${ROWS} > ${name}: a kept row of an .each table whose title template, callback and rows are the base's (rows removed only), exempt by the task's red_exempt_rows declaration (${how}; reason: ${ROW_REASON}); the rule-test reviewer must confirm red_exempt_rows one by one (evidence spec_test_review.red_exempt_rows_confirmed)`;
const NO_TEETH = 'green on the skeleton: the test has no teeth (new or changed since the base)';

it('[CT-06zzze] the three checks hold: the declared kept rows may pass, listed with rows: true; the new rows must be red', () => {
  const b = rowsBaselines();
  expect(b.get(ROWS)?.kind).toBe('tests');
  const result = checkRedReports(
    [redReport(ROWS, rowsTests())],
    [ROWS],
    ROOT,
    b,
    [],
    rowsDeclared(),
  );
  expect(result.problems).toEqual([]);
  expect(result.ok).toBe(true);
  expect(result.red).toEqual(NEW_ROWS.map(([n]) => `${ROWS} > ${n}`));
  expect(result.exempt).toEqual([
    { file: ROWS, test: '[AC-0] plain', status: 'passed' },
    ...ROW_NAMES.map((test) => ({
      file: ROWS,
      test,
      status: 'passed',
      declared: true,
      reason: ROW_REASON,
      rows: true,
    })),
    { file: ROWS, test: '[AC-9] other', status: 'passed' },
  ]);
  for (const n of ROW_NAMES) expect(result.notes).toContain(ROW_NOTE(n));
  // A declared kept row that is red for a valid reason is listed too, and counts as red.
  const red = checkRedReports(
    [redReport(ROWS, rowsTests(ROW_NAMES, 'AssertionError: x'))],
    [ROWS],
    ROOT,
    b,
    [],
    rowsDeclared(),
  );
  expect(red.ok).toBe(true);
  expect(red.exempt?.filter((e) => e.rows === true).map((e) => e.status)).toEqual([
    'failed',
    'failed',
  ]);
  expect(red.notes).toContain(ROW_NOTE(ROW_NAMES[0] as string, 'red for a valid reason'));
});

it('[CT-06zzze] an undeclared kept row, or the same rows without red_exempt_rows, must still be red', () => {
  const one = rowsDeclared(ROW_NAMES.slice(0, 1));
  const result = checkRedReports(
    [redReport(ROWS, rowsTests())],
    [ROWS],
    ROOT,
    rowsBaselines(rowsHeadSrc(), one),
    [],
    one,
  );
  expect(result.ok).toBe(false);
  expect(result.problems).toEqual([{ file: ROWS, test: ROW_NAMES[1], reason: NO_TEETH }]);
  // Without declarations nothing changes: the changed block's rows must all be red.
  const none = checkRedReports(
    [redReport(ROWS, rowsTests())],
    [ROWS],
    ROOT,
    rowsBaselines(rowsHeadSrc(), []),
  );
  expect(none.problems).toEqual(ROW_NAMES.map((test) => ({ file: ROWS, test, reason: NO_TEETH })));
  expect(none.exempt?.some((e) => e.rows === true)).toBe(false);
});

it('[CT-06zzze] one character of the title template or the callback, a changed, added or reordered row: the declared rows must be red, the notes say which check failed', () => {
  const refused = (head: string, names: string[], why: string) => {
    const declared = rowsDeclared(names);
    const result = checkRedReports(
      [redReport(ROWS, rowsTests(names))],
      [ROWS],
      ROOT,
      rowsBaselines(head, declared),
      [],
      declared,
    );
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(names.map((test) => ({ file: ROWS, test, reason: NO_TEETH })));
    expect(result.exempt?.some((e) => e.rows === true)).toBe(false);
    for (const n of names) {
      const note = result.notes.find((x) =>
        x.startsWith(
          `${ROWS} > ${n}: declared in red_exempt_rows, but the declaration does not apply: `,
        ),
      );
      expect(note, n).toContain(why);
      expect(note, n).toMatch(/; the test must be red$/);
    }
  };
  const kept = (table: string) => ROWS_TABLE.replace(ROWS_ALL, table);
  const NO_BASE =
    '① no .each / .for block of the base has the same title template and callback under the same describes';
  refused(
    rowsHeadSrc('', kept("['feed', 'pool']").replace('%s inherits', '%s inherit')),
    ['[AC-8] source feed inherit', '[AC-8] source pool inherit'],
    NO_BASE,
  );
  refused(
    rowsHeadSrc('', kept("['feed', 'pool']").replace('toBe(1)', 'toBe(3)')),
    ROW_NAMES,
    NO_BASE,
  );
  refused(
    rowsHeadSrc("['feeds', 'pool']"),
    ['[AC-8] source feeds inherits', '[AC-8] source pool inherits'],
    '③ the head table is not the base table with rows removed: row "\'feeds\'" is changed, added or moved',
  );
  refused(
    rowsHeadSrc("['feed', 'pool', 'extra']"),
    [...ROW_NAMES, '[AC-8] source extra inherits'],
    '③ the head table is not the base table with rows removed: row "\'extra\'" is changed, added or moved',
  );
  refused(
    rowsHeadSrc("['pool', 'feed']"),
    ['[AC-8] source pool inherits', '[AC-8] source feed inherits'],
    '③ the head table is not the base table with rows removed: row "\'feed\'" is changed, added or moved',
  );
});

it('[CT-06zzze] a table by name at the base (the B1-05zc cards shape) is not covered: ① with type arguments, ② without', () => {
  const CARDS = 'test/spec/z/cards.test.ts';
  const CARDS_BASE = [
    "import { expect, it } from 'vitest';",
    "import { PLATFORMS } from './kit.ts';",
    '',
    'it.each(PLATFORMS)(',
    "  '[AC-5] $0 keys',",
    '  async (platform) => {',
    "    expect(await k(platform)).toBe(platform === 'taobao' ? 1 : 2);",
    '  },',
    ');',
    '',
  ].join('\n');
  const split = (call: string) =>
    `${CARDS_BASE.replace('it.each(PLATFORMS)(', `${call}(`)}\nit.each(['taobao'] as const)('[AC-5] $0 keys (single)', async (platform) => {\n  expect(await k(platform)).toBe(2);\n});\n`;
  const names = ['[AC-5] jd keys', '[AC-5] pdd keys'];
  const run = (head: string) => {
    const declared = rowsDeclared(names, CARDS);
    return checkRedReports(
      [
        redReport(CARDS, [
          ...names.map((n): RedTest => [n, 'passed']),
          ['[AC-5] taobao keys (single)', 'failed', 'AssertionError: x'],
        ]),
      ],
      [CARDS],
      ROOT,
      ruleTestBaselines(
        [CARDS],
        [{ path: CARDS, status: 'M' }],
        ['test/spec/z/**'],
        reader({ [CARDS]: CARDS_BASE }, { [CARDS]: head }),
        [],
        [],
        [],
        declared,
      ),
      [],
      declared,
    );
  };
  const typed = run(split("it.each<(typeof PLATFORMS)[number]>(['jd', 'pdd'])"));
  expect(typed.ok).toBe(false);
  expect(typed.problems.map((p) => p.test)).toEqual(names);
  expect(typed.notes.join('\n')).toContain(
    "declared in red_exempt_rows, but the declaration does not apply: ① the call before the table differs from the base's",
  );
  const plain = run(split("it.each(['jd', 'pdd'])"));
  expect(plain.ok).toBe(false);
  expect(plain.problems.map((p) => p.test)).toEqual(names);
  expect(plain.notes.join('\n')).toContain(
    'declared in red_exempt_rows, but the declaration does not apply: ② the base table is not an inline array of literal rows; the test must be red',
  );
});

it('[CT-06zzze] a new file, a report not from the red reporter, a row of an unchanged block: the declarations do not apply', () => {
  const fresh = checkRedReports(
    [redReport(ROWS, rowsTests())],
    [ROWS],
    ROOT,
    rowsBaselines(rowsHeadSrc(), rowsDeclared(), [], null),
    [],
    rowsDeclared(),
  );
  expect(fresh.ok).toBe(false);
  expect(fresh.problems.map((p) => p.test)).toEqual(['[AC-0] plain', ...ROW_NAMES, '[AC-9] other']);
  expect(fresh.notes).toContain(
    `${ROWS}: 2 declared kept row(s) (red_exempt_rows) do not apply: the file is new, renamed or could not be compared with the base (they apply only to a file that existed at the base, compared test by test)`,
  );
  const plain = checkRedReports(
    [redReport(ROWS, rowsTests(), 'vitest')],
    [ROWS],
    ROOT,
    rowsBaselines(),
    [],
    rowsDeclared(),
  );
  expect(plain.ok).toBe(false);
  expect(plain.notes).toContain(
    `${ROWS}: 2 declared kept row(s) (red_exempt_rows) do not apply: the report is not from the red reporter (they apply only to a file that existed at the base, compared test by test)`,
  );
  // A row declaration of a test whose block is unchanged is not needed (and never more).
  const unchanged = rowsDeclared([...ROW_NAMES, '[AC-9] other']);
  const result = checkRedReports(
    [redReport(ROWS, rowsTests())],
    [ROWS],
    ROOT,
    rowsBaselines(rowsHeadSrc(), unchanged),
    [],
    unchanged,
  );
  expect(result.ok).toBe(true);
  expect(result.notes).toContain(
    `${ROWS}: the declared kept row (red_exempt_rows) "[AC-9] other" matches no test of the report that must otherwise be red (the full name must be exactly the red reporter's)`,
  );
  // A file whose every test is unchanged or a declared kept row: nothing is shown red.
  const onlyKept = file(spec('[AC-0] plain'), ROWS_TABLE.replace(ROWS_ALL, "['feed', 'pool']"));
  const all = checkRedReports(
    [
      redReport(ROWS, [
        ['[AC-0] plain', 'passed'],
        ...ROW_NAMES.map((n): RedTest => [n, 'passed']),
      ]),
    ],
    [ROWS],
    ROOT,
    rowsBaselines(onlyKept),
    [],
    rowsDeclared(),
  );
  expect(all.problems).toEqual([
    {
      file: ROWS,
      test: null,
      reason:
        'existed at the base and every test is unchanged or a declared kept row: nothing is shown red (3 test(s))',
    },
  ]);
});

it('[CT-06zzze] with red_exempt_outside: the kept rows may pass, every other rule stays (an undeclared unchanged test must be red, a row declaration of an unchanged block does not apply)', () => {
  const head = rowsHeadSrc().replace(VITEST, `${VITEST}\nimport { g } from './g.ts';`);
  const outside = [{ file: ROWS, reason: 'the import follows the new quoting helper' }];
  const b = rowsBaselines(head, rowsDeclared(), outside);
  expect(b.get(ROWS)).toMatchObject({ kind: 'support', outside: { lines: 'L2' } });
  const exempt = [declare('[AC-0] plain', REASON, ROWS)];
  const result = checkRedReports(
    [redReport(ROWS, rowsTests())],
    [ROWS],
    ROOT,
    b,
    exempt,
    rowsDeclared(),
  );
  expect(result.ok).toBe(false);
  expect(result.problems).toEqual([
    {
      file: ROWS,
      test: '[AC-9] other',
      reason:
        'green on the skeleton: the test has no teeth (the file may read a test-support file the task changed and the ledger does not declare this test exempt)',
    },
  ]);
  expect(result.exempt?.map((e) => [e.test, e.rows === true])).toEqual([
    ['[AC-0] plain', false],
    [ROW_NAMES[0], true],
    [ROW_NAMES[1], true],
  ]);
  // Declaring the unchanged [AC-9] as a kept row does not make it exempt.
  const asRow = rowsDeclared([...ROW_NAMES, '[AC-9] other']);
  const wrong = checkRedReports(
    [redReport(ROWS, rowsTests())],
    [ROWS],
    ROOT,
    rowsBaselines(head, asRow, outside),
    exempt,
    asRow,
  );
  expect(wrong.problems.map((p) => p.test)).toEqual(['[AC-9] other']);
  expect(wrong.notes).toContain(
    `${ROWS} > [AC-9] other: declared in red_exempt_rows, but the declaration does not apply: its block is unchanged since the base (a row declaration is for a kept row of a changed .each table only); the test must be red`,
  );
  // Declared in red_exempt instead, a kept row still must be red: its block changed.
  const asExempt = [...exempt, declare(ROW_NAMES[0] as string, REASON, ROWS)];
  const changed = checkRedReports(
    [redReport(ROWS, rowsTests())],
    [ROWS],
    ROOT,
    rowsBaselines(head, [], outside),
    asExempt,
    [],
  );
  expect(changed.problems.map((p) => p.test)).toEqual([...ROW_NAMES, '[AC-9] other']);
});

// CT-06zzzg (D10-701, after B2-09v and FU-B209R-FLAKE): modify_existing lets a declared changed
// frozen test pass green; everything else of the file is judged as before.
const MOD = 'test/spec/z/modify.int.test.ts';
const MOD_BASE = file(
  spec('[AC-1] a'),
  spec('[AC-2] late', 'await waitFor(60_000);'),
  spec('[AC-3] c'),
);
const MOD_TIGHT = spec('[AC-2] late', 'f.send = () => expect.fail("sent");');
const MOD_HEAD = file(spec('[AC-1] a'), MOD_TIGHT, spec('[AC-3] c'), spec('[AC-4] new'));
const MOD_NOTE = 'the expectation is unchanged, a wrong implementation now fails by assertion';
const modDeclared = (tests: string[] = ['[AC-2] late'], file = MOD) =>
  tests.map((test) => ({
    file,
    test,
    reason: 'tighten_only' as const,
    ruling: 'D10-701',
    note: MOD_NOTE,
  }));
const modBaselines = (head = MOD_HEAD, declared = modDeclared(), base: string | null = MOD_BASE) =>
  ruleTestBaselines(
    [MOD],
    [{ path: MOD, status: base === null ? 'A' : 'M' }],
    ['test/spec/z/**'],
    reader(base === null ? {} : { [MOD]: base }, { [MOD]: head }),
    [],
    [],
    [],
    [],
    declared,
  );
const MOD_TESTS: RedTest[] = [
  ['[AC-1] a', 'passed'],
  ['[AC-2] late', 'passed'],
  ['[AC-3] c', 'passed'],
  ['[AC-4] new', 'failed', 'AssertionError: expected 1 to be 2'],
];

it('[CT-06zzzg] a declared changed frozen test may pass green, listed with modified: true; the new test must still be red', () => {
  const b = modBaselines();
  // The new test is a change outside the declared block (said in `outside`): red-check judges
  // it by the usual rules; only evidence-check's class 1 rule after spec_commit reads `outside`.
  expect(b.get(MOD)).toMatchObject({
    kind: 'tests',
    modified: { ok: true, blocks: [{ test: '[AC-2] late', found: true, changed: true }] },
  });
  const result = checkRedReports(
    [redReport(MOD, MOD_TESTS)],
    [MOD],
    ROOT,
    b,
    [],
    [],
    modDeclared(),
  );
  expect(result.problems).toEqual([]);
  expect(result.ok).toBe(true);
  expect(result.red).toEqual([`${MOD} > [AC-4] new`]);
  expect(result.exempt).toContainEqual({
    file: MOD,
    test: '[AC-2] late',
    status: 'passed',
    declared: true,
    reason: MOD_NOTE,
    modified: true,
  });
  expect(result.notes.join('\n')).toContain(
    `${MOD} > [AC-2] late: a changed frozen test declared in modify_existing (tighten_only, D10-701; green; note: ${MOD_NOTE}), not held to the red rule; evidence-check requires the owner's approval label`,
  );
  // The new test green: no teeth, as before.
  const green = checkRedReports(
    [
      redReport(
        MOD,
        MOD_TESTS.map(([n]): RedTest => [n, 'passed']),
      ),
    ],
    [MOD],
    ROOT,
    b,
    [],
    [],
    modDeclared(),
  );
  expect(green.problems).toEqual([{ file: MOD, test: '[AC-4] new', reason: NO_TEETH }]);
});

it('[CT-06zzzg] without the declaration, or for an undeclared changed test, the changed frozen test must be red', () => {
  const none = checkRedReports(
    [redReport(MOD, MOD_TESTS)],
    [MOD],
    ROOT,
    modBaselines(MOD_HEAD, []),
  );
  expect(none.problems).toEqual([{ file: MOD, test: '[AC-2] late', reason: NO_TEETH }]);
  // [AC-1] changed too but is not declared: it must be red; the declared one may stay green.
  const head = file(
    spec('[AC-1] a', 'expect(2).toBe(2);'),
    MOD_TIGHT,
    spec('[AC-3] c'),
    spec('[AC-4] new'),
  );
  const other = checkRedReports(
    [redReport(MOD, MOD_TESTS)],
    [MOD],
    ROOT,
    modBaselines(head),
    [],
    [],
    modDeclared(),
  );
  expect(other.problems).toEqual([{ file: MOD, test: '[AC-1] a', reason: NO_TEETH }]);
});

it("[CT-06zzzg] a declared block that is the base's, gone at the head, or in a file that is not expected: a problem (redundant or not covered)", () => {
  const same = file(
    spec('[AC-1] a'),
    spec('[AC-2] late', 'await waitFor(60_000);'),
    spec('[AC-3] c'),
    spec('[AC-4] new'),
  );
  const redundant = checkRedReports(
    [redReport(MOD, MOD_TESTS)],
    [MOD],
    ROOT,
    modBaselines(same),
    [],
    [],
    modDeclared(),
  );
  expect(redundant.ok).toBe(false);
  expect(redundant.problems).toEqual([
    {
      file: MOD,
      test: '[AC-2] late',
      reason:
        "declared in modify_existing, but its block is the base's: the entry is redundant (remove it from the ledger)",
    },
  ]);
  const gone = file(spec('[AC-1] a'), spec('[AC-3] c'), spec('[AC-4] new'));
  const removed = checkRedReports(
    [
      redReport(
        MOD,
        MOD_TESTS.filter(([n]) => n !== '[AC-2] late'),
      ),
    ],
    [MOD],
    ROOT,
    modBaselines(gone),
    [],
    [],
    modDeclared(),
  );
  expect(removed.problems).toEqual([
    {
      file: MOD,
      test: '[AC-2] late',
      reason:
        'declared in modify_existing, but the declaration does not apply: the test is gone at the head (removed or renamed: a removal is not a change of a frozen test)',
    },
  ]);
  const elsewhere = checkRedReports(
    [redReport(MOD, MOD_TESTS)],
    [MOD],
    ROOT,
    modBaselines(),
    [],
    [],
    [...modDeclared(), ...modDeclared(['[AC-1] x'], 'test/spec/z/other.test.ts')],
  );
  expect(elsewhere.problems).toEqual([
    {
      file: 'test/spec/z/other.test.ts',
      test: '[AC-1] x',
      reason:
        'declared in modify_existing, but the file is not an expected rule-test file of the red run (unchanged since the base, or left out): the entry is redundant',
    },
  ]);
});

it('[CT-06zzzg] a file judged as a whole (code outside the tests changed, a new file, not the red reporter), or only declared changes: the entries do not apply, fail-closed', () => {
  const imported = `import { x } from './x.ts';\n${MOD_HEAD}`;
  const whole = checkRedReports(
    [redReport(MOD, MOD_TESTS)],
    [MOD],
    ROOT,
    modBaselines(imported),
    [],
    [],
    modDeclared(),
  );
  expect(whole.problems).toContainEqual({
    file: MOD,
    test: '[AC-2] late',
    reason: 'green on the skeleton: the test has no teeth',
  });
  expect(whole.notes.join('\n')).toContain(
    `${MOD}: 1 declared change(s) of frozen tests (modify_existing) do not apply`,
  );
  const fresh = checkRedReports(
    [redReport(MOD, MOD_TESTS)],
    [MOD],
    ROOT,
    modBaselines(MOD_HEAD, modDeclared(), null),
    [],
    [],
    modDeclared(),
  );
  expect(fresh.ok).toBe(false);
  expect(fresh.notes.join('\n')).toContain(
    'the file is new, renamed or could not be compared with the base',
  );
  const vitestOnly = checkRedReports(
    [redReport(MOD, MOD_TESTS, 'json')],
    [MOD],
    ROOT,
    modBaselines(),
    [],
    [],
    modDeclared(),
  );
  expect(vitestOnly.ok).toBe(false);
  expect(vitestOnly.notes.join('\n')).toContain('the report is not from the red reporter');
  // Only the declared change in the file: nothing is shown red.
  const only = file(spec('[AC-1] a'), MOD_TIGHT, spec('[AC-3] c'));
  const nothing = checkRedReports(
    [redReport(MOD, MOD_TESTS.slice(0, 3))],
    [MOD],
    ROOT,
    modBaselines(only),
    [],
    [],
    modDeclared(),
  );
  expect(nothing.problems).toEqual([
    {
      file: MOD,
      test: null,
      reason:
        'existed at the base and every test is unchanged or a declared change of a frozen test (modify_existing): nothing is shown red (3 test(s))',
    },
  ]);
});

it('[CT-06zzzg] a file whose every change lies in its declared blocks is left out of the expected list; a new test next to them keeps it expected', () => {
  const only = file(spec('[AC-1] a'), MOD_TIGHT, spec('[AC-3] c'));
  const read = (head: string) => reader({ [MOD]: MOD_BASE }, { [MOD]: head });
  expect(modifiedOnlyFiles([MOD], read(only), modDeclared())).toEqual([
    { file: MOD, tests: ['[AC-2] late'] },
  ]);
  expect(modifiedOnlyNote({ file: MOD, tests: ['[AC-2] late'] })).toContain(
    'left out of the expected list (not run, not judged)',
  );
  // Left out, its entry is not called redundant by the check of the other files.
  const other = 'test/spec/z/new.test.ts';
  const result = checkRedReports(
    [redReport(other, [['[AC-9] n', 'failed', 'AssertionError: expected 1 to be 2']])],
    [other],
    ROOT,
    new Map(),
    [],
    [],
    modDeclared(),
    [MOD],
  );
  expect(result.problems).toEqual([]);
  // A new test next to the declared block: stays expected, and the new test must be red.
  expect(modifiedOnlyFiles([MOD], read(MOD_HEAD), modDeclared())).toEqual([]);
  const kept = checkRedReports(
    [
      redReport(
        MOD,
        MOD_TESTS.map(([n]): RedTest => [n, 'passed']),
      ),
    ],
    [MOD],
    ROOT,
    modBaselines(),
    [],
    [],
    modDeclared(),
  );
  expect(kept.problems).toEqual([{ file: MOD, test: '[AC-4] new', reason: NO_TEETH }]);
});

it("[CT-06zzzg] not left out when the comparison cannot be made, a declared block is the base's or gone, the file is new, or there is no declaration", () => {
  const only = file(spec('[AC-1] a'), MOD_TIGHT, spec('[AC-3] c'));
  const read = (base: string | null, head: string | null) =>
    reader(base === null ? {} : { [MOD]: base }, head === null ? {} : { [MOD]: head });
  const cases: [string, string | null, string | null, ReturnType<typeof modDeclared>][] = [
    ['unreadable', MOD_BASE, 'it((', modDeclared()],
    ['unchanged block', MOD_BASE, MOD_BASE, modDeclared()],
    ['gone', MOD_BASE, file(spec('[AC-1] a'), spec('[AC-3] c')), modDeclared()],
    ['one of two unchanged', MOD_BASE, only, modDeclared(['[AC-2] late', '[AC-1] a'])],
    ['an import too', MOD_BASE, `import { x } from './x.ts';\n${only}`, modDeclared()],
    ['new file', null, only, modDeclared()],
    ['no declaration', MOD_BASE, only, []],
  ];
  for (const [name, base, head, declared] of cases) {
    expect(modifiedOnlyFiles([MOD], read(base, head), declared), name).toEqual([]);
  }
});

// CT-06zzzk (D10-738 A): modify_existing names rows of an .each table by their expanded titles.
const EACH = 'test/spec/z/each.int.test.ts';
const eachBlock = (body: string): string =>
  `it.each(['14', '15'] as const)('[AC-45] closed with %s', async (code) => {\n  ${body}\n});`;
const EACH_BASE = file(spec('[AC-1] a'), eachBlock('expect(code).toBeTruthy();'));
const EACH_HEAD = file(spec('[AC-1] a'), eachBlock('audit();\n  expect(code).toBeTruthy();'));
const EACH_ROWS = ['[AC-45] closed with 14', '[AC-45] closed with 15'];
const eachDeclared = (tests: string[] = EACH_ROWS) =>
  tests.map((test) => ({
    file: EACH,
    test,
    reason: 'tighten_only' as const,
    ruling: 'D10-738',
    note: 'the audit port is injected inside the block only',
  }));
const eachBaselines = (head: string, declared = eachDeclared()) =>
  ruleTestBaselines(
    [EACH],
    [{ path: EACH, status: 'M' }],
    ['test/spec/z/**'],
    reader({ [EACH]: EACH_BASE }, { [EACH]: head }),
    [],
    [],
    [],
    [],
    declared,
  );
const EACH_TESTS: RedTest[] = [
  ['[AC-1] a', 'passed'],
  ['[AC-45] closed with 14', 'passed'],
  ['[AC-45] closed with 15', 'passed'],
];

it('[CT-06zzzk] every row of an .each table declared, only the callback changed: the rows may pass green; the file is left out of the expected list', () => {
  const result = checkRedReports(
    [redReport(EACH, EACH_TESTS)],
    [EACH],
    ROOT,
    eachBaselines(EACH_HEAD),
    [],
    [],
    eachDeclared(),
  );
  // Nothing else changed: every test unchanged or declared, nothing shown red (as for a plain
  // block); such a file is left out of the expected list instead.
  expect(result.problems).toEqual([
    {
      file: EACH,
      test: null,
      reason:
        'existed at the base and every test is unchanged or a declared change of a frozen test (modify_existing): nothing is shown red (3 test(s))',
    },
  ]);
  expect(result.exempt?.filter((e) => e.modified === true).map((e) => e.test)).toEqual(EACH_ROWS);
  expect(
    modifiedOnlyFiles([EACH], reader({ [EACH]: EACH_BASE }, { [EACH]: EACH_HEAD }), eachDeclared()),
  ).toEqual([{ file: EACH, tests: EACH_ROWS }]);
  // With a new test next to it the file stays expected; the rows still pass, the new test is red.
  const withNew = file(
    spec('[AC-1] a'),
    eachBlock('audit();\n  expect(code).toBeTruthy();'),
    spec('[AC-2] new'),
  );
  expect(
    modifiedOnlyFiles([EACH], reader({ [EACH]: EACH_BASE }, { [EACH]: withNew }), eachDeclared()),
  ).toEqual([]);
  const kept = checkRedReports(
    [
      redReport(EACH, [
        ...EACH_TESTS,
        ['[AC-2] new', 'failed', 'AssertionError: expected 1 to be 2'],
      ]),
    ],
    [EACH],
    ROOT,
    eachBaselines(withNew),
    [],
    [],
    eachDeclared(),
  );
  expect(kept.problems).toEqual([]);
  expect(kept.red).toEqual([`${EACH} > [AC-2] new`]);
});

it('[CT-06zzzk] only some rows declared: a problem, and the undeclared row must be red; not left out', () => {
  const one = eachDeclared([EACH_ROWS[0] as string]);
  const result = checkRedReports(
    [redReport(EACH, EACH_TESTS)],
    [EACH],
    ROOT,
    eachBaselines(EACH_HEAD, one),
    [],
    [],
    one,
  );
  expect(result.ok).toBe(false);
  expect(result.problems).toContainEqual({
    file: EACH,
    test: EACH_ROWS[0],
    reason:
      'declared in modify_existing, but the declaration does not apply: the call, title or callback every row shares changed: every row of the table must be declared (1 of 2 are)',
  });
  expect(result.problems.filter((p) => p.reason === NO_TEETH).map((p) => p.test)).toEqual(
    EACH_ROWS,
  );
  expect(
    modifiedOnlyFiles([EACH], reader({ [EACH]: EACH_BASE }, { [EACH]: EACH_HEAD }), one),
  ).toEqual([]);
});
