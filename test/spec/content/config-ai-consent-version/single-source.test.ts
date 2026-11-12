// CT-26zm (编排 D10-1330): the effective version has exactly one source. GET /v1/config's
// legal.ai_third_party.version is whatever effectiveAiConsentVersion answers for the key's entry
// (content/domain/ai-consent-version.ts, exported by content's index), and only its `invalid`
// source is reported; buildClientConfig never re-checks the value itself. The function is replaced
// here by a spy whose answers differ from what the value alone would give.
import { beforeEach, expect, it, vi } from 'vitest';
import * as shared from '../../../../apps/api/src/modules/content/domain/ai-consent-version.ts';
import * as contentIndex from '../../../../apps/api/src/modules/content/index.ts';
import {
  buildClientConfig,
  type ClientConfigInput,
} from '../../../../apps/api/src/modules/content/domain/client-config.ts';
import { KEY, REQUIRED, legalOf, legalWith } from './fixtures.ts';

vi.mock(
  '../../../../apps/api/src/modules/content/domain/ai-consent-version.ts',
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import('../../../../apps/api/src/modules/content/domain/ai-consent-version.ts')
      >();
    return {
      ...original,
      effectiveAiConsentVersion: vi.fn(original.effectiveAiConsentVersion),
    };
  },
);

const spy = vi.mocked(shared.effectiveAiConsentVersion);

beforeEach(() => {
  spy.mockReset();
});

function assemble(extra: Record<string, unknown> = {}) {
  const report = { invalid: vi.fn(), missing: vi.fn() };
  const input: ClientConfigInput = {
    values: new Map(Object.entries({ ...REQUIRED, ...extra })),
    viewer: { appId: 'ct26zm_single', userId: null },
    deviceId: '019a0000-0000-7000-8000-000000000001',
    linkPatterns: { version: 'fixture', rules: [] },
    rankPlatforms: [],
    report,
  };
  return { data: buildClientConfig(input), report };
}

/** Every call received the key's entry: `{ value }` for a row, null / undefined for none. */
function expectEntries(expected: { value: unknown } | null) {
  expect(spy).toHaveBeenCalled();
  for (const [entry] of spy.mock.calls) {
    if (expected === null) expect(entry ?? null).toBeNull();
    else expect(entry).toEqual(expect.objectContaining(expected));
  }
}

it('[AC-CT-26zm#18] content 的 index 导出的就是这一个取值函数', () => {
  expect(contentIndex.effectiveAiConsentVersion).toBe(shared.effectiveAiConsentVersion);
  spy.mockReturnValue({ version: 41, source: 'configured' });
  const { data } = assemble({ [KEY]: 5 });
  expect(legalOf(data)).toEqual(legalWith(41));
});

it('[AC-CT-26zm#19][BR-AI-13] /v1/config 下发的版本就是取值函数的结果（configured 不报告）', () => {
  spy.mockReturnValue({ version: 41, source: 'configured' });
  const { data, report } = assemble({ [KEY]: 5 });
  expectEntries({ value: 5 });
  expect(legalOf(data)).toEqual(legalWith(41));
  expect(report.invalid).not.toHaveBeenCalled();
  expect(report.missing).not.toHaveBeenCalled();
});

it('[AC-CT-26zm#20][BR-AI-13] 取值函数答 missing：下发其版本，不报告；无行时入参为空', () => {
  spy.mockReturnValue({ version: 1, source: 'missing' });
  const { data, report } = assemble();
  expectEntries(null);
  expect(legalOf(data)).toEqual(legalWith(1));
  expect(report.invalid).not.toHaveBeenCalled();
  expect(report.missing).not.toHaveBeenCalled();
});

it('[AC-CT-26zm#21][BR-AI-13] 取值函数答 invalid：下发其版本，只报告该键一次（即使原值本身是合法整数）', () => {
  spy.mockReturnValue({ version: 1, source: 'invalid' });
  const { data, report } = assemble({ [KEY]: 5 });
  expectEntries({ value: 5 });
  expect(legalOf(data)).toEqual(legalWith(1));
  expect(report.invalid.mock.calls).toEqual([[KEY]]);
  expect(report.missing).not.toHaveBeenCalled();
});
