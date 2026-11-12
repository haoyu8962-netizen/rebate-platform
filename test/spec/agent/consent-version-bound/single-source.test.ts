// CT-26zm (编排 D10-1330): the gate's version source and GET /v1/config share one value function,
// content's effectiveAiConsentVersion (content/domain/ai-consent-version.ts, through content's
// index). createConsentVersionSource hands it the configValue answer of the key (null when there
// is no row), answers its `version`, and warns agent.consent_version_config_invalid once whenever
// its `source` is not `configured` (missing and invalid both warn: the frozen B3-03i 口径). The
// function is replaced here by a spy whose answers differ from what the value alone would give.
import { beforeEach, expect, it, vi } from 'vitest';
import * as shared from '../../../../apps/api/src/modules/content/domain/ai-consent-version.ts';
import { createConsentVersionSource } from '../../../../apps/api/src/modules/agent/stream/access/index.ts';
import { APP, FakeReader, KEY, expectInvalidWarn, warnLog } from './kit.ts';

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

it('[AC-CT-26zm#25][BR-AI-13] 闸门返回取值函数的 version（configured 不告警），入参是该键的读取结果', async () => {
  spy.mockReturnValue({ version: 41, source: 'configured' });
  const reader = new FakeReader().set(APP, KEY, 5);
  const { warns, logger } = warnLog();
  expect(await createConsentVersionSource({ reader, logger })(APP)).toBe(41);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy.mock.calls[0]![0]).toEqual(expect.objectContaining({ value: 5 }));
  expect(warns).toEqual([]);
});

it('[AC-CT-26zm#26][BR-AI-13] 无行：入参为空，闸门返回取值函数的 version，并告警一次（missing 也告警）', async () => {
  spy.mockReturnValue({ version: 1, source: 'missing' });
  const reader = new FakeReader();
  const { warns, logger } = warnLog();
  expect(await createConsentVersionSource({ reader, logger })(APP)).toBe(1);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy.mock.calls[0]![0] ?? null).toBeNull();
  expect(warns).toHaveLength(1);
  expectInvalidWarn(warns[0]);
});

it('[AC-CT-26zm#27][BR-AI-13] 取值函数答 invalid：闸门返回其 version 并告警一次（即使原值本身是正安全整数）', async () => {
  spy.mockReturnValue({ version: 1, source: 'invalid' });
  const reader = new FakeReader().set(APP, KEY, 5);
  const { warns, logger } = warnLog();
  expect(await createConsentVersionSource({ reader, logger })(APP)).toBe(1);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy.mock.calls[0]![0]).toEqual(expect.objectContaining({ value: 5 }));
  expect(warns).toHaveLength(1);
  expectInvalidWarn(warns[0]);
});
