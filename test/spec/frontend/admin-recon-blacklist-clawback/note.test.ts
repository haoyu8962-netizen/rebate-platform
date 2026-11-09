// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ID, REF, STATUS_NAME, clawbackPath, createServer, rejected } from './fixtures.ts';
import {
  DONE,
  FLOW_TIMEOUT,
  NOTE,
  assertClawback,
  clawbackDialog,
  clawbackDialogs,
  confirmAndVerify,
  confirmMaybeVerify,
  fieldError,
  fill,
  freshNotices,
  mount,
  openClawback,
  pressConfirm,
  settle,
  settled,
  snapshotText,
  statusCell,
  stepUpDialogs,
  textbox,
  verify,
} from './helpers.ts';

it(
  '[AC-F1-08ec-NOTE#1] 备注去首尾空白后 201 字：不成功、在备注旁提示、确认框不关、差错单仍待处理（不发请求，或发出后收 20001 [note]，两种都可）；改成正好 200 字再确认即扣回成功，请求体只有该备注',
  async () => {
    const server = createServer();
    await mount(server);
    const modal = await openClawback(server, REF.open, ID.open);
    const long = `  ${'扣'.repeat(201)}  `;
    await fill(textbox(modal, NOTE), long);
    const before = snapshotText();
    await pressConfirm(modal);
    // Checked before the step-up, or sent after it and refused by the server: both are fine.
    await waitFor(() =>
      expect(
        fieldError(textbox(modal, NOTE)) !== '' || stepUpDialogs().length > 0,
        'a note error or the step-up dialog',
      ).toBe(true),
    );
    const dialog = stepUpDialogs()[0];
    if (dialog !== undefined) {
      await verify(dialog);
      await waitFor(() => expect(server.clawbacks(ID.open)).toHaveLength(1));
    }
    await settled(server);
    const kept = await clawbackDialog();
    await waitFor(() => expect(fieldError(textbox(kept, NOTE))).not.toBe(''));
    expect(server.clawbacks().length).toBeLessThanOrEqual(1);
    for (const request of server.clawbacks()) {
      const body = request.body as Record<string, unknown>;
      expect(String(body['note']).trim().length, 'only an over-long note was sent').toBe(201);
    }
    expect(server.item(ID.open).status).toBe('open');
    expect(freshNotices(before)).not.toMatch(DONE);
    expect(statusCell(REF.open)).toContain(STATUS_NAME.open);

    const sent = server.clawbacks().length;
    const fine = '复'.repeat(200);
    const success = snapshotText();
    await fill(textbox(kept, NOTE), fine);
    await confirmMaybeVerify(server, kept, ID.open);
    expect(server.clawbacks()).toHaveLength(sent + 1);
    assertClawback(server, server.clawbacks(ID.open).at(-1)!, fine);
    expect(server.item(ID.open).status).toBe('adjusted');
    await waitFor(() => expect(freshNotices(success)).toMatch(DONE));
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08ec-NOTE#2] 服务端 20001 data.fields=[note]：在备注旁提示，确认框不关、不显示成功，差错单状态不变',
  async () => {
    const server = createServer();
    server.once('POST', clawbackPath(ID.open), () => rejected(['note']));
    await mount(server);
    const modal = await openClawback(server, REF.open, ID.open);
    const before = snapshotText();
    await confirmAndVerify(server, modal, ID.open, '复核确认');
    const kept = await clawbackDialog();
    await waitFor(() => expect(fieldError(textbox(kept, NOTE))).not.toBe(''));
    expect(clawbackDialogs()).toHaveLength(1);
    await settle();
    await settled(server);
    expect(server.clawbacks()).toHaveLength(1);
    expect(freshNotices(before)).not.toMatch(DONE);
    expect(statusCell(REF.open)).toContain(STATUS_NAME.open);
    expect(server.item(ID.open).status).toBe('open');
  },
  FLOW_TIMEOUT,
);
