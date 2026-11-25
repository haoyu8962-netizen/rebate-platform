import type { OperatorTotpReset } from '../src/modules/admin/application/operator-totp-reset.ts';

export interface AdminTotpResetTerminal {
  readonly isTTY: boolean;
  readReason(prompt: string): Promise<string | null>;
  readConfirmation(prompt: string): Promise<string | null>;
  write(message: string): void;
}

export interface AdminTotpResetCommandDeps {
  readonly terminal: AdminTotpResetTerminal;
  readonly useCase: OperatorTotpReset;
}

export function runAdminTotpResetCommand(
  args: readonly string[],
  deps: AdminTotpResetCommandDeps,
): Promise<number> {
  void args;
  void deps;
  throw new Error('NotImplemented: runAdminTotpResetCommand');
}
