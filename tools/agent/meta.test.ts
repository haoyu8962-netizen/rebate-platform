// Tests for meta.ts: event-stream facts and the JSON helper used by the bash wrappers.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { applyValueFlags, claudeEventFacts, claudeOutput, editRules, eventFacts } from './meta.ts';
import { AGENT_DIR, REPO } from './testing/fixture.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = join(
    REPO,
    '.tmp',
    `agent-meta-${process.pid}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

function metaCli(args: readonly string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const res = spawnSync(process.execPath, [join(AGENT_DIR, 'meta.ts'), ...args], {
    encoding: 'utf8',
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

const STARTED = '{"type":"thread.started","thread_id":"0199abcd-0000-7000-8000-00000000000a"}';
const COMPLETED = '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}';

it('eventFacts reads the last event type and the thread id', () => {
  expect(eventFacts(`${STARTED}\n{"type":"turn.started"}\n${COMPLETED}\n\n`, '')).toEqual({
    lastType: 'turn.completed',
    threadId: '0199abcd-0000-7000-8000-00000000000a',
    capacity: false,
  });
  expect(eventFacts('', '')).toEqual({ lastType: 'none', threadId: '', capacity: false });
  // A stream that stops in the middle of a line did not end with turn.completed.
  expect(eventFacts(`${COMPLETED}\n{"type":"item.comp`, '').lastType).toBe('invalid');
  expect(
    eventFacts(`${COMPLETED}\n{"type":"turn.failed","error":{"message":"x"}}\n`, '').lastType,
  ).toBe('turn.failed');
});

it('eventFacts sees a capacity error only in error events or on stderr', () => {
  const text = 'Selected model is at capacity. Please try a different model.';
  expect(eventFacts(`{"type":"error","message":"${text}"}\n`, '').capacity).toBe(true);
  expect(eventFacts(`{"type":"turn.failed","error":{"message":"${text}"}}\n`, '').capacity).toBe(
    true,
  );
  expect(eventFacts('', `ERROR: ${text}\n`).capacity).toBe(true);
  const quoted = `{"type":"item.completed","item":{"type":"command_execution","aggregated_output":"${text}"}}\n`;
  expect(eventFacts(quoted, '').capacity).toBe(false);
});

// CT-06zzzz (FU-CODEX-QUOTA-MESSAGE, D10-993): Codex reports an exhausted usage window with its
// own text, not 'Selected model is at capacity'. The streams below follow a real run (a review
// of CT-06zzzw on 2026-11-07, codex-cli 0.154.0) line for line.
const USAGE_LIMIT =
  "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Nov 15th, 2026 12:25 AM.";
const QUOTA_STARTED =
  '{"type":"thread.started","thread_id":"01a1b832-09ee-79f1-84b6-d8d781aa1bc4"}';
const codexLines = (...lines: string[]): string => `${lines.join('\n')}\n`;
const errorEvent = (message: string): string => JSON.stringify({ type: 'error', message });
const turnFailed = (message: string): string =>
  JSON.stringify({ type: 'turn.failed', error: { message } });

it('[CT-06zzzz] eventFacts: the usage-limit text of a real Codex run (error + turn.failed) is a capacity error', () => {
  expect(
    eventFacts(
      codexLines(
        QUOTA_STARTED,
        '{"type":"turn.started"}',
        errorEvent(USAGE_LIMIT),
        turnFailed(USAGE_LIMIT),
      ),
      'Reading additional input from stdin...\n',
    ),
  ).toEqual({
    lastType: 'turn.failed',
    threadId: '01a1b832-09ee-79f1-84b6-d8d781aa1bc4',
    capacity: true,
  });
});

it('[CT-06zzzz] eventFacts: the usage-limit text in a turn.failed event alone, or in an error event alone, is a capacity error', () => {
  expect(
    eventFacts(codexLines(QUOTA_STARTED, '{"type":"turn.started"}', turnFailed(USAGE_LIMIT)), '')
      .capacity,
  ).toBe(true);
  expect(eventFacts(codexLines(QUOTA_STARTED, errorEvent(USAGE_LIMIT)), '').capacity).toBe(true);
});

it('[CT-06zzzz] eventFacts: the usage-limit text on stderr is a capacity error', () => {
  expect(eventFacts('', `ERROR: ${USAGE_LIMIT}\n`).capacity).toBe(true);
  // Next to an ordinary failure in the stream (stderr counts on its own, as for CAPACITY_TEXT).
  expect(
    eventFacts(
      codexLines(QUOTA_STARTED, turnFailed('boom')),
      `Reading additional input from stdin...\n${USAGE_LIMIT}\n`,
    ).capacity,
  ).toBe(true);
});

