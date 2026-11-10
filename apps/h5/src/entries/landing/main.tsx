// App-external landing pages (规划/03 §8.2): no bridge, no token manager, and a first screen that
// does not depend on React (blocked B-6, default A). The share page (F1-11a) is plain DOM, so no
// React DOM `createRoot` runs here and the whole first-screen JS stays inside the 03 §12 budget.
import '../../shared/styles/index.css';
import { buildAppVersion } from './app-version.ts';
import { createShareApi } from './share-api.ts';
import { linkIdFromPath, parseMediaOrigins } from './share-format.ts';
import { renderLandingShell } from './render.ts';
import { mountSharePage } from './share-page.ts';

/** Build-time value as a trimmed string; missing or blank becomes null (Vite inlines these). */
function buildValue(
  name: 'VITE_API_BASE_URL' | 'VITE_APP_ID' | 'VITE_MEDIA_ORIGINS',
): string | null {
  const env: Partial<Record<string, unknown>> = import.meta.env;
  const value = env[name];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

const container = document.getElementById('root');
if (container === null) throw new Error('apps/h5 landing entry: #root is missing');

const apiBaseUrl = buildValue('VITE_API_BASE_URL');
const appId = buildValue('VITE_APP_ID');
const appVersion = buildAppVersion();

if (apiBaseUrl === null || appId === null || appVersion === null) {
  // A build without API base URL, brand or a SemVer build version cannot serve share pages: keep
  // the page-pending shell (no same-origin fallback, no guessed brand or version, no request).
  renderLandingShell(container);
} else {
  mountSharePage(container, {
    api: createShareApi({ apiBaseUrl, appId, appVersion }),
    linkId: linkIdFromPath(window.location.pathname),
    userAgent: window.navigator.userAgent,
    mediaOrigins: parseMediaOrigins(buildValue('VITE_MEDIA_ORIGINS')),
    now: () => Date.now(),
    // Read on tap: the Clipboard API may be missing (old WebViews, non-secure origins).
    clipboard: {
      writeText: async (value) => {
        const clipboard = window.navigator.clipboard as Clipboard | undefined;
        if (clipboard === undefined || typeof clipboard.writeText !== 'function') {
          throw new Error('clipboard unavailable');
        }
        await clipboard.writeText(value);
      },
    },
  });
}
