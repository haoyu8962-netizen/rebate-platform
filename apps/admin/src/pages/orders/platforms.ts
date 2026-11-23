import type { Schema } from '@couli/contracts-ts';

type PlatformCode = Schema<'PlatformCode'>;

export type PlatformConfig = {
  readonly code: PlatformCode;
  readonly label: string;
  readonly extraColumns: readonly (keyof Schema<'AdminOrderListItem'>)[];
  readonly detailFields: readonly (keyof Schema<'AdminOrderDetail'>)[];
};

export function platformCodes(): readonly PlatformCode[] {
  throw new Error('NotImplemented: platformCodes');
}

export function platformConfig(code: PlatformCode): PlatformConfig {
  void code;
  throw new Error('NotImplemented: platformConfig');
}
