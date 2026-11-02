import { expect, it } from 'vitest';
import { createKmsSdkClient } from './sdk.ts';

// The real packages only: building the client loads them and sends nothing.
it('[AC-B1-30a-U#1] the real SDK and credentials load and give the three calls', async () => {
  const client = await createKmsSdkClient({
    regionId: 'cn-hangzhou',
    endpoint: 'kms-vpc.cn-hangzhou.aliyuncs.com',
    keyId: 'key-unit',
    ramRole: 'role-unit',
  });
  expect(typeof client.getSecretValue).toBe('function');
  expect(typeof client.encrypt).toBe('function');
  expect(typeof client.decrypt).toBe('function');
});
