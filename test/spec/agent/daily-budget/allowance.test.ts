import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';

import { callAllowance } from '../../../../apps/api/src/modules/agent/budget/index.ts';

const example = {
  reserveMfen: 5_000n,
  inMfenPerM: 100_000n,
  outMfenPerM: 400_000n,
};

it('[AC-B3-09m#10] 规则示例两次调用按各自请求字节数和已花金额给出上限', () => {
  expect(callAllowance({ ...example, spentMfen: 0n, requestBytes: 9_000 })).toEqual({
    maxTokens: 10_250,
    worstMfen: 5_000n,
  });
  expect(callAllowance({ ...example, spentMfen: 320n, requestBytes: 12_000 })).toEqual({
    maxTokens: 8_700,
    worstMfen: 4_680n,
  });
});

it('[AC-B3-09m#11] 输入成本用光或超出余额时不给输出配额', () => {
  const input = { ...example, reserveMfen: 900n, spentMfen: 0n };
  expect(callAllowance({ ...input, requestBytes: 9_000 })).toBeNull();
  expect(callAllowance({ ...input, requestBytes: 9_001 })).toBeNull();
});

it('[AC-B3-09m#12] 上限 255 不调，256 可以调', () => {
  const input = {
    ...example,
    outMfenPerM: 1_000_000n,
    spentMfen: 4_700n,
  };
  expect(callAllowance({ ...input, requestBytes: 441 })).toBeNull();
  expect(callAllowance({ ...input, requestBytes: 440 })).toEqual({
    maxTokens: 256,
    worstMfen: 300n,
  });
});

it('[AC-B3-09m#13] 配置输出上限更低时取配置值，最坏成本按该值计算', () => {
  const input = { ...example, spentMfen: 320n, requestBytes: 12_001 };
  expect(callAllowance({ ...input, configuredMaxTokens: 501 })).toEqual({
    maxTokens: 501,
    worstMfen: 1_402n,
  });
  expect(callAllowance({ ...input, configuredMaxTokens: 255 })).toBeNull();
  expect(callAllowance({ ...input, configuredMaxTokens: 256 })).toEqual({
    maxTokens: 256,
    worstMfen: 1_304n,
  });
});

it('[AC-B3-09m#14] 任意可发的调用都能覆盖请求成本且最坏成本在余额内', () => {
  const inputs = fc.record({
    reserveMfen: fc.bigInt({ min: 0n, max: 20_000n }),
    spentMfen: fc.bigInt({ min: 0n, max: 20_000n }),
    requestBytes: fc.integer({ min: 0, max: 30_000 }),
    inMfenPerM: fc.bigInt({ min: 1n, max: 2_000_000n }),
    outMfenPerM: fc.bigInt({ min: 1n, max: 2_000_000n }),
  });
  const configuredLimit = fc.option(fc.integer({ min: 1, max: 30_000 }), { nil: undefined });
  fc.assert(
    fc.property(inputs, configuredLimit, (a, m) => {
      const allowance = callAllowance(m === undefined ? a : { ...a, configuredMaxTokens: m });
      const left = a.reserveMfen - a.spentMfen;
      const inputCost = (BigInt(a.requestBytes) * a.inMfenPerM + 999_999n) / 1_000_000n;
      const minimumOutputCost = (256n * a.outMfenPerM + 999_999n) / 1_000_000n;
      const tooSmall = m !== undefined && m < 256;
      if (left <= inputCost || left < inputCost + minimumOutputCost || tooSmall) {
        expect(allowance).toBeNull();
        return;
      }
      expect(allowance).not.toBeNull();
      const { maxTokens, worstMfen } = allowance!;
      const outputCost = (BigInt(maxTokens) * a.outMfenPerM + 999_999n) / 1_000_000n;
      expect(maxTokens).toBeGreaterThanOrEqual(256);
      if (m !== undefined) expect(maxTokens).toBeLessThanOrEqual(m);
      expect(worstMfen).toBe(inputCost + outputCost);
      expect(worstMfen).toBeLessThanOrEqual(left);
    }),
    propParams(),
  );
});
