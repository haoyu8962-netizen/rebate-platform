// B1-08zh (D10-574, FU-PDD-NET-N): process-local counter couli_pdd_service_fee_missing_total, one
// increment per pdd report that lacks the service fee on an order that already has an estimate (a
// new order goes to the pending table instead). It carries no amount and no order number. The alert
// is in infra/monitoring/rules/couli.yaml. Rule tests: test/spec/union/pdd-net-n/metrics.test.ts.
let missing = 0;

export function countPddServiceFeeMissing(): void {
  missing += 1;
}

export function pddServiceFeeMissingTotal(): number {
  return missing;
}
