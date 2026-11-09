// B1-06zl (BR-PROD-10, BR-TEXT-14 50301 行, D10-1138 / D10-1139 选 A): the error data of the one
// 50301 that means "convert.enabled.<platform> is off" — exactly { platform, reason }, the reason
// read from convert.off_reason.<platform> through the same configuration reader (content's
// config_items) that GET /v1/config's features.platform_status reads. A missing or unrecognised
// value takes content's switch registry default for that key (04 §10.2: not_launched); linking
// keeps no default of its own. Every other 50301 (no slot, attr_code, union account, jump path,
// a Pinduoduo site authorization expired) keeps its own data and never comes through here.
import { switchSpecOf } from '../../content/index.ts';
import type { LinkingConfigReader } from '../ports.ts';

export type ConvertOffReason = 'maintenance' | 'not_launched';

/** contracts/error-codes.yaml 50301 data of a switched-off platform. */
export interface ConvertPausedData {
  readonly platform: string;
  readonly reason: ConvertOffReason;
}

/** The configuration key of a platform's off reason (04 §10.2). */
export function convertOffReasonKey(platform: string): string {
  return `convert.off_reason.${platform}`;
}

function isOffReason(value: unknown): value is ConvertOffReason {
  return value === 'maintenance' || value === 'not_launched';
}

/**
 * The reason of a stored value: the value when it is one the registry's enum declares, else the
 * registry default of the key (its per-platform override first). Throws when the registry has no
 * usable entry: a programming error, never a reason made up here.
 */
export function convertOffReasonOf(platform: string, value: unknown): ConvertOffReason {
  const key = convertOffReasonKey(platform);
  const spec = switchSpecOf(key);
  if (spec === null) throw new Error(`linking: ${key} is not a registered switch`);
  const declared = spec.valueType.kind === 'enum' ? spec.valueType.values : [];
  if (isOffReason(value) && declared.includes(value)) return value;
  const fallback = spec.defaultOverrides[platform] ?? spec.defaultValue;
  if (!isOffReason(fallback)) throw new Error(`linking: ${key} has no usable default`);
  return fallback;
}

/** Reads convert.off_reason.<platform> of the app: the 50301 data of the switched-off platform. */
export async function convertPausedData(
  config: LinkingConfigReader,
  appId: string,
  platform: string,
): Promise<ConvertPausedData> {
  const stored = await config.configValue(appId, convertOffReasonKey(platform));
  return { platform, reason: convertOffReasonOf(platform, stored?.value) };
}

/** The switched-off data a paused failure carries (only the switch sets it); else undefined. */
export function pausedDataOf(error: unknown): ConvertPausedData | undefined {
  const data = (error as { readonly data?: unknown } | null)?.data;
  if (typeof data !== 'object' || data === null) return undefined;
  const { platform, reason } = data as { readonly platform?: unknown; readonly reason?: unknown };
  return typeof platform === 'string' && isOffReason(reason) ? { platform, reason } : undefined;
}
