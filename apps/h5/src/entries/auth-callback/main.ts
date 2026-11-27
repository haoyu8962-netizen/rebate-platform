// Taobao OAuth callback relay page (F1-11d, F1-11da): clear the query string from the address
// bar, then hand a whitelisted result to the App. Nothing else runs here: no requests, storage,
// cookies, logging, tracking or deferred resource loads. The static texts live in index.html.
import { callbackTarget } from './callback.ts';

/**
 * Tappable fallback for browsers that block a non-gesture jump to a custom scheme (D10-3567):
 * the inert `#return-link` template from index.html, its link pointed at the same deep link,
 * placed where the template sits (right after the static prompt).
 */
function showReturnLink(target: string): void {
  const template = document.getElementById('return-link');
  if (!(template instanceof HTMLTemplateElement)) return;
  const fragment = document.importNode(template.content, true);
  const link = fragment.querySelector('a');
  if (link === null) return;
  link.setAttribute('href', target);
  template.replaceWith(fragment);
}

const target = callbackTarget(location.search);
history.replaceState(null, '', location.pathname);
if (target !== null) {
  showReturnLink(target);
  location.replace(target);
}
