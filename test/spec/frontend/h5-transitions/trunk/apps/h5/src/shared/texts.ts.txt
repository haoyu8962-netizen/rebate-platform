// The ambient type of the `?h5-texts&lang.json` import lives in a script .d.ts; projects that only
// reach this module through imports (test/) need the reference to see it.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- a global .d.ts cannot be imported
/// <reference path="../texts/contract-dictionary.d.ts" />
import contractDictionary from '../../../../contracts/texts.default.json?h5-texts&lang.json';
import { shellTexts } from '../texts/shell.ts';

interface TextDictionary {
  texts: Readonly<Record<string, string>>;
  fallbacks: Readonly<Record<string, string>>;
}

// The bundled default dictionary (contracts/texts.default.json, BR-TEXT-12). The query keeps the
// JSON outside this package's TypeScript project; `lang.json` keeps Vite's JSON handling. A
// production build replaces it with only the keys H5 source references (F1-01t,
// apps/h5/build/trim-texts-plugin.ts); the dev server and Vitest, which do not load that plugin,
// read the complete contract dictionary.
const dictionary: TextDictionary = contractDictionary;

const PLACEHOLDER = /\{([a-z][a-z0-9_]*)\}/g;

function own(record: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * Resolve contract texts, contract fallbacks, then the shell's registered local dictionary.
 * A contract text whose placeholder has no value uses the contract fallback for that key
 * (「变量缺失时」); an unknown key renders as an empty string, never as the key itself.
 */
export function t(key: string, params: Readonly<Record<string, string>> = {}): string {
  const text = own(dictionary.texts, key);
  if (text !== undefined) {
    let missing = false;
    const filled = text.replace(PLACEHOLDER, (whole, name: string) => {
      const value = own(params, name);
      if (value === undefined) {
        missing = true;
        return whole;
      }
      return value;
    });
    if (!missing) return filled;
    return own(dictionary.fallbacks, key) ?? filled;
  }
  return own(dictionary.fallbacks, key) ?? own(shellTexts, key) ?? '';
}
