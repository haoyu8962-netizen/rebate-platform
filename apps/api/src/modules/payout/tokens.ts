/** Nest injection tokens of the payout module (B2-05c / B2-05d). */
export const WITHDRAW_RULES = Symbol('PAYOUT_WITHDRAW_RULES');
/** The handle the controllers read on: the process DB handle, or a test's sentinel. */
export const WITHDRAW_RULES_HANDLE = Symbol('PAYOUT_WITHDRAW_RULES_HANDLE');
/** The withdrawal application use case (POST /v1/withdrawals). */
export const WITHDRAW_APPLY = Symbol('PAYOUT_WITHDRAW_APPLY');
/** Identity's withStepUp for POST /v1/withdrawals (B2-05d); unused since B1-02zzzc (D10-1665). */
export const WITHDRAW_STEP_UP = Symbol('PAYOUT_WITHDRAW_STEP_UP');
/** The process's snapshot decryption for the withdrawal records (B2-05f), registered by app.module. */
export const WITHDRAW_READS = Symbol('PAYOUT_WITHDRAW_READS');
