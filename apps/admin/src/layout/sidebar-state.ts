// Shared sidebar state of the admin shell: the top bar's toggle and the sidebar are siblings in
// App.tsx, so they meet here (one shell per document). The sidebar opens in every tier; the
// toggle's choice holds until the tier changes or the shell mounts again.
import { useSyncExternalStore } from 'react';
import type { AdminTier } from './viewport.ts';

/** The sidebar element's id (the toggle's aria-controls). */
export const SIDEBAR_ID = 'admin-sidebar';

interface SidebarState {
  /** The toggle's choice, valid only for the tier it was made in. */
  readonly override: { readonly tier: AdminTier; readonly open: boolean } | undefined;
}

let state: SidebarState = { override: undefined };
const listeners = new Set<() => void>();

function update(next: SidebarState): void {
  if (next.override === state.override) return;
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): SidebarState {
  return state;
}

export function useSidebarState(): SidebarState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function sidebarOpen(current: SidebarState, tier: AdminTier): boolean {
  return current.override?.tier === tier ? current.override.open : true;
}

export function setSidebarOpen(tier: AdminTier, open: boolean): void {
  update({ override: { tier, open } });
}

/** Back to open (a newly mounted shell). */
export function resetSidebar(): void {
  update({ override: undefined });
}
