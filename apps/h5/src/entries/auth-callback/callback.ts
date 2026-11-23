// Taobao OAuth callback relay (F1-11d, D10-2716 ② / D10-2717): decides where the page sends the
// browser. Only a whitelisted code / state pair (or a whitelisted state on a denied grant) ever
// reaches the App deep link; every other query parameter is dropped.

const DEEP_LINK = 'couli://auth/taobao';

/** Whole-value whitelist for `code` and `state`, checked after a single percent-decode. */
const TOKEN = /^[A-Za-z0-9_-]{1,256}$/;

/** First value of `name` when it passes the whitelist, otherwise null. */
function token(params: URLSearchParams, name: string): string | null {
  const value = params.get(name);
  return value !== null && TOKEN.test(value) ? value : null;
}

/**
 * Deep link for the callback query string `search` (`location.search`), or null when the page
 * must not redirect and only shows the static prompt. A present `error` (any value) wins over
 * `code`: the App only learns the grant did not finish, never the error text.
 */
export function callbackTarget(search: string): string | null {
  const params = new URLSearchParams(search);
  const state = token(params, 'state');
  if (state === null) return null;
  if (params.has('error')) {
    return `${DEEP_LINK}?state=${encodeURIComponent(state)}&error=1`;
  }
  const code = token(params, 'code');
  if (code === null) return null;
  return `${DEEP_LINK}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
}
