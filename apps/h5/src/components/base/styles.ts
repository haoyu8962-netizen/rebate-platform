// Shared class lists for the base components. Token aliases only (@couli/ui-tokens tailwind.css).

/** Keyboard focus ring: focus colour, focus width and focus offset tokens (`:focus-visible`). */
export const FOCUS_RING =
  'focus-visible:outline-solid focus-visible:outline-[length:var(--focus-width)] focus-visible:outline-offset-[var(--focus-offset)] focus-visible:outline-couli-focus-ring';

const BUTTON_BASE = `min-h-couli-component-button-min-height cursor-pointer rounded-couli-button px-couli-component-button-padding-inline py-couli-component-button-padding-block text-couli-body leading-couli-body ${FOCUS_RING}`;

/** Main button: brand fill, inverse text 17/600 (GUIDE §3). */
export const PRIMARY_BUTTON = `${BUTTON_BASE} bg-couli-button-primary-default-background font-couli-semibold text-couli-button-primary-default-text active:bg-couli-button-primary-pressed-background active:text-couli-button-primary-pressed-text`;

/** Secondary button: same size, surface fill with a control border, 17/500. */
export const SECONDARY_BUTTON = `${BUTTON_BASE} border border-couli-border-control bg-couli-background-surface font-couli-medium text-couli-text-primary active:bg-couli-background-muted`;

/** Button row inside dialogs and sheets: equal widths, wraps with the main button on top. */
export const ACTION_ROW = 'flex flex-none flex-wrap-reverse gap-couli-3';
export const ACTION_IN_ROW = 'flex-1 basis-0 min-w-max whitespace-nowrap';

/** Overlay layers: fixed, above page content, token font family. */
export const LAYER = 'fixed z-50 font-couli-system';

/**
 * Light notices: fixed and one step above `LAYER`, so a notice stays visible over sheets and
 * dialogs opened after its region was created (regions are never moved, to keep screen readers
 * registered on them).
 */
export const TOAST_LAYER = 'fixed z-60 font-couli-system';

// --- Pressables (DSX-46): every clickable base component changes its painted look on `:active`
// (background, opacity or both) and shows FOCUS_RING. The WebView tap highlight is cleared
// globally in shared/styles/index.css.

/** Shared layout of the Button component; the variant adds colours and size. */
const PRESSABLE_LAYOUT =
  'relative inline-flex items-center justify-center gap-couli-component-button-gap';

/** Button variants: primary / secondary reuse the legacy class lists, so both stay in step. */
export const BUTTON_VARIANT = {
  primary: `${PRIMARY_BUTTON} ${PRESSABLE_LAYOUT} disabled:cursor-default disabled:bg-couli-button-primary-disabled-background disabled:text-couli-button-primary-disabled-text`,
  secondary: `${SECONDARY_BUTTON} ${PRESSABLE_LAYOUT} disabled:cursor-default disabled:bg-couli-background-surface disabled:text-couli-text-secondary`,
  text: `${PRESSABLE_LAYOUT} min-h-couli-component-button-min-height cursor-pointer rounded-couli-button px-couli-3 py-couli-component-button-padding-block text-couli-body leading-couli-body font-couli-medium text-couli-text-link active:bg-couli-background-muted active:opacity-70 disabled:cursor-default disabled:text-couli-text-secondary disabled:active:bg-transparent disabled:active:opacity-100 ${FOCUS_RING}`,
  icon: `${PRESSABLE_LAYOUT} min-h-couli-interaction-target-minimum min-w-couli-interaction-target-minimum cursor-pointer rounded-couli-pill text-couli-text-primary active:bg-couli-background-muted active:opacity-70 disabled:cursor-default disabled:text-couli-text-secondary disabled:active:bg-transparent disabled:active:opacity-100 ${FOCUS_RING}`,
} as const;

/** Label wrapper inside Button: lays out icon + text with the button gap. */
export const BUTTON_LABEL =
  'inline-flex items-center justify-center gap-couli-component-button-gap';

/** Busy indicator inside a loading button: covers the button, centred, label stays laid out. */
export const BUTTON_LOADING = 'absolute inset-0 flex items-center justify-center';
export const BUTTON_SPINNER =
  'size-couli-component-icon-inline rounded-couli-pill border-2 border-current border-t-transparent motion-safe:animate-spin';

const CHIP_BASE = `inline-flex min-h-couli-component-chip-height cursor-pointer items-center justify-center rounded-couli-pill border px-couli-3 py-couli-1 text-couli-footnote leading-couli-footnote disabled:cursor-default ${FOCUS_RING}`;

/** Chip: unselected surface pill, selected brand-subtle pill; pressed darkens / dims. */
export const CHIP = {
  unselected: `${CHIP_BASE} border-couli-border-control bg-couli-background-surface font-couli-regular text-couli-text-primary active:bg-couli-background-muted disabled:text-couli-text-secondary`,
  selected: `${CHIP_BASE} border-couli-brand-primary bg-couli-brand-subtle font-couli-medium text-couli-brand-emphasis active:opacity-70 disabled:active:opacity-100`,
} as const;

/** Segmented: muted track, the checked option is a raised surface. */
export const SEGMENTED_GROUP =
  'inline-flex items-stretch gap-couli-1 rounded-couli-pill bg-couli-background-muted p-couli-1';
const SEGMENT_BASE = `inline-flex min-h-couli-component-chip-height flex-1 cursor-pointer items-center justify-center rounded-couli-pill px-couli-3 py-couli-1 text-couli-footnote leading-couli-footnote ${FOCUS_RING}`;
export const SEGMENT = {
  unchecked: `${SEGMENT_BASE} font-couli-regular text-couli-text-secondary active:bg-couli-background-surface`,
  checked: `${SEGMENT_BASE} bg-couli-background-surface font-couli-semibold text-couli-text-primary shadow-couli-card active:opacity-70`,
} as const;

/** Card: surface panel; clickable cards add the pressed fill and the focus ring. */
export const CARD =
  'block w-full rounded-couli-card bg-couli-background-surface p-couli-4 text-start text-couli-text-primary shadow-couli-card';
export const CARD_CLICKABLE = `${CARD} cursor-pointer active:bg-couli-background-muted ${FOCUS_RING}`;

/** List row: title / subtitle column and a trailing accessory. */
export const LIST_ROW = `flex w-full min-h-couli-interaction-target-minimum items-center gap-couli-3 bg-couli-background-surface px-couli-4 py-couli-3 text-start text-couli-text-primary`;
export const LIST_ROW_CLICKABLE = `${LIST_ROW} cursor-pointer active:bg-couli-background-muted ${FOCUS_RING}`;
export const LIST_ROW_TEXT = 'flex min-w-0 flex-1 flex-col';
export const LIST_ROW_TITLE = 'text-couli-body leading-couli-body text-couli-text-primary';
export const LIST_ROW_SUBTITLE =
  'text-couli-footnote leading-couli-footnote text-couli-text-secondary';
export const LIST_ROW_TRAILING = 'flex flex-none items-center text-couli-text-secondary';
