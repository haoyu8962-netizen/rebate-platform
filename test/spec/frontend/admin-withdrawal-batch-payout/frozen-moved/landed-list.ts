/** Write entries already landed on the list for every write point (F1-08an), never pressed here. */
export const LANDED_ON_LIST = ['一键组批'];
/** An entry's accessible name or text, spaces removed. */
export function nameOf(node: HTMLElement): string {
  return (node.getAttribute('aria-label') || node.textContent || '').replace(/\s+/g, '');
}
