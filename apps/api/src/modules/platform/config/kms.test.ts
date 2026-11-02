import { expect, it } from 'vitest';
import { readKmsConfig } from './kms.ts';

const env = (endpoint: string) => ({
  KMS_REGION_ID: 'cn-hangzhou',
  KMS_ENDPOINT: endpoint,
  KMS_KEY_ID: 'key-unit',
  KMS_RAM_ROLE: 'role-unit',
});

// A character before the suffix must not leave another host as the real target.
it.each(['kms.x#.aliyuncs.com', 'kms.x?.aliyuncs.com', 'kms.x\\.aliyuncs.com', '.aliyuncs.com'])(
  '[AC-B1-30a-U#5] endpoint %s is refused',
  (endpoint) => {
    expect(readKmsConfig('prod', env(endpoint))).toEqual({
      kms: null,
      problems: ['KMS_ENDPOINT: must be a host name ending in .aliyuncs.com'],
    });
  },
);

it('[AC-B1-30a-U#6] the documented shared-gateway hosts are accepted', () => {
  for (const endpoint of ['kms.cn-hangzhou.aliyuncs.com', 'kms-vpc.cn-hangzhou.aliyuncs.com']) {
    expect(readKmsConfig('prod', env(endpoint)).problems).toEqual([]);
  }
});
