// B2-02x source of a recalculation (claude-independent, SPEC_REF ba6655b1; approvals 112): D10-2084 —
// when a recalculation calls the balance-recovered hook (or would carry a voucher), its source is
// `recalc:<recon_diff_id>:<the balance row's version after the recalculation>`, so two recalculations
// of one difference that each bring the member back to ≥ 0 (two versions) have two different sources.
// The pair of this source is notification's dedupe key balance_corrected:{reconDiffId}:{balanceVersion}
// (B2-02z), seen end to end in notice.int.test.ts. Pure: balanceRecalcSourceRef and planBalanceRecalc of
// apps/api/src/modules/ledger/application/admin-recon-diff-balance-recalc.ts. Top-level it() only.
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  balanceRecalcSourceRef,
  planBalanceRecalc,
  type BalanceRecalcCache,
} from '../../../../apps/api/src/modules/ledger/application/admin-recon-diff-balance-recalc.ts';

const DIFF = '0193a6b2-4c1d-7e8f-9a0b-1c2d3e4f5a6b';
const OTHER_DIFF = '0193a6b2-4c1d-7e8f-9a0b-1c2d3e4f5a6c';
const DAY = '2026-11-18';
const EARLIER = '2026-10-02';
const MAX = 9_223_372_036_854_775_807n;

it('[AC-B2-02x#46] D10-2084 来源号格式：recalc:<recon_diff_id>:<重算后余额版本号>（版本号十进制，不补零、不带符号）', () => {
  expect(balanceRecalcSourceRef({ reconDiffId: DIFF, version: 8n })).toBe(`recalc:${DIFF}:8`);
  expect(balanceRecalcSourceRef({ reconDiffId: DIFF, version: 1n })).toBe(`recalc:${DIFF}:1`);
  expect(balanceRecalcSourceRef({ reconDiffId: DIFF, version: 120n })).toBe(`recalc:${DIFF}:120`);
  expect(balanceRecalcSourceRef({ reconDiffId: DIFF, version: MAX })).toBe(
    `recalc:${DIFF}:9223372036854775807`,
  );
  expect(balanceRecalcSourceRef({ reconDiffId: OTHER_DIFF, version: 8n })).toBe(
    `recalc:${OTHER_DIFF}:8`,
  );
});

it('[AC-B2-02x#47] 同一差错单两次回正（两个不同的重算后版本）→ 两个不同来源号：缓存 −200（version 7）按分录 500 回正得版本 8，缓存再漂成 −200 后再回正得版本 9，来源号分别是 …:8 与 …:9', () => {
  const first: BalanceRecalcCache = {
    available_fen: -200n,
    frozen_fen: 0n,
    negative_since: EARLIER,
    version: 7n,
  };
  const once = planBalanceRecalc({
    cache: first,
    sums: { available_fen: 500n, frozen_fen: 0n },
    accountingDay: DAY,
  });
  expect(once).toMatchObject({ kind: 'write', recovered: true, version: 8n });
  const second: BalanceRecalcCache = { ...first, version: 8n };
  const twice = planBalanceRecalc({
    cache: second,
    sums: { available_fen: 500n, frozen_fen: 0n },
    accountingDay: DAY,
  });
  expect(twice).toMatchObject({ kind: 'write', recovered: true, version: 9n });
  const refs = [once, twice].map((p) =>
    balanceRecalcSourceRef({
      reconDiffId: DIFF,
      version: p.kind === 'write' ? p.version : -1n,
    }),
  );
  expect(refs).toEqual([`recalc:${DIFF}:8`, `recalc:${DIFF}:9`]);
  expect(new Set(refs).size, '两次回正两个来源号').toBe(2);
});

it('[AC-B2-02x#48] 性质：来源号按「:」拆开恰好是 recalc、差错单 id、版本号十进制；同一差错单不同版本的来源号不同，不同差错单同一版本的来源号也不同', () => {
  fc.assert(
    fc.property(
      fc.uuid(),
      fc.uuid(),
      fc.bigInt({ min: 1n, max: MAX }),
      fc.bigInt({ min: 1n, max: MAX }),
      (diffId, otherId, version, otherVersion) => {
        const ref = balanceRecalcSourceRef({ reconDiffId: diffId, version });
        expect(ref).toBe(`recalc:${diffId}:${version.toString()}`);
        expect(ref.split(':')).toEqual(['recalc', diffId, version.toString()]);
        const again = balanceRecalcSourceRef({ reconDiffId: diffId, version: otherVersion });
        expect(again === ref).toBe(otherVersion === version);
        const elsewhere = balanceRecalcSourceRef({ reconDiffId: otherId, version });
        expect(elsewhere === ref).toBe(otherId === diffId);
        return true;
      },
    ),
    propParams(),
  );
}, 900_000);
