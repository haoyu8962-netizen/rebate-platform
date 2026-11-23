// Taobao OAuth callback relay page (F1-11d): clear the query string from the address bar, then
// hand a whitelisted result to the App. Nothing else runs here: no requests, storage, cookies,
// logging, tracking or deferred resource loads. The static prompt lives in index.html.
import { callbackTarget } from './callback.ts';

const target = callbackTarget(location.search);
history.replaceState(null, '', location.pathname);
if (target !== null) location.replace(target);
