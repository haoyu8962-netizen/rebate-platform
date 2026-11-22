// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  KEY,
  LABEL,
  NOTICE,
  RECHECK,
  RETRY,
  SAVE,
  SUPER,
  VERSION,
  answerNormally,
  changedElsewhere,
  dropped,
  failedWith,
  fenOfShown,
  rowOf,
  scriptBatch,
  serverError,
  serverFor,
  type BatchEntry,
  type PayoutServer,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  assertBatch,
  batches,
  buttons,
  click,
  disabled,
  editable,
  input,
  isShown,
  itemReads,
  markedInvalid,
  openSettings,
  passUntilSent,
  save,
  settled,
  shownText,
  shows,
  typeInto,
  usable,
  verifications,
} from './helpers.ts';

// F1-08ap (D10-1731 / D10-1739 / D10-2060 / D10-2061, as F1-08ce / F1-08am): a first save with no
// answer the page can read (dropped, unparsable, an enveloped 5xx) is a result-unknown state: the
// tab says the result is unknown and to refresh and check; its inputs are locked; only 【原样重试】
// (the same request body) and 【刷新核对】 are offered; nothing is sent again by itself. A retry
// answered 10403 or 20902 (the first one may have taken effect) keeps the state, locked, body
// unchanged; a retry answered 20001 unlocks. 【刷新核对】 reads the settings again and shows them.

const AMOUNT: readonly BatchEntry[] = [
  { key: KEY.maxAmount, value: 30000, expected_version: VERSION.maxAmount },
];

/** The tab is in the result-unknown state: notice, inputs locked, only the two ways out. */
async function expectUnknown(server: PayoutServer, panel: HTMLElement): Promise<void> {
  await shows(panel, NOTICE.unknown);
  await settled(server);
  expect(editable(panel), 'every input is locked').toEqual([]);
  const saves = buttons(panel, SAVE).filter((node) => isShown(node) && !disabled(node));
  expect(saves, `${SAVE} is not offered`).toEqual([]);
  usable(panel, RETRY);
  usable(panel, RECHECK);
}

/** Presses 【原样重试】 and answers what the page asks until one more batch POST. */
async function retry(server: PayoutServer, panel: HTMLElement): Promise<void> {
  const before = batches(server).length;
  await click(usable(panel, RETRY));
  await passUntilSent(server, before);
}

it(
  '[AC-F1-08ap-UNK#1] 首次保存连接中断：显示结果未知、输入锁定、只给【原样重试】【刷新核对】、不自动重发；【原样重试】送出与首次相同的请求体，成功后解除锁定',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor();
    const panel = await openSettings(server, SUPER);
    scriptBatch(server, () => dropped());
    await typeInto(panel, LABEL.maxAmount, '300');
    await save(server, panel);
    assertBatch(server, AMOUNT, 1, 1);
    await expectUnknown(server, panel);
    expect(batches(server), 'not sent again by itself').toHaveLength(1);
    await retry(server, panel);
    const sent = batches(server);
    expect(sent[1]!.body, 'the same request body').toStrictEqual(sent[0]!.body);
    await shows(panel, NOTICE.saved);
    await waitFor(() => expect(editable(panel).length, 'unlocked').toBeGreaterThan(0));
    expect(shownText(panel)).not.toMatch(NOTICE.unknown);
  },
);

it(
  '[AC-F1-08ap-UNK#2] 首次保存实际已生效但收到带统一外壳的 5xx：结果未知；【原样重试】收到 20902 仍为结果未知、仍锁定；【刷新核对】重读设置后解锁并显示 300 元',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor();
    const panel = await openSettings(server, SUPER);
    scriptBatch(server, (request) => {
      answerNormally(server, request);
      return serverError();
    });
    await typeInto(panel, LABEL.maxAmount, '300');
    await save(server, panel);
    await expectUnknown(server, panel);
    await retry(server, panel);
    const sent = batches(server);
    expect(sent[1]!.body, 'the same request body').toStrictEqual(sent[0]!.body);
    await expectUnknown(server, panel);
    const reads = itemReads(server).length;
    await click(usable(panel, RECHECK));
    await waitFor(() => expect(itemReads(server).length).toBeGreaterThan(reads));
    await settled(server);
    await waitFor(() => expect(editable(panel).length, 'unlocked').toBeGreaterThan(0));
    await waitFor(() => expect(fenOfShown(input(panel, LABEL.maxAmount).value)).toBe(30000));
    expect(shownText(panel)).not.toMatch(NOTICE.unknown);
    expect(batches(server), 'refreshing sends nothing').toHaveLength(2);
  },
);

it(
  '[AC-F1-08ap-UNK#3] 结果未知后【原样重试】收到 10403：仍为结果未知、仍锁定、请求体不变；再【原样重试】收到 20001 [max_amount_fen]：解锁并标出金额上限',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor();
    const panel = await openSettings(server, SUPER);
    scriptBatch(server, () => new Response('<html>bad gateway</html>', { status: 200 }));
    scriptBatch(server, () => failedWith(10403, { reason: 'admin_permission_denied' }));
    scriptBatch(server, () => failedWith(20001, { fields: [KEY.maxAmount] }));
    await typeInto(panel, LABEL.maxAmount, '300');
    await save(server, panel);
    await expectUnknown(server, panel);
    await retry(server, panel);
    await expectUnknown(server, panel);
    await retry(server, panel);
    const sent = batches(server);
    expect(sent).toHaveLength(3);
    expect(sent[1]!.body).toStrictEqual(sent[0]!.body);
    expect(sent[2]!.body).toStrictEqual(sent[0]!.body);
    await settled(server);
    await waitFor(() => expect(editable(panel).length, 'unlocked').toBeGreaterThan(0));
    expect(markedInvalid(panel, LABEL.maxAmount)).toBe(true);
  },
);

