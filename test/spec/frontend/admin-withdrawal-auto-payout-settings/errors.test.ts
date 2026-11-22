// @vitest-environment jsdom
import { expect, it } from 'vitest';
import {
  KEY,
  LABEL,
  NOTICE,
  SUPER,
  VERSION,
  failedWith,
  scriptBatch,
  serverFor,
  type BatchEntry,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  assertBatch,
  batches,
  editable,
  markedInvalid,
  openSettings,
  passUntilSent,
  save,
  settled,
  shownText,
  shows,
  typeInto,
} from './helpers.ts';

// F1-08ap: answers to a first submit that was refused. 20001 data.fields marks each listed key and
// leaves the form editable; 20902 data.resource=config_item says someone else changed the settings
// and to refresh before doing it again, and is never sent again by itself; 10403 says no
// permission; a plain 10003 (the pass expired) asks for the dynamic code again and sends the same
// request once more.

const AMOUNT: readonly BatchEntry[] = [
  { key: KEY.maxAmount, value: 30000, expected_version: VERSION.maxAmount },
];

it(
  '[AC-F1-08ap-ERR#1] 首次提交收到 20001 data.fields=[max_amount_fen]：金额上限标为错误、表单仍可编辑，只发一次',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor();
    const panel = await openSettings(server, SUPER);
    scriptBatch(server, () => failedWith(20001, { fields: [KEY.maxAmount] }));
    await typeInto(panel, LABEL.maxAmount, '300');
    await save(server, panel);
    assertBatch(server, AMOUNT, 1, 1);
    await settled(server);
    expect(markedInvalid(panel, LABEL.maxAmount), 'the listed key is marked').toBe(true);
    expect(editable(panel).length, 'still editable').toBeGreaterThan(0);
    expect(batches(server)).toHaveLength(1);
  },
);

it(
  '[AC-F1-08ap-ERR#2] 首次提交收到 20902 config_item：提示已被他人修改、需刷新，不自动重发',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor();
    const panel = await openSettings(server, SUPER);
    scriptBatch(server, () => failedWith(20902, { resource: 'config_item' }, '配置已被他人修改'));
    await typeInto(panel, LABEL.maxAmount, '300');
    await save(server, panel);
    await shows(panel, NOTICE.conflict);
    expect(shownText(panel)).toMatch(/刷新/);
    await settled(server);
    expect(batches(server), 'not sent again by itself').toHaveLength(1);
  },
);

it(
  '[AC-F1-08ap-ERR#3] 首次提交收到 10403：提示无权限，只发一次',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor();
    const panel = await openSettings(server, SUPER);
    scriptBatch(server, () => failedWith(10403, { reason: 'admin_permission_denied' }));
    await typeInto(panel, LABEL.maxAmount, '300');
    await save(server, panel);
    await shows(panel, NOTICE.forbidden);
    await settled(server);
    expect(batches(server)).toHaveLength(1);
  },
);

it(
  '[AC-F1-08ap-ERR#4] 首次提交收到普通 10003（凭证失效）：重新要动态码后原样再发一次（请求体相同、带新凭证），成功',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor();
    const panel = await openSettings(server, SUPER);
    scriptBatch(server, () => failedWith(10003, { tier: 'totp' }));
    await typeInto(panel, LABEL.maxAmount, '300');
    await save(server, panel);
    await passUntilSent(server, 1);
    const sent = batches(server);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body, 'the same request').toStrictEqual(sent[0]!.body);
    assertBatch(server, AMOUNT, 2, 2);
    await shows(panel, NOTICE.saved);
  },
);
