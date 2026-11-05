// GET /v1/config use case (task F1-02c): reads every key of domain/client-config.ts through the
// cached ContentReader in parallel (raw values only are cached; everything that depends on the
// caller is derived per request), then assembles the caller's Config. A failed read or a
// required key that is absent or of the wrong shape rejects (the global filter answers 50001);
// a rejected optional value falls back to its default with a warning naming the key.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import type { Logger } from 'pino';
import { MediaStoreUnavailableError, type MaterialChannelsSpec } from '../../platform/index.ts';
import {
  buildClientConfig,
  CLIENT_CONFIG_KEYS,
  inviteRewardSwitchOn,
  type ClientConfig,
  type ConfigViewer,
} from '../domain/client-config.ts';
import { configEtag, rankPlatforms } from '../domain/config-etag.ts';
import {
  BRIDGE_ORIGINS_KEY,
  BridgeOriginsSigner,
  type BridgeOriginsInput,
} from '../domain/bridge-origins.ts';
import type { ContentReader } from './content-reader.ts';
import type { InviteRewardBudgetReader } from './invite-reward-budget-reader.ts';
import type { PublishedPlatformIcons } from './published-platform-icons.ts';

/** The caller of one request, resolved by identity (content never imports identity). */
export abstract class ConfigViewerContext {
  abstract current(): Promise<ConfigViewer>;
}

export class ClientConfigUnavailableError extends Error {
  readonly keys: readonly string[];

  constructor(keys: readonly string[]) {
    super(`content: required configuration missing or malformed: ${keys.join(', ')}`);
    this.name = 'ClientConfigUnavailableError';
    this.keys = keys;
  }
}

/**
 * F1-02zzzb: where bridge_origins comes from. `item` reads the config_items row afresh on every
 * request (outside ContentReader's cache, so a console save shows on the next read); `signer`
 * answers the process's signer or throws when the signing key is unavailable.
 */
export interface BridgeOriginsSource {
  readonly env: BridgeOriginsInput['env'];
  item(appId: string): Promise<BridgeOriginsInput['item']>;
  signer(): BridgeOriginsSigner;
}

export interface ClientConfigDeps {
  /**
   * F1-02zzzb: the signed bridge_origins whitelist. Always wired by content-public.module; absent
   * (direct unit callers only) the field is the domain's empty placeholder.
   */
  readonly bridgeOrigins?: BridgeOriginsSource | null;
  readonly reader: ContentReader;
  /** Fresh primary-database read on every request, outside ContentReader's cache. */
  readonly platformIcons: (appId: string) => Promise<PublishedPlatformIcons>;
  readonly linkPatterns: () => NonNullable<ClientConfig['link_patterns']>;
  /** platform's getMaterialChannels(): features.rank_platforms is derived from it (F1-02h). */
  readonly materialChannels: () => MaterialChannelsSpec;
  /**
   * F1-02zp: growth's total available invitation reward budget (null or absent: not installed,
   * reward_enabled is always false). Asked at most once per request, only while the switch is
   * on, and never cached here.
   */
  readonly inviteRewardBudget?: InviteRewardBudgetReader | null;
  readonly logger: Pick<Logger, 'warn' | 'error'>;
}

export class ClientConfigService {
  readonly #deps: ClientConfigDeps;

  constructor(deps: ClientConfigDeps) {
    this.#deps = deps;
  }

