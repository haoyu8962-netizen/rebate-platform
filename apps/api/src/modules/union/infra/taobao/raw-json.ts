// B1-04zzzzj：淘宝报文「数字保原文」的解析树与写回只在这里一份（原 orders.ts rawJsonText、
// punishments.ts / refunds.ts 两份 literalJson 逐字相同，合一后输出逐字节不变）。类放这里而不是
// orders.ts，是为了 orders.ts 引用写回函数时不成环（no-circular）；orders.ts 照旧再导出它。

/** A JSON number of the order body, kept as its literal (only made by parseTaobaoOrderBody). */
export class TaobaoRawNumber {
  readonly text: string;

  constructor(text: string) {
    this.text = text;
  }
}

/**
 * B1-04zzzzj: JSON text of a parseTaobaoRawData tree, every TaobaoRawNumber written as its literal
 * (replaces orders.ts rawJsonText and the two literalJson copies in punishments.ts / refunds.ts).
 */
export function taobaoRawJsonText(value: unknown): string {
  if (value instanceof TaobaoRawNumber) return value.text;
  if (Array.isArray(value)) return `[${value.map(taobaoRawJsonText).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const members = Object.entries(value).map(
      ([name, member]) => `${JSON.stringify(name)}:${taobaoRawJsonText(member)}`,
    );
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value);
}
