// CT-26zm helpers (unit tier, no database): a fake ContentReader.configValue per app and a
// recording logger. Self-contained (no other task's rule-test kit). Expected values stay in the
// rule tests; the version source is built inside each test.
import { expect } from 'vitest';
import type { ContentConfig } from '../../../../apps/api/src/modules/content/index.ts';

/** The config key the gate reads (plan G-2; CT-26zm). */
export const KEY = 'legal.ai_third_party.version';
/** The gate's warn event (B3-03i; kept by CT-26zm). */
export const EVENT = 'agent.consent_version_config_invalid';
export const INT32_MAX = 2147483647;
export const APP = 'couli';

/** config_items of each app; an absent key reads as null (ContentReader: no such row). */
export class FakeReader {
  readonly items = new Map<string, unknown>();
  readonly asked: string[] = [];
  set(appId: string, key: string, value: unknown): this {
    this.items.set(`${appId}|${key}`, value);
    return this;
  }
  configValue(appId: string, key: string): Promise<ContentConfig | null> {
    this.asked.push(`${appId}|${key}`);
    const id = `${appId}|${key}`;
    if (!this.items.has(id)) return Promise.resolve(null);
    return Promise.resolve({ value: structuredClone(this.items.get(id)) as never, version: 1 });
  }
}

export interface WarnLog {
  warns: unknown[][];
  logger: { warn: (...args: unknown[]) => void };
}

export function warnLog(): WarnLog {
  const warns: unknown[][] = [];
  return { warns, logger: { warn: (...args: unknown[]) => void warns.push(args) } };
}

/** One warn of the gate: the event name and an object field config_key = KEY. */
export function expectInvalidWarn(args: unknown[] | undefined): void {
  expect(args, 'a warn was logged').toBeDefined();
  expect(JSON.stringify(args)).toContain(EVENT);
  expect(args).toEqual(expect.arrayContaining([expect.objectContaining({ config_key: KEY })]));
}
