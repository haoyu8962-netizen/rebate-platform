// B1-12ze (D10-1183 / D10-1189) expected landing, written from the task brief, not the
// implementation: an order appeal's APPEAL_RESULT lands on OrderDetail { order_id: target_id }
// (same shape as the CLAWBACK self row, contracts/routes.json OrderDetail). No imports.

export function orderDetail(orderId: string) {
  return { route: 'OrderDetail', params: { order_id: orderId } };
}
