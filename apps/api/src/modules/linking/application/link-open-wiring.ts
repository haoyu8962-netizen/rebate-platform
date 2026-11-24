// B1-06w: the open entry AppModule builds per request — B1-06e's open (owner, re-check,
// conversion) with the jump-path admission of the environment (B1-06e fund review S2):
// - every environment: the app scheme comes from the injected contracts/apps.json only;
// - non-prod: the BR-ATTR-27 default matrix as built (demo adapters only);
// - prod: a step is handed out only when its path is verified for that platform and client
//   (CAP-JD-11 / CAP-PDD-11); a scheme step also needs the apps.json entry verified and its value
//   under that entry's scheme. A platform × client with no admissible path at all answers 50301
//   at admit, before any price or conversion call. Fresh conversions, cached jumps and the unpromoted no-rebate page
//   are admitted alike; nothing admitted → 50301 (the open fails closed before its commit, so no
//   attempt is recorded for a jump that is never handed out).
// Taobao (B1-06f, link-open-taobao.ts): outside prod the instruction is handed out as built; prod
// admits no Taobao path until CAP-TB-11 is verified, so a Taobao open there answers 50301 at admit.
// The cache plan variant is the client itself (web is not folded into h5 here), so a cached jump
// is admitted for exactly the client it was built for.
import type { AppEnv } from '../../platform/index.ts';
import type { LinkOpenReadPlan } from './link-open-reads.ts';
import {
  appSchemeOf,
  createLinkOpenConversion,
  planVariant,
  type JdPddConversionInput,
  type LinkConversionOptions,
  type LinkOpenApps,
} from './link-open-conversion.ts';
import { linkOpenOf, type LinkOpenService } from './link-open.ts';
import type { LinkOpenOwnerResult } from './link-open-owner.ts';
import {
  createLinkOpenRequote,
  type LinkOpenCacheKey,
  type LinkOpenCachedJump,
  type LinkOpenConversionPort,
  type LinkOpenJump,
  type LinkOpenRequoteInput,
  type LinkOpenRequoteOptions,
} from './link-open-requote.ts';

export type { LinkOpenApps } from './link-open-conversion.ts';

type JumpPathType = 'scheme' | 'universal_link' | 'h5';
type Client = LinkOpenRequoteInput['client'];

/** Verification is per platform, client and path; omitted entries are unverified. */
export interface LinkOpenEnvironment {
  readonly appEnv: AppEnv;
  readonly apps: LinkOpenApps;
  readonly verifiedPaths: Readonly<
    Partial<Record<'jd' | 'pdd', Readonly<Partial<Record<Client, readonly JumpPathType[]>>>>>
  >;
}

/**
 * Pre-reads of a dependency the open's card re-check calls inside its transaction (the quoter's
 * rule versions, viewer levels and configuration), run with the open's own pre-reads before the
 * transaction (B1-06m). B2-03d: it gets the whole plan, so the caller and every owner identity
 * can be pre-read; failures are settled here and surface where the transaction reads them.
 */
export interface LinkOpenQuoteReads {
  prepare(plan: LinkOpenReadPlan): Promise<void>;
}

export type WiredLinkOpenOptions = Omit<LinkOpenRequoteOptions, 'conversion'> &
  LinkConversionOptions & {
    readonly environment: LinkOpenEnvironment;
    readonly quoteReads?: LinkOpenQuoteReads;
  };

const CLIENTS: readonly Client[] = ['ios', 'android', 'harmony', 'h5', 'web'];

function isClient(value: string | undefined): value is Client {
  return value !== undefined && (CLIENTS as readonly string[]).includes(value);
}

/**
 * The plan variant of this entry: the client as sent, installed only where it is detectable, and
 * the jump-plan scheme (B1-06zp: for every installed value, so no earlier entry hits).
 */
function variantOf(input: Pick<JdPddConversionInput, 'client' | 'installed'>): string {
  const installed =
    input.client === 'h5' || input.client === 'web' ? 'unknown' : (input.installed ?? 'unknown');
  return planVariant(input.client, installed);
}

function clientOfVariant(variant: string | undefined): Client | null {
  const client = variant?.split(':')[0];
  return isClient(client) ? client : null;
}

