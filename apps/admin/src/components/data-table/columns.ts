// F1-07ec: the column settings of a DataTable (order and visibility), kept in localStorage under
// the table's storageKey. Whatever is read back is checked: anything that is not exactly the saved
// shape (bad JSON, another shape, unknown or repeated column keys, missing or mistyped fields, no
// visible column) counts as no setting, so the default columns show. Reading and writing never
// throw: a blocked or full storage is the same as no setting / an unsaved change.

export interface ColumnSetting {
  readonly key: string;
  readonly visible: boolean;
}

export type ColumnSettings = readonly ColumnSetting[];

interface ColumnLike {
  readonly key: string;
  readonly defaultVisible?: boolean;
}

const VERSION = 1;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The columns in their declared order, each visible unless `defaultVisible` is false. */
export function defaultSettings(columns: readonly ColumnLike[]): ColumnSettings {
  return columns.map((column) => ({ key: column.key, visible: column.defaultVisible !== false }));
}

/**
 * A stored text as settings for `columns`, or undefined when it is not a valid setting. Columns
 * declared after the setting was saved are added at the end with their default visibility.
 */
export function parseSettings(
  raw: string | null,
  columns: readonly ColumnLike[],
): ColumnSettings | undefined {
  if (raw === null) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.version !== VERSION || !Array.isArray(value.columns))
    return undefined;
  const known = new Set(columns.map((column) => column.key));
  const seen = new Set<string>();
  const settings: ColumnSetting[] = [];
  for (const item of value.columns as readonly unknown[]) {
    if (!isRecord(item)) return undefined;
    const { key, visible } = item;
    if (typeof key !== 'string' || typeof visible !== 'boolean') return undefined;
    if (!known.has(key) || seen.has(key)) return undefined;
    seen.add(key);
    settings.push({ key, visible });
  }
  for (const column of columns)
    if (!seen.has(column.key))
      settings.push({ key: column.key, visible: column.defaultVisible !== false });
  return settings.some((setting) => setting.visible) ? settings : undefined;
}

/** `settings` matched to the current columns: unknown keys dropped, new columns appended. */
export function reconcile(
  settings: ColumnSettings,
  columns: readonly ColumnLike[],
): ColumnSettings {
  const known = new Set(columns.map((column) => column.key));
  const kept = settings.filter((setting) => known.has(setting.key));
  const seen = new Set(kept.map((setting) => setting.key));
  const added = columns
    .filter((column) => !seen.has(column.key))
    .map((column) => ({ key: column.key, visible: column.defaultVisible !== false }));
  return [...kept, ...added];
}

/** The saved settings for `storageKey`, or undefined (none, invalid, or storage unavailable). */
export function readSettings(
  storageKey: string,
  columns: readonly ColumnLike[],
): ColumnSettings | undefined {
  try {
    return parseSettings(window.localStorage.getItem(storageKey), columns);
  } catch {
    return undefined;
  }
}

/** Saves `settings`; false when the storage refused (blocked, full). */
export function writeSettings(storageKey: string, settings: ColumnSettings): boolean {
  try {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        version: VERSION,
        columns: settings.map(({ key, visible }) => ({ key, visible })),
      }),
    );
    return true;
  } catch {
    return false;
  }
}
