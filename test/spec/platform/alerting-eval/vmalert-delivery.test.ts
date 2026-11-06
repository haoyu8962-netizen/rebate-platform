import { expect, it } from 'vitest';
import { args } from './kit.ts';

it('[AC-B1-25b#10] vmalert 不得丢弃通知、只校验后退出或关闭模板校验', () => {
  const flags = args();
  // These switches are unnecessary in the running evaluator, even with a false value.
  const forbiddenFlags = ['notifier.blackhole', 'dryRun'];
  for (const name of forbiddenFlags) {
    expect(flags.has(name), `-${name} is forbidden in the live evaluator`).toBe(false);
  }
  // Optional validation may stay at its enabled default or be explicitly enabled.
  // Checking every occurrence prevents a duplicate false flag bypassing the guard.
  for (const value of flags.get('rule.validateTemplates') ?? []) {
    expect(value, '-rule.validateTemplates must not disable validation').toBe('true');
  }
});
