// B2-04m: the single-order credit transaction and its BeneficiaryGate port. Module-internal entry;
// settlement's index.ts re-exports what app.module needs.
export { createCreditOrder } from './credit-order.ts';
export type {
  BeneficiaryEventInput,
  CreditBeneficiaryOutcome,
  CreditOrder,
  CreditOrderDependencies,
  CreditOrderInput,
  CreditOrderResult,
  CreditRole,
  CreditSkipReason,
  CreditSnapshot,
  CreditSnapshotBeneficiary,
  CreditSnapshotSelection,
} from './credit-order.ts';
export { createBeneficiaryGate } from './beneficiary-gate.ts';
export type {
  BeneficiaryGate,
  BeneficiaryGateOptions,
  BeneficiarySelection,
  MinorSelection,
  MinorStatusReader,
} from './beneficiary-gate.ts';
