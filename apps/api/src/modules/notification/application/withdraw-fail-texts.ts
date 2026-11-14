// CT-26zp (BR-TEXT-08 失败原因映射, BR-WDR-33 ⑥, D10-1525): the user copy of a withdrawal fail code,
// to be read from contracts/texts.default.json keys withdraw_fail_reason.<CODE>.title, with
// withdraw_fail_reason.default.title for an unmapped code. Skeleton only.

/** The reason sentence of a fail code; an unknown, empty or missing code gets the fallback. */
export function withdrawFailReasonText(code: string | null): string {
  void code;
  throw new Error('NotImplemented: withdrawFailReasonText');
}
