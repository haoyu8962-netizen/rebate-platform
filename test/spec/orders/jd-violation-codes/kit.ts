// B1-04zga 规则测试夹具（claude-independent，D10-867，FU-JD-VIOLATION-CODES-MAP）。
// 京东违规码照 30 的现有做法进 specs/order-status-map/jd.csv：映 PLATFORM_INVALID，source=doc、verified=false，
// 备注「无效-违规（D10-867）」。不走 PUNISH、不写子原因。报文全部合成。
// 本文件不导入 @couli/db/testing：要真库的测试把库传进来。

/** D10-867 改进表的 13 个违规码。 */
export const VIOLATION_CODES = '13 25 26 27 28 36 37 38 39 40 41 42 43'.split(' ');

/** D10-867 给这些码的备注。 */
export const VIOLATION_NOTE = '无效-违规（D10-867）';
