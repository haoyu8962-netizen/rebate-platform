// Admin viewport tiers (适配约定「后台 · 视口分档」, 03 §10.4 后台行; DSX-51): the only place in the
// admin that names viewport widths. Everything else reads the tier: shell components through
// `useAdminTier`, page and component style sheets through `html[data-admin-tier]`.
import { useLayoutEffect, useSyncExternalStore } from 'react';

/** ≥1440 wide; 1280–1439 standard; 960–1279 compact; below 960 narrow. */
export type AdminTier = 'wide' | 'standard' | 'compact' | 'narrow';

/** Narrowest first: the first query that matches names the tier; none matches: wide. */
const TIER_QUERIES: readonly (readonly [AdminTier, string])[] = [
  ['narrow', '(width < 960px)'],
  ['compact', '(width < 1280px)'],
  ['standard', '(width < 1440px)'],
];

/** The document attribute style sheets select on (`html[data-admin-tier='compact'] …`). */
const TIER_ATTRIBUTE = 'adminTier';

function mediaLists(): MediaQueryList[] {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return [];
  return TIER_QUERIES.map(([, query]) => window.matchMedia(query));
}

function currentTier(): AdminTier {
  const lists = mediaLists();
  for (const [index, [tier]] of TIER_QUERIES.entries())
    if (lists[index]?.matches === true) return tier;
  return 'wide';
}

function subscribe(onChange: () => void): () => void {
  const lists = mediaLists().filter((list) => typeof list.addEventListener === 'function');
  for (const list of lists) list.addEventListener('change', onChange);
  return () => {
    for (const list of lists) list.removeEventListener('change', onChange);
  };
}

function serverTier(): AdminTier {
  return 'wide';
}

/** The current tier; re-renders when the viewport crosses a tier edge. */
export function useAdminTier(): AdminTier {
  return useSyncExternalStore(subscribe, currentTier, serverTier);
}

/** `useAdminTier`, and the tier written to `<html data-admin-tier>` for style sheets. */
export function usePublishedAdminTier(): AdminTier {
  const tier = useAdminTier();
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset[TIER_ATTRIBUTE] = tier;
    return () => {
      Reflect.deleteProperty(root.dataset, TIER_ATTRIBUTE);
    };
  }, [tier]);
  return tier;
}
