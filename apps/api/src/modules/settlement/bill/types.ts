// Shared shapes of the bill job's source and snapshot ports (moved out of job.ts for B2-18 so that
// follow-union.ts can use them without an import cycle; job.ts re-exports them unchanged).
import type { OrderRebateState } from '@couli/domain';

export interface BillSourceOrder {
  readonly orderId: string;
  readonly rebateStatus: Exclude<OrderRebateState, 'UNATTRIBUTED'>;
  readonly settlePeriod: string | null;
  readonly hold: boolean;
  readonly rightsPending: boolean;
  readonly commissionVersion: number;
  /**
   * B2-18（D10-2415 ③）起不再是月结的输入：生产来源读口恒为 false，账单任务与补充发起都不读它。
   * 字段保留到 FU-B2-18-RETIRE-UNION-CONCLUSION（冻结 kit 仍会给它）。
   */
  readonly unionAuthoritative: boolean;
  /** 同上，保留不读。 */
  readonly unionConclusions?: readonly BillUnionConclusion[];
}

/** 一张「以联盟为准」差错单的 expected_fen / actual_fen（类型保留，月结不再读）。 */
export interface BillUnionConclusion {
  readonly expectedFen: bigint;
  readonly actualFen: bigint;
}

export interface BillSourceSettlement {
  readonly seq: number;
  readonly source: 'API' | 'STATEMENT';
  readonly createdAt: Date;
  readonly settledAt: Date;
  readonly commissionFen: bigint;
}

/** 来源端口提供本 app/platform 的事实，范围、截点及最大 seq 由账单任务校验。 */
export interface BillSourceRow {
  readonly orderKey: string;
  readonly order: BillSourceOrder | null;
  readonly settlements: readonly BillSourceSettlement[];
}

/** 消费方结构类型，与 B2-04i 公开读口兼容；不把 Nest 模块图引入纯服务测试。 */
export interface BillSnapshotSelection {
  readonly appId: string;
  readonly orderId: string;
  readonly commissionVersion: number;
}

export interface BillSnapshot {
  readonly baseFen: bigint;
  readonly reserveBp: number;
  readonly beneficiaries: readonly {
    readonly userId: string;
    readonly role: 'self' | 'share' | 'direct' | 'indirect';
    readonly ratioBp: number;
    readonly initialStatus: 'active' | 'forfeited';
  }[];
  readonly forfeitedEvents: readonly {
    readonly userId: string;
    readonly role: 'self' | 'share' | 'direct' | 'indirect';
  }[];
}