  /**
   * The Config of `viewer`, its config_version set (the ETag without quotes). `deviceId` is the
   * guest's X-Device-Id header, used only to bucket h5_release when there is no user; it is
   * never an identity.
   */
  async read(viewer: ConfigViewer, deviceId: string | null): Promise<ClientConfig> {
    const { reader, logger } = this.#deps;
    const source = this.#deps.bridgeOrigins ?? null;
    const [rows, bridgeItem] = await Promise.all([
      Promise.all(
        CLIENT_CONFIG_KEYS.map(async (key) => ({
          key,
          row: await reader.configValue(viewer.appId, key),
        })),
      ),
      source === null ? Promise.resolve(null) : source.item(viewer.appId),
    ]);
    const values = new Map<string, unknown>();
    for (const { key, row } of rows) {
      if (row !== null) values.set(key, row.value);
    }
    const inviteRewardBudgetFen = await this.#inviteRewardBudget(viewer.appId, values);
    const missing: string[] = [];
    const config = buildClientConfig({
      values,
      viewer,
      deviceId,
      linkPatterns: this.#deps.linkPatterns(),
      rankPlatforms: rankPlatforms(this.#deps.materialChannels()),
      ...(inviteRewardBudgetFen === undefined ? {} : { inviteRewardBudgetFen }),
      report: {
        missing: (key) => {
          missing.push(key);
          logger.error(
            { event: 'content_config_required_invalid', app_id: viewer.appId, config_key: key },
            'required client configuration missing or malformed',
          );
        },
        invalid: (key) => {
          logger.warn(
            { event: 'content_config_value_invalid', app_id: viewer.appId, config_key: key },
            'client configuration value malformed; default used',
          );
        },
      },
    });
    if (config === undefined) throw new ClientConfigUnavailableError(missing);
    if (source !== null) {
      config.bridge_origins = this.#signBridgeOrigins(source, viewer.appId, config, bridgeItem);
    }
    try {
      config.platform_icons = await this.#deps.platformIcons(viewer.appId);
    } catch (error) {
      if (!(error instanceof MediaStoreUnavailableError)) throw error;
      logger.warn(
        { event: 'content_config_platform_icons_unavailable', app_id: viewer.appId },
        'media public base URL unavailable; platform_icons omitted',
      );
    }
    // F1-02h: the version covers the caller's final data (per-caller parts and platform_icons
    // included), never itself; the controller answers it as the strong ETag.
    const etag = configEtag(config);
    config.config_version = etag.slice(1, -1);
    return config;
  }

  /**
   * F1-02zzzb: the signed whitelist of the caller's app. A stored row that is not usable is not
   * signed (the h5_base_url origin is, under the row's version) and is warned about like any
   * malformed optional key; an h5_base_url without an https origin cannot be signed and fails the
   * response like a malformed required key.
   */
  #signBridgeOrigins(
    source: BridgeOriginsSource,
    appId: string,
    config: ClientConfig,
    item: BridgeOriginsInput['item'],
  ): ClientConfig['bridge_origins'] {
    const { logger } = this.#deps;
    const h5BaseUrl = config.h5_base_url;
    if (item !== null && !BridgeOriginsSigner.usable(item, h5BaseUrl)) {
      logger.warn(
        { event: 'content_config_value_invalid', app_id: appId, config_key: BRIDGE_ORIGINS_KEY },
        'client configuration value malformed; default used',
      );
    }
    try {
      return source.signer().sign({ appId, env: source.env, h5BaseUrl, item });
    } catch (error) {
      logger.error(
        {
          event: 'content_config_bridge_origins_unsigned',
          app_id: appId,
          config_key: BRIDGE_ORIGINS_KEY,
          error_name: error instanceof Error ? error.name : typeof error,
        },
        'bridge_origins could not be signed',
      );
      throw new ClientConfigUnavailableError([BRIDGE_ORIGINS_KEY]);
    }
  }

  /**
   * The budget port's answer, or undefined when it is not installed or the switch is off (then it
   * is not asked). A rejection or a value that is not a safe integer degrades to null with one
   * warning naming the app: the reward is hidden, /v1/config still answers (never 50001).
   */
  async #inviteRewardBudget(
    appId: string,
    values: ReadonlyMap<string, unknown>,
  ): Promise<number | null | undefined> {
    const port = this.#deps.inviteRewardBudget;
    if (port === undefined || port === null || !inviteRewardSwitchOn(values)) return undefined;
    let available: unknown;
    try {
      available = await port.available(appId);
    } catch (error) {
      this.#deps.logger.warn(
        {
          event: 'content_config_invite_budget_unavailable',
          app_id: appId,
          reason: 'rejected',
          error_name: error instanceof Error ? error.name : typeof error,
        },
        'invite reward budget read failed; reward disabled',
      );
      return null;
    }
    if (available === null) return null;
    if (typeof available === 'number' && Number.isSafeInteger(available)) return available;
    this.#deps.logger.warn(
      {
        event: 'content_config_invite_budget_unavailable',
        app_id: appId,
        reason: 'not_integer',
      },
      'invite reward budget is not an integer; reward disabled',
    );
    return null;
  }
}