it('[CT-06zzzz] eventFacts: other wordings of the Codex quota text are capacity errors too', () => {
  const variants = [
    // Another reset time, an upgrade hint before the purchase hint.
    "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:05 PM.",
    // A typographic apostrophe.
    'You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Nov 15th, 2026 12:25 AM.',
  ];
  for (const text of variants) {
    expect(eventFacts(codexLines(QUOTA_STARTED, turnFailed(text)), '').capacity, text).toBe(true);
    expect(eventFacts(codexLines(QUOTA_STARTED, errorEvent(text)), '').capacity, text).toBe(true);
    expect(eventFacts('', `ERROR: ${text}\n`).capacity, text).toBe(true);
  }
});

it('[CT-06zzzz] eventFacts: the usage-limit text inside ordinary items (file contents, agent messages) is data, not a capacity error', () => {
  const quoted = [
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_0', type: 'command_execution', aggregated_output: USAGE_LIMIT },
    }),
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_1', type: 'agent_message', text: `The log says: ${USAGE_LIMIT}` },
    }),
    JSON.stringify({
      type: 'item.started',
      item: { id: 'item_2', type: 'command_execution', command: `grep 'usage limit' x.jsonl` },
    }),
  ];
  for (const line of quoted) {
    expect(eventFacts(codexLines(QUOTA_STARTED, line, COMPLETED), '').capacity, line).toBe(false);
    // Still data when the turn then fails for another reason.
    expect(
      eventFacts(codexLines(QUOTA_STARTED, line, errorEvent('boom'), turnFailed('boom')), '')
        .capacity,
      line,
    ).toBe(false);
  }
});

it('[CT-06zzzz] eventFacts: other failures in error / turn.failed events are not capacity errors', () => {
  const failures = [
    'boom',
    'exec_command failed: tool `shell` returned exit status 2',
    'stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)',
    'Reconnecting... 2/5',
    'Your input exceeds the context window of this model. Please adjust your input and try again.',
  ];
  for (const message of failures) {
    expect(
      eventFacts(codexLines(QUOTA_STARTED, errorEvent(message), turnFailed(message)), '').capacity,
      message,
    ).toBe(false);
  }
  expect(eventFacts('', 'Reading additional input from stdin...\n').capacity).toBe(false);
});

it('[CT-06zzzz] CLI: events prints capacity=1 for the real usage-limit stream; the capacity text still does', () => {
  const dir = scratch();
  const events = join(dir, 'events.jsonl');
  const err = join(dir, 'err.txt');
  writeFileSync(
    events,
    codexLines(
      QUOTA_STARTED,
      '{"type":"turn.started"}',
      errorEvent(USAGE_LIMIT),
      turnFailed(USAGE_LIMIT),
    ),
  );
  writeFileSync(err, 'Reading additional input from stdin...\n');
  const res = metaCli(['events', '--events', events, '--err', err]);
  expect(res.status, res.stderr).toBe(0);
  expect(res.stdout).toBe(
    'last_type=turn.failed\nthread_id=01a1b832-09ee-79f1-84b6-d8d781aa1bc4\ncapacity=1\n',
  );
  expect(
    metaCli(['events', '--engine', 'codex', '--events', events, '--err', err]).stdout,
  ).toContain('capacity=1');
  // 'Selected model is at capacity' is unchanged.
  const text = 'Selected model is at capacity. Please try a different model.';
  writeFileSync(events, codexLines(QUOTA_STARTED, errorEvent(text), turnFailed(text)));
  expect(metaCli(['events', '--events', events, '--err', err]).stdout).toContain('capacity=1');
});

