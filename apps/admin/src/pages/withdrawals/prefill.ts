// 提现审核列表的预填地址（F1-08fe）：核销被拦（20001 writeoff_frozen_pending，拒绝回答里没有提现单号）
// 时【去处理提现单】链到提现审核列表并带上该用户筛选：/withdrawals?user_id=…（参数名同
// listAdminWithdrawals）；列表进页时按地址预填「用户 ID」并照常读取（draftFromSearch）。

/** The 提现审核 list filtered to one user: /withdrawals?user_id=… */
export function userWithdrawalsRoute(userId: string): string {
  void userId;
  throw new Error('NotImplemented: userWithdrawalsRoute');
}
