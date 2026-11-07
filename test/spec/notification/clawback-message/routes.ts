// B1-12zc jump targets (contracts/routes.json OrderDetail and Ledger; BR-TEXT-09 上级隐私 l.613;
// D10-773 ⑤). No imports: the render unit tests use these without the database kit.

/** The order detail of exactly this order (self and share). */
export function orderDetail(orderId: string) {
  return { route: 'OrderDetail', params: { order_id: orderId } };
}

/** True for the wallet ledger without any parameter (上级隐私: no order, no product, no downline). */
export function isLedger(route: unknown): boolean {
  if (typeof route !== 'object' || route === null) return false;
  const target = route as { readonly route?: unknown; readonly params?: unknown };
  const extra = Object.keys(target).filter((key) => key !== 'route' && key !== 'params');
  const params = target.params ?? {};
  return (
    target.route === 'Ledger' &&
    extra.length === 0 &&
    typeof params === 'object' &&
    params !== null &&
    Object.keys(params).length === 0
  );
}
