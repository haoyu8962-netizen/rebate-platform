// The token type of the rule-test lexer (test-blocks.ts tokenize), on its own so that
// test-blocks.ts and support-tokens.ts can both use it without importing each other
// (CT-06zzzzzi; dependency-cruiser no-circular). Types only.

export type Token = {
  kind: 'id' | 'num' | 'str' | 'tpl' | 're' | 'punct';
  /** Raw source text (a template literal includes its `${…}` expressions). */
  text: string;
  /** A line break occurs in the whitespace or comments before the token. */
  nl: boolean;
  /** Offset of the token in the source. */
  start?: number;
  /** The exact whitespace and comments between the previous token and this one. */
  gap?: string;
  /** str: the cooked value (null when an escape cannot be decoded for certain). */
  value?: string | null;
  /** tpl: the cooked static parts around the `${…}` expressions (null when not decodable). */
  parts?: (string | null)[];
  /** tpl: the tokens of its `${…}` expressions, in order. */
  inner?: Token[];
};