it('applyValueFlags builds typed values and returns what it did not understand', () => {
  const doc: Record<string, unknown> = {};
  const rest = applyValueFlags(doc, [
    '--str',
    'path=/a=b/我的项目',
    '--num',
    'exit_code=124',
    '--bool',
    'timed_out=1',
    '--bool',
    'has_output=false',
    '--null',
    'finished_at',
    '--list',
    'changed=head,index',
    '--list',
    'none=',
    '--json',
    'gate={"allowed":false}',
    '--json',
    'raw=not json',
    'leftover',
  ]);
  expect(rest).toEqual(['leftover']);
  expect(doc).toEqual({
    path: '/a=b/我的项目',
    exit_code: 124,
    timed_out: true,
    has_output: false,
    finished_at: null,
    changed: ['head', 'index'],
    none: [],
    gate: { allowed: false },
    raw: 'not json',
  });
  expect(() => applyValueFlags({}, ['--num', 'n=abc'])).toThrow(/not an integer/);
  expect(() => applyValueFlags({}, ['--bool', 'b=maybe'])).toThrow(/expected true/);
  expect(() => applyValueFlags({}, ['--str', 'novalue'])).toThrow(/needs <key>=<value>/);
});

it('CLI: merge writes and updates a file, get reads nested keys, emit prints one line', () => {
  const dir = scratch();
  const file = join(dir, 'meta.json');
  const copy = join(dir, 'meta.impl.json');
  const lines = join(dir, 'lines.txt');
  writeFileSync(lines, 'invalid: a\n\ninvalid: b\n');

  expect(
    metaCli(['merge', '--new', '--file', file, '--str', 'mode=impl', '--null', 'exit_code']).status,
  ).toBe(0);
  expect(
    metaCli([
      'merge',
      '--file',
      file,
      '--copy-to',
      copy,
      '--num',
      'exit_code=10',
      '--lines',
      `messages=${lines}`,
    ]).status,
  ).toBe(0);
  const expected = { mode: 'impl', exit_code: 10, messages: ['invalid: a', 'invalid: b'] };
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(expected);
  expect(JSON.parse(readFileSync(copy, 'utf8'))).toEqual(expected);

  expect(metaCli(['get', '--file', file, 'exit_code']).stdout).toBe('10\n');
  expect(metaCli(['get', '--file', file, 'missing']).stdout).toBe('\n');
  writeFileSync(file, JSON.stringify({ attempts: { impl: 2 }, spec_commit: null }));
  expect(metaCli(['get', '--file', file, 'attempts.impl']).stdout).toBe('2\n');
  expect(metaCli(['get', '--file', file, 'spec_commit']).stdout).toBe('\n');
  // An array of scalars (the task refs) comes out comma-separated; objects stay empty.
  writeFileSync(file, JSON.stringify({ refs: ['BR-CALC-01', 'BR-CALC-08'], none: [], obj: [{}] }));
  expect(metaCli(['get', '--file', file, 'refs']).stdout).toBe('BR-CALC-01,BR-CALC-08\n');
  expect(metaCli(['get', '--file', file, 'none']).stdout).toBe('\n');
  expect(metaCli(['get', '--file', file, 'obj']).stdout).toBe('\n');

  const emitted = metaCli([
    'emit',
    '--str',
    'action=dispatched',
    '--num',
    'pid=42',
    '--str',
    'run=/r/我',
  ]);
  expect(emitted.stdout).toBe('{"action":"dispatched","pid":42,"run":"/r/我"}\n');

  expect(metaCli(['merge', '--file', join(dir, 'absent.json'), '--str', 'a=b']).status).toBe(2);
  expect(metaCli(['merge', '--new', '--file', file, 'stray']).status).toBe(2);
  expect(metaCli(['bogus']).status).toBe(2);
});

it('CLI: events prints shell-readable facts', () => {
  const dir = scratch();
  const events = join(dir, 'events.jsonl');
  writeFileSync(events, `${STARTED}\n${COMPLETED}\n`);
  const res = metaCli(['events', '--events', events, '--err', join(dir, 'no-err.txt')]);
  expect(res.status).toBe(0);
  expect(res.stdout).toBe(
    'last_type=turn.completed\nthread_id=0199abcd-0000-7000-8000-00000000000a\ncapacity=0\n',
  );
  expect(metaCli(['events', '--events', join(dir, 'absent.jsonl')]).stdout).toContain(
    'last_type=none',
  );
});

// claude-independent (ops/approvals.yaml id 36): `claude -p --output-format stream-json`.
const SESSION = '"session_id":"abc-123"';
const claudeLines = (...lines: string[]): string => `${lines.join('\n')}\n`;
const INIT = `{"type":"system","subtype":"init",${SESSION}}`;
const OK_RESULT = `{"type":"result","subtype":"success","is_error":false,"structured_output":{"verdict":"pass"},${SESSION}}`;

