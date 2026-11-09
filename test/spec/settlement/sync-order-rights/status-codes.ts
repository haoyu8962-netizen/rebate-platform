// B2-04zzr test double of the pdd status map (claude-independent, SPEC_REF b1410c4f). The
// production worker reads specs/order-status-map/pdd.csv, which has no code for PLATFORM_INVALID or
// PLATFORM_PUNISH yet (BR-FUND-02: pdd 4 / 10 are still waiting for 规划/09 实测; the three maps carry
// no punish code at all). Each test file mocks orders' domain/status-map.ts with withSyntheticCodes,
// so loadStatusMap('pdd', …) also knows two synthetic codes; every other platform, code and the parser
// itself stay real. Only `import type` here: the mock factory imports this file while the module
// graph is being mocked.
import type * as StatusMapSource from '../../../../apps/api/src/modules/orders/domain/status-map.ts';

export type StatusMapModule = typeof StatusMapSource;

/** Maps to PLATFORM_INVALID: on a SETTLED order that is P7, before settlement P6 (BR-FUND-01). */
export const SYNTHETIC_INVALID = 'synthetic-invalid';
/** Maps to PLATFORM_PUNISH: P8 on PAID / RECEIVED / SETTLED (BR-FUND-01, BR-FUND-02). */
export const SYNTHETIC_PUNISH = 'synthetic-punish';

const ROWS = [
  `${SYNTHETIC_INVALID},PLATFORM_INVALID,test,false,测试替身（失效）`,
  `${SYNTHETIC_PUNISH},PLATFORM_PUNISH,test,false,测试替身（处罚）`,
];

/** The real module whose loadStatusMap appends the synthetic rows to the pdd file. */
export function withSyntheticCodes(actual: StatusMapModule): StatusMapModule {
  return {
    ...actual,
    loadStatusMap(platform: string, csvText: string | null) {
      const text =
        platform === 'pdd' && csvText !== null
          ? `${csvText.trimEnd()}\n${ROWS.join('\n')}\n`
          : csvText;
      return actual.loadStatusMap(platform, text);
    },
  };
}
