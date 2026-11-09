// 后台备注 / 原因框的字数：按 Unicode 码点计（与契约 maxLength 经 Ajv、各接口 [...s].length 一致），
// 扩展汉字如「𠮷」算 1 个字（UTF-16 的 .length 会算成 2）。

/** Unicode code points of `text` after trimming surrounding whitespace (fields sent trimmed). */
export function codePointLength(text: string): number {
  return Array.from(text.trim()).length;
}

/** Unicode code points of `text` as is (fields sent untrimmed: kill switches, users reveal). */
export function rawCodePointLength(text: string): number {
  return Array.from(text).length;
}
