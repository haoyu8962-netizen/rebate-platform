import { expect, it, vi } from 'vitest';
import { runAdminTotpResetCommand } from '../../../../apps/api/scripts/admin-totp-reset.ts';
import type { OperatorTotpReset } from '../../../../apps/api/src/modules/admin/application/operator-totp-reset.ts';

const TARGET = { appId: 'couli', loginName: 'owner-admin' };
const ARGS = ['--app', TARGET.appId, '--login', TARGET.loginName];
const REASON = '已当面核对本人身份';

function terminalFixture(
  options: { reason?: string | null; answer?: string | null; tty?: boolean } = {},
) {
  const write = vi.fn<(message: string) => void>();
  const readReason = vi.fn<(prompt: string) => Promise<string | null>>(async () =>
    options.reason === undefined ? REASON : options.reason,
  );
  const readConfirmation = vi.fn<(prompt: string) => Promise<string | null>>(async () =>
    options.answer === undefined ? 'yes' : options.answer,
  );
  const inspect = vi.fn<OperatorTotpReset['inspect']>().mockResolvedValue({ totpBound: true });
  const reset = vi.fn<OperatorTotpReset['reset']>().mockResolvedValue({ kind: 'reset' });
  const terminal = { isTTY: options.tty ?? true, readReason, readConfirmation, write };
  return { deps: { terminal, useCase: { inspect, reset } }, terminal, inspect, reset };
}

it.each([
  ['已绑定', true, '因'],
  ['未绑定', false, '因'.repeat(200)],
] as const)(
  '[AC-B1-34t#1] 确认前回显应用、登录名和绑定状态（%s），合法边界原因随重置请求传入',
  async (label, totpBound, reason) => {
    const f = terminalFixture({ reason });
    f.inspect.mockResolvedValue({ totpBound });
    f.terminal.readConfirmation.mockImplementation(async (prompt) => {
      expect(f.terminal.readReason).toHaveBeenCalledOnce();
      expect(f.reset).not.toHaveBeenCalled();
      const printed = [...f.terminal.write.mock.calls.flat(), prompt].join('\n');
      expect(printed).toContain(TARGET.appId);
      expect(printed).toContain(TARGET.loginName);
      expect(printed).toContain(label);
      expect(printed).toMatch(/\byes\b/);
      return 'yes';
    });

    expect(await runAdminTotpResetCommand(ARGS, f.deps)).toBe(0);
    expect(f.inspect).toHaveBeenCalledWith(TARGET);
    expect(f.terminal.readConfirmation).toHaveBeenCalledOnce();
    expect(f.reset).toHaveBeenCalledExactlyOnceWith({ ...TARGET, reason });
  },
);

it.each([null, '', 'no'])(
  '[AC-B1-34t#2] 未明确输入 yes（%j）时退出且不调用重置',
  async (answer) => {
    const f = terminalFixture({ answer });
    expect(await runAdminTotpResetCommand(ARGS, f.deps)).toBeGreaterThan(0);
    expect(f.terminal.readConfirmation).toHaveBeenCalledOnce();
    expect(f.reset).not.toHaveBeenCalled();
  },
);

it.each([
  ['未输入', null],
  ['为空', ''],
  ['全空白', '   '],
  ['超过 200 字', '因'.repeat(201)],
] as const)('[AC-B1-34t#3] 原因%s时拒绝重置', async (_label, reason) => {
  const f = terminalFixture({ reason });
  expect(await runAdminTotpResetCommand(ARGS, f.deps)).toBeGreaterThan(0);
  expect(f.reset).not.toHaveBeenCalled();
});

it.each([
  ['缺 app', ['--login', TARGET.loginName], true],
  ['缺登录名', ['--app', TARGET.appId], true],
  ['没有交互终端', ARGS, false],
] as const)('[AC-B1-34t#4] %s 时拒绝重置', async (_label, args, tty) => {
  const f = terminalFixture({ tty });
  expect(await runAdminTotpResetCommand(args, f.deps)).toBeGreaterThan(0);
  expect(f.reset).not.toHaveBeenCalled();
});