/** Jump-path admission of one environment (B1-06e fund review S2). */
export function createJumpAdmission(environment: LinkOpenEnvironment) {
  const production = environment.appEnv === 'prod';

  function admits(platform: string, client: Client, step: LinkOpenJump['primary']): boolean {
    if (platform !== 'jd' && platform !== 'pdd') return false;
    const verified = environment.verifiedPaths[platform]?.[client] ?? [];
    if (!(verified as readonly string[]).includes(step.type)) return false;
    if (step.type !== 'scheme') return true;
    const entry = environment.apps.apps[platform];
    const scheme = appSchemeOf(environment.apps, platform);
    return entry.status === 'verified' && scheme !== null && step.value.startsWith(`${scheme}://`);
  }

  return {
    production,
    /**
     * Whether any path of this platform and client could be admitted at all, checked before the
     * open prices or converts (B1-06w review S2: prod spends no union call on a jump it cannot
     * hand out). Always true outside prod.
     */
    possible(platform: string, client: Client): boolean {
      if (!production) return true;
      if (platform !== 'jd' && platform !== 'pdd') return false;
      const verified = environment.verifiedPaths[platform]?.[client] ?? [];
      return verified.some(
        (type) =>
          type !== 'scheme' ||
          (environment.apps.apps[platform].status === 'verified' &&
            appSchemeOf(environment.apps, platform) !== null),
      );
    },
    /** The admitted steps in their order; null when none is admitted. */
    jump(platform: string, client: Client, jump: LinkOpenJump): LinkOpenJump | null {
      if (!production) return jump;
      const steps = [jump.primary, ...jump.fallbacks].filter((step) =>
        admits(platform, client, step),
      );
      const [primary, ...fallbacks] = steps;
      return primary === undefined ? null : { primary, fallbacks, expire_at: jump.expire_at };
    },
    /** The explicit no-rebate purchase's unpromoted page is an h5 step too. */
    page(platform: string, client: Client, url: string): boolean {
      return !production || admits(platform, client, { type: 'h5', value: url });
    },
  };
}

function paused(message: string): Error & { readonly code: 50301 } {
  return Object.assign(new Error(message), { code: 50301 as const });
}

/** The jd / pdd conversion port and the cache of one environment, with path admission. */
export interface WiredConversion {
  readonly admission: ReturnType<typeof createJumpAdmission>;
  readonly conversion: Required<Omit<LinkOpenConversionPort, 'authorize' | 'cacheTag'>>;
  readonly cache: LinkOpenRequoteOptions['cache'];
}

/**
 * The wired conversion of jd / pdd (B1-06w admission of fresh, cached and fallback jump paths),
 * shared by createWiredLinkOpen and the Taobao composition (link-open-taobao.ts, B1-06f).
 */
export function createWiredConversion(options: WiredLinkOpenOptions): WiredConversion {
  const { environment, cache, quoteReads } = options;
  const admission = createJumpAdmission(environment);
  const base = createLinkOpenConversion({ ...options, apps: environment.apps });

  const conversion = {
    async admit(owner: LinkOpenOwnerResult, client: Client): Promise<void> {
      await base.admit(owner);
      if (!admission.possible(owner.link.platform, client)) {
        throw paused('linking: no verified jump path for this client');
      }
    },
    variant: variantOf,
    async prepare(plan: LinkOpenReadPlan): Promise<void> {
      await Promise.allSettled([
        base.prepare(plan),
        ...(quoteReads === undefined ? [] : [quoteReads.prepare(plan)]),
      ]);
    },
    async convert(input: JdPddConversionInput): Promise<LinkOpenJump> {
      const platform = input.owner.link.platform;
      let jump: LinkOpenJump;
      try {
        jump = await base.convert(input);
      } catch (error) {
        const failure = error as { code?: unknown; noRebateUrl?: unknown } | null;
        if (
          failure?.code === 50303 &&
          typeof failure.noRebateUrl === 'string' &&
          failure.noRebateUrl !== '' &&
          !admission.page(platform, input.client, failure.noRebateUrl)
        ) {
          throw Object.assign(new Error('linking: unpromoted page not admitted'), {
            code: 50303 as const,
            noRebateUrl: '',
          });
        }
        throw error;
      }
      const admitted = admission.jump(platform, input.client, jump);
      if (admitted === null) throw paused('linking: no verified jump path for this client');
      return admitted;
    },
  };

  const admittedCache = {
    async get(key: LinkOpenCacheKey): Promise<LinkOpenCachedJump | null> {
      const entry = await cache.get(key);
      if (entry === null || !admission.production) return entry;
      const client = clientOfVariant(key.variant);
      if (client === null) return null;
      const jump = admission.jump(key.platform, client, entry.jump);
      // Nothing admitted is a miss: the open converts afresh (and is admitted again).
      return jump === null ? null : { ...entry, jump };
    },
    put(key: LinkOpenCacheKey, value: LinkOpenCachedJump): Promise<void> {
      return cache.put(key, value);
    },
  };

  return { admission, conversion, cache: admittedCache };
}

/**
 * AppModule's open entry, including admission of fresh, cached and fallback jump paths.
 * `compose` (B1-06f) builds the open's conversion port over the wired jd / pdd one (the Taobao
 * composition, link-open-taobao.ts); absent, the wired port is used as it is.
 */
export function createWiredLinkOpen(
  options: WiredLinkOpenOptions,
  compose?: (wired: WiredConversion) => LinkOpenConversionPort,
): LinkOpenService {
  const wired = createWiredConversion(options);
  const conversion = compose === undefined ? wired.conversion : compose(wired);
  return linkOpenOf(createLinkOpenRequote({ ...options, cache: wired.cache, conversion }));
}
