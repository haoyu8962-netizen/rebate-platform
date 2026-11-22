import type { PrivacyConsentChecks, PrivacyConsentOptions } from './privacy-consent.ts';

export function createAgentPrivacyConsentChecks(
  options: PrivacyConsentOptions,
): PrivacyConsentChecks {
  void options;
  throw new Error('NotImplemented');
}
