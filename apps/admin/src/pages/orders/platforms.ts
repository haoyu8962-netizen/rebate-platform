// Per-platform settings of the order pages (F1-07ed): the display name and the contract fields a
// platform adds to the list (extra columns, hidden by default) and to the detail. Pages read the
// differences between platforms from here only, never by comparing a platform code inline. The
// order follows the contract enum (contracts/enums/platform.yaml). No platform has a field of its
// own in AdminOrderListItem / AdminOrderDetail yet, so every list below is empty; a field joins a
// platform here only once the contract carries it and it has been checked against real records.
import { platform, type Schema } from '@couli/contracts-ts';
import { ordersTexts as t } from '../../texts/orders.ts';

type PlatformCode = Schema<'PlatformCode'>;

export type PlatformConfig = {
  readonly code: PlatformCode;
  readonly label: string;
  readonly extraColumns: readonly (keyof Schema<'AdminOrderListItem'>)[];
  readonly detailFields: readonly (keyof Schema<'AdminOrderDetail'>)[];
};

const CODES: readonly PlatformCode[] = platform;

const CONFIGS: ReadonlyMap<PlatformCode, PlatformConfig> = new Map(
  CODES.map((code) => [
    code,
    {
      code,
      label: t.platforms[code] ?? code,
      extraColumns: [],
      detailFields: [],
    } satisfies PlatformConfig,
  ]),
);

/** The platform codes in contract order. */
export function platformCodes(): readonly PlatformCode[] {
  return CODES;
}

/** The settings of one platform. */
export function platformConfig(code: PlatformCode): PlatformConfig {
  const config = CONFIGS.get(code);
  if (config === undefined) throw new Error(`Unknown platform ${code}`);
  return config;
}

/** The list columns added by any platform, each once, in platform order. */
export function platformExtraColumns(): readonly (keyof Schema<'AdminOrderListItem'>)[] {
  const seen: (keyof Schema<'AdminOrderListItem'>)[] = [];
  for (const code of CODES)
    for (const field of platformConfig(code).extraColumns)
      if (!seen.includes(field)) seen.push(field);
  return seen;
}
