// Controllable `prefers-reduced-motion` for the admin-motion browser tests. Import this module
// before anything that loads the admin app, so even a query made while the app's modules load
// gets the controllable list. Other media queries go to the browser's own matchMedia.
type ChangeListener = EventListenerOrEventListenerObject;

interface ControlledList {
  readonly media: string;
  readonly listeners: Set<ChangeListener>;
  readonly list: MediaQueryList;
}

const browserMatchMedia = window.matchMedia.bind(window);
const lists: ControlledList[] = [];
let reduce = false;

function matchesFor(media: string): boolean {
  return /no-preference/.test(media) ? !reduce : reduce;
}

function controlledList(media: string): MediaQueryList {
  const listeners = new Set<ChangeListener>();
  const list = {
    media,
    get matches(): boolean {
      return matchesFor(media);
    },
    onchange: null,
    addListener(listener: ChangeListener | null): void {
      if (listener !== null) listeners.add(listener);
    },
    removeListener(listener: ChangeListener | null): void {
      if (listener !== null) listeners.delete(listener);
    },
    addEventListener(type: string, listener: ChangeListener | null): void {
      if (type === 'change' && listener !== null) listeners.add(listener);
    },
    removeEventListener(type: string, listener: ChangeListener | null): void {
      if (type === 'change' && listener !== null) listeners.delete(listener);
    },
    dispatchEvent(): boolean {
      return true;
    },
  } as unknown as MediaQueryList;
  lists.push({ media, listeners, list });
  return list;
}

window.matchMedia = (media: string): MediaQueryList =>
  /prefers-reduced-motion/.test(media) ? controlledList(media) : browserMatchMedia(media);

/** Sets the system preference and fires `change` on every reduced-motion list handed out. */
export function setReducedMotion(next: boolean): void {
  if (reduce === next) return;
  reduce = next;
  for (const { media, listeners, list } of lists) {
    const event = new MediaQueryListEvent('change', { matches: list.matches, media });
    for (const listener of [...listeners]) {
      if (typeof listener === 'function') listener.call(list, event);
      else listener.handleEvent(event);
    }
    list.onchange?.call(list, event);
  }
}
