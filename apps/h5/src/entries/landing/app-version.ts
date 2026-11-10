// X-App-Version for the share page (契约 components/parameters/AppVersion, SemVer). Outside the App
// there is no bridge to ask, so the page sends the version of this H5 build: apps/h5/package.json,
// inlined at build time. Never a made-up number: a value that is not SemVer yields null.
import pkg from '../../../package.json' with { type: 'json' };

const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/;

/** A SemVer string within the contract's 32 characters, else null. */
export function semVerOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.length <= 32 && SEMVER.test(value) ? value : null;
}

/** This build's version for X-App-Version; null when package.json has no usable SemVer. */
export function buildAppVersion(): string | null {
  return semVerOrNull((pkg as { version?: unknown }).version);
}
