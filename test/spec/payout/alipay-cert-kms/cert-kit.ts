import { expect } from 'vitest';
import {
  certSn,
  publicKeyFromCert,
  rootCertSn,
} from '../../../../apps/api/src/modules/payment/infra/channels/alipay/cert-sn.ts';
import { ALIPAY_PLATFORM, OTHER, selfSignedCert } from '../../payment/channels/kit.ts';
import { appKeys } from '../channel/fixtures.ts';

// Runtime-generated keys and self-signed certificates for the payout rules.
export const APP_PRIVATE_KEY = appKeys().privateKey.trimEnd();
export const APP_CERT = selfSignedCert([{ name: 'CN', value: 'test-payout-app' }], 11n, appKeys());
export const ALIPAY_CERT = selfSignedCert(
  [{ name: 'CN', value: 'test-payout-alipay' }],
  2n ** 70n + 13n,
  ALIPAY_PLATFORM,
);
export const ROOT_CERT = [19n, 20n]
  .map((serial) => selfSignedCert([{ name: 'CN', value: 'test-payout-root' }], serial, OTHER))
  .join('');
export const ALIPAY_CERT_PRIVATE_KEY = ALIPAY_PLATFORM.privateKey;
export const ALIPAY_CERT_PUBLIC_KEY = publicKeyFromCert(ALIPAY_CERT);
export const CERT_SERIALS = {
  appCertSn: certSn(APP_CERT),
  alipayRootCertSn: rootCertSn(ROOT_CERT),
  alipayCertSn: certSn(ALIPAY_CERT),
};
expect(CERT_SERIALS.alipayRootCertSn).not.toBe(certSn(ROOT_CERT));