it(
  '[AC-F1-08ap-UNK#4] 首次保存连接中断且未落库；【原样重试】收到普通 10003（凭证失效）：重新要动态码后带新凭证原样再发（请求体与首次相同），成功后显示已保存、解除锁定，服务端为 300 元',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor();
    const panel = await openSettings(server, SUPER);
    scriptBatch(server, () => dropped());
    scriptBatch(server, () => failedWith(10003, { tier: 'totp' }));
    await typeInto(panel, LABEL.maxAmount, '300');
    await save(server, panel);
    await expectUnknown(server, panel);
    await retry(server, panel);
    await passUntilSent(server, 2);
    const sent = batches(server);
    expect(sent, 'the save, the refused retry and its resend').toHaveLength(3);
    expect(sent[1]!.body, 'the retry is the same request').toStrictEqual(sent[0]!.body);
    expect(sent[2]!.body, 'the resend is the same request').toStrictEqual(sent[0]!.body);
    assertBatch(server, AMOUNT, 3, verifications(server).length);
    expect(verifications(server).length, 'a new dynamic code was asked for').toBeGreaterThan(1);
    expect(sent[2]!.headers.get('X-Step-Up-Token')).not.toBe(
      sent[1]!.headers.get('X-Step-Up-Token'),
    );
    expect(rowOf(server, KEY.maxAmount)).toMatchObject({
      value: 30000,
      version: VERSION.maxAmount + 1,
    });
    await shows(panel, NOTICE.saved);
    await waitFor(() => expect(editable(panel).length, 'unlocked').toBeGreaterThan(0));
    expect(shownText(panel)).not.toMatch(NOTICE.unknown);
  },
);

it(
  '[AC-F1-08ap-UNK#5] 首次保存收到带统一外壳的 5xx 且未落库（服务端仍为 250.50 元，期间他人以同值另存一次、版本到 4）：【刷新核对】按服务端回填 250.50 元，不显示待核对请求里的 300 元；解锁后改 280 元保存带服务端版本 4',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor();
    const panel = await openSettings(server, SUPER);
    scriptBatch(server, () => serverError());
    await typeInto(panel, LABEL.maxAmount, '300');
    await save(server, panel);
    await expectUnknown(server, panel);
    changedElsewhere(server, KEY.maxAmount, 25050);
    expect(rowOf(server, KEY.maxAmount)).toMatchObject({
      value: 25050,
      version: VERSION.maxAmount + 1,
    });
    const reads = itemReads(server).length;
    await click(usable(panel, RECHECK));
    await waitFor(() => expect(itemReads(server).length).toBeGreaterThan(reads));
    await settled(server);
    await waitFor(() => expect(editable(panel).length, 'unlocked').toBeGreaterThan(0));
    await waitFor(() => expect(fenOfShown(input(panel, LABEL.maxAmount).value)).toBe(25050));
    expect(shownText(panel)).not.toMatch(NOTICE.unknown);
    expect(batches(server), 'refreshing sends nothing').toHaveLength(1);

    await typeInto(panel, LABEL.maxAmount, '280');
    await save(server, panel);
    assertBatch(
      server,
      [{ key: KEY.maxAmount, value: 28000, expected_version: VERSION.maxAmount + 1 }],
      2,
      verifications(server).length,
    );
    await shows(panel, NOTICE.saved);
  },
);

it(
  '[AC-F1-08ap-UNK#6] 首次保存（250.50 → 300 元）收到带统一外壳的 5xx 且未落库，期间另一名财务把金额上限改为 270 元（版本到 4）：【刷新核对】按服务端回填 270 元，不显示提交前的 250.50 元或待核对的 300 元；解锁后改 280 元保存带服务端版本 4',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor();
    const panel = await openSettings(server, SUPER);
    scriptBatch(server, () => serverError());
    await typeInto(panel, LABEL.maxAmount, '300');
    await save(server, panel);
    assertBatch(server, AMOUNT, 1, 1);
    await expectUnknown(server, panel);
    changedElsewhere(server, KEY.maxAmount, 27000);
    expect(rowOf(server, KEY.maxAmount)).toMatchObject({
      value: 27000,
      version: VERSION.maxAmount + 1,
    });
    const reads = itemReads(server).length;
    await click(usable(panel, RECHECK));
    await waitFor(() => expect(itemReads(server).length).toBeGreaterThan(reads));
    await settled(server);
    await waitFor(() => expect(editable(panel).length, 'unlocked').toBeGreaterThan(0));
    await waitFor(() =>
      expect(fenOfShown(input(panel, LABEL.maxAmount).value), 'the server value now').toBe(27000),
    );
    const shownFen = fenOfShown(input(panel, LABEL.maxAmount).value);
    expect(shownFen, 'not the value before the save').not.toBe(25050);
    expect(shownFen, 'not the value being checked').not.toBe(30000);
    expect(shownText(panel)).not.toMatch(NOTICE.unknown);
    expect(batches(server), 'refreshing sends nothing').toHaveLength(1);

    await typeInto(panel, LABEL.maxAmount, '280');
    await save(server, panel);
    assertBatch(
      server,
      [{ key: KEY.maxAmount, value: 28000, expected_version: VERSION.maxAmount + 1 }],
      2,
      verifications(server).length,
    );
    await shows(panel, NOTICE.saved);
    expect(rowOf(server, KEY.maxAmount)).toMatchObject({
      value: 28000,
      version: VERSION.maxAmount + 2,
    });
  },
);