it('[approvals 36] Claude stream: the final result event decides, a later system line does not', () => {
  expect(
    claudeEventFacts(
      claudeLines(INIT, OK_RESULT, `{"type":"system","subtype":"task_summary"}`),
      '',
    ),
  ).toEqual({ lastType: 'result.success', threadId: 'abc-123', capacity: false });
  // No result at all: the type of the last line; an error result is result.error.
  expect(claudeEventFacts(claudeLines(INIT, '{"type":"assistant"}'), '').lastType).toBe(
    'assistant',
  );
  expect(
    claudeEventFacts(
      claudeLines(INIT, `{"type":"result","subtype":"success","is_error":true,${SESSION}}`),
      '',
    ).lastType,
  ).toBe('result.error');
  expect(claudeEventFacts('', '').lastType).toBe('none');
});

it('[approvals 36] Claude capacity: a rejected rate limit, HTTP 429 / 529, a usage-limit text; not quoted content', () => {
  const error = (extra: string) =>
    `{"type":"result","subtype":"success","is_error":true,${extra},${SESSION}}`;
  expect(
    claudeEventFacts(
      claudeLines(INIT, '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected"}}'),
      '',
    ).capacity,
  ).toBe(true);
  expect(
    claudeEventFacts(
      claudeLines(
        INIT,
        '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}',
        OK_RESULT,
      ),
      '',
    ).capacity,
  ).toBe(false);
  expect(claudeEventFacts(claudeLines(error('"api_error_status":529')), '').capacity).toBe(true);
  expect(
    claudeEventFacts(claudeLines(error('"result":"Claude AI usage limit reached|1792581000"')), '')
      .capacity,
  ).toBe(true);
  expect(claudeEventFacts('', 'API Error: 529 Overloaded').capacity).toBe(true);
  // The same text in an ordinary message (a file the model read) is data.
  expect(
    claudeEventFacts(
      claudeLines(
        INIT,
        '{"type":"user","message":{"content":"You\'ve hit your limit"}}',
        error('"result":"boom"'),
      ),
      '',
    ).capacity,
  ).toBe(false);
});

it('[approvals 36] Claude output: only the structured output of a successful final result', () => {
  expect(claudeOutput(claudeLines(INIT, OK_RESULT))).toEqual({ verdict: 'pass' });
  expect(
    claudeOutput(
      claudeLines(
        INIT,
        `{"type":"result","subtype":"success","is_error":true,"structured_output":{"verdict":"pass"}}`,
      ),
    ),
  ).toBeNull();
  expect(
    claudeOutput(
      claudeLines(INIT, `{"type":"result","subtype":"success","is_error":false,"result":"text"}`),
    ),
  ).toBeNull();
  expect(claudeOutput(claudeLines(INIT))).toBeNull();
  // The CLI writes the file only when there is an output.
  const dir = scratch();
  const events = join(dir, 'events.jsonl');
  writeFileSync(events, claudeLines(INIT, OK_RESULT));
  expect(
    metaCli(['claude-output', '--events', events, '--out', join(dir, 'out.json')]).status,
  ).toBe(0);
  expect(JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8'))).toEqual({ verdict: 'pass' });
  writeFileSync(events, claudeLines(INIT));
  expect(
    metaCli(['claude-output', '--events', events, '--out', join(dir, 'none.json')]).status,
  ).toBe(0);
  expect(() => readFileSync(join(dir, 'none.json'))).toThrow();
});

it('[approvals 36] edit rules: one Edit(/glob) per glob, braces expanded, nothing outside the repository', () => {
  expect(editRules(['test/spec/a/**,test/{acceptance,properties}/a/**', 'src/a.ts'])).toEqual([
    'Edit(/test/spec/a/**)',
    'Edit(/test/acceptance/a/**)',
    'Edit(/test/properties/a/**)',
    'Edit(/src/a.ts)',
  ]);
  expect(editRules(['', 'src/a.ts,src/a.ts'])).toEqual(['Edit(/src/a.ts)']);
  expect(() => editRules(['../x/**'])).toThrow('not a repository-relative glob');
  expect(() => editRules(['/etc/**'])).toThrow('not a repository-relative glob');
  const cli = metaCli(['edit-rules', '--globs', 'a/{b,c}.ts', '--globs', 'd/**']);
  expect(cli.status).toBe(0);
  expect(cli.stdout).toBe('Edit(/a/b.ts)\nEdit(/a/c.ts)\nEdit(/d/**)\n');
  expect(metaCli(['events', '--engine', 'gemini', '--events', '/dev/null']).status).toBe(2);
});
