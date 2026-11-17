// @vitest-environment jsdom
import { cleanup, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  PAUSE,
  QUEUE,
  RESUME,
  failedWith,
  overview,
  pausedOverview,
  resumeChannel,
} from '../admin-payout-unpause/fixtures.ts';
import {
  assertPut,
  changedElsewhere,
  listReads,
  puts,
  scriptPut,
} from '../admin-payout-unpause/helpers.ts';
import {
  attempt,
  exactNotice,
  fail,
  kept,
  prepare,
  recover,
  refreshed,
  succeeded,
} from './helpers.ts';

// F1-08be / BR-WDR-17, BR-WDR-33 ①, BR-ID-34: real shell + frozen fake server.
// Controls share an it with a red unknown-PUT → failed-GET → target flow; none stand alone.
// No implementation imports or mocks of the component's unknown-result state.

it(
  '[AC-F1-08be-QUEUE#1] 首次 GET 失败不产生未定写入；PUT 网络结果未定后 GET 5xx 不遗忘，解除暂停提示上次提交已生效且只写一次',
  { timeout: 150_000 },
  async () => {
    // Control (a): no PUT ever sent. A later target value still means someone else changed it.
    const control = await prepare(RESUME, pausedOverview(), '');
    control.failRead('network');
    await attempt(control);
    await kept(control, 0, '网络错误，请检查网络后重试；未确认前不会重复提交');
    changedElsewhere(control.server, QUEUE, false);
    await attempt(control);
    await exactNotice('开关状态已被他人修改，已刷新为最新状态，请核对后重试');
    await refreshed(control);
    expect(puts(control.server)).toEqual([]);
    expect(listReads(control.server)).toHaveLength(2);
    expect(
      within(document.body).queryAllByText(
        '打款队列已解除暂停（上次提交已生效，已刷新为最新状态）',
        { exact: true },
      ),
    ).toEqual([]);
    cleanup();

    const flow = await prepare(RESUME, pausedOverview(), '财务已充值，恢复出款');
    await recover(
      flow,
      'network',
      ['server'],
      { value: false, expected_version: 7, reason: '财务已充值，恢复出款' },
      '打款队列已解除暂停（上次提交已生效，已刷新为最新状态）',
    );
    expect(puts(flow.server)).toHaveLength(1);
  },
);

it(
  '[AC-F1-08be-CHANNEL#1] 20001 和 10403 确定失败后目标值仍报他人修改；微信通道 PUT 5xx 未定后 GET 网络失败保留记录，重试提示上次已生效',
  { timeout: 180_000 },
  async () => {
    const action = resumeChannel('wechat');
    for (const rejection of [
      {
        code: 20001,
        data: { fields: ['value'] },
        text: '提交内容有误，请检查后重试',
      },
      {
        code: 10403,
        data: { reason: 'admin_permission_denied' },
        text: '无权限执行此操作（需要 switch.payout 或 switch.all 权限点）',
      },
    ]) {
      const control = await prepare(action, pausedOverview(), '');
      scriptPut(control.server, () => failedWith(rejection.code, rejection.data));
      await attempt(control);
      assertPut(control.server, action, { value: false, expected_version: 5 }, 1, 1, control.mark);
      await kept(control, 1, rejection.text);
      changedElsewhere(control.server, action.name, false);
      await attempt(control);
      await exactNotice('开关状态已被他人修改，已刷新为最新状态，请核对后重试');
      await refreshed(control);
      expect(puts(control.server)).toHaveLength(1);
      expect(listReads(control.server)).toHaveLength(2);
      expect(
        within(document.body).queryAllByText(
          '微信零钱通道已解除暂停（上次提交已生效，已刷新为最新状态）',
          { exact: true },
        ),
      ).toEqual([]);
      cleanup();
    }

    const flow = await prepare(action, pausedOverview(), '');
    await recover(
      flow,
      'server',
      ['network'],
      { value: false, expected_version: 5 },
      '微信零钱通道已解除暂停（上次提交已生效，已刷新为最新状态）',
    );
    expect(puts(flow.server)).toHaveLength(1);
  },
);

it(
  '[AC-F1-08be-REPEATED#1] 未到目标值按新 version 和完整原因正常写入；GET 连续网络失败、5xx 后仍保留上次未定结果，第三次读取已解除时只提示已生效',
  { timeout: 180_000 },
  async () => {
    // Control (b): failed PUT did not apply, and the registry has since advanced to version 9.
    const control = await prepare(RESUME, pausedOverview(), ' 核查完成，恢复队列 ');
    scriptPut(control.server, () => fail('network'));
    await attempt(control);
    assertPut(
      control.server,
      RESUME,
      { value: false, expected_version: 7, reason: ' 核查完成，恢复队列 ' },
      1,
      1,
      control.mark,
    );
    await kept(control, 1, '网络错误，请检查网络后重试；未确认前不会重复提交');
    control.failRead('server');
    await attempt(control);
    await kept(control, 1, '提交失败，请稍后重试');
    changedElsewhere(control.server, QUEUE, true, 2);
    const mark = control.server.log.length;
    await attempt(control);
    assertPut(
      control.server,
      RESUME,
      { value: false, expected_version: 9, reason: ' 核查完成，恢复队列 ' },
      2,
      3,
      mark,
    );
    await succeeded(control, '打款队列已解除暂停');
    expect(listReads(control.server)).toHaveLength(3);
    expect(
      within(document.body).queryAllByText(
        '打款队列已解除暂停（上次提交已生效，已刷新为最新状态）',
        { exact: true },
      ),
    ).toEqual([]);
    cleanup();

    const flow = await prepare(RESUME, pausedOverview(), '');
    await recover(
      flow,
      'network',
      ['network', 'server'],
      { value: false, expected_version: 7 },
      '打款队列已解除暂停（上次提交已生效，已刷新为最新状态）',
    );
    expect(listReads(flow.server)).toHaveLength(4);
  },
);

it(
  '[AC-F1-08be-PAUSE#1] 暂停队列 PUT 5xx 后读列表再次 5xx，随后已暂停时提示上次提交已生效，不再写入、不误报他人修改',
  { timeout: 60_000 },
  async () => {
    const flow = await prepare(PAUSE, overview(), '');
    await recover(
      flow,
      'server',
      ['server'],
      { value: true, expected_version: 7 },
      '打款队列已暂停（上次提交已生效，已刷新为最新状态）',
    );
    expect(puts(flow.server)).toHaveLength(1);
  },
);
