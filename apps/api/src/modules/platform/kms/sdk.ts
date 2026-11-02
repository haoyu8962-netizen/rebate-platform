// B1-30a (FU-KMS-ADAPTER): the only file of the repository that imports the KMS SDK, with a dynamic
// import(), so a process without KMS never loads it. The rule tests stub this file with vi.mock and
// never touch the real SDK or the network; ./sdk.test.ts checks only that the real classes load.
// - Credentials: the ECS instance's RAM role, IMDSv2 only, never a static AccessKey
//   (docs-mirror/aliyun-kms/pages/credentials-nodejs.txt: disableIMDSv1). The KMS client refuses to
//   call without a credential object.
// - GetSecretValue, Encrypt, Decrypt: docs-mirror/aliyun-kms/pages/getsecretvalue.txt, encrypt.txt,
//   decrypt.txt. Not yet exercised against real KMS: that needs the owner to open it.
// - Under ESM the classes of these CommonJS packages sit one `.default` deeper than their types say.
import type { KmsConfig } from '../config/kms.ts';

export interface KmsSdkClient {
  getSecretValue(request: {
    secretName: string;
  }): Promise<{ secretData?: string; secretDataType?: string }>;
  encrypt(request: {
    keyId: string;
    plaintext: string;
    encryptionContext: Record<string, string>;
  }): Promise<{ ciphertextBlob?: string }>;
  decrypt(request: {
    ciphertextBlob: string;
    encryptionContext: Record<string, string>;
  }): Promise<{ plaintext?: string }>;
}

const CONNECT_TIMEOUT_MS = 3000;
const READ_TIMEOUT_MS = 5000;

/** The exports of a CommonJS package whatever the loader made of them. */
function exportsOf<T>(loaded: { readonly default: unknown }): T {
  return (typeof loaded.default === 'function' ? loaded : loaded.default) as T;
}

export async function createKmsSdkClient(config: KmsConfig): Promise<KmsSdkClient> {
  const kmsLoaded = await import('@alicloud/kms20160120');
  const credentialsLoaded = await import('@alicloud/credentials');
  const kms = exportsOf<typeof kmsLoaded.default>(kmsLoaded);
  const credentials = exportsOf<typeof credentialsLoaded.default>(credentialsLoaded);
  const credential = new credentials.default(
    new credentials.Config({
      type: 'ecs_ram_role',
      roleName: config.ramRole,
      disableIMDSv1: true,
    }),
  );
  const client = new kms.default({
    regionId: config.regionId,
    endpoint: config.endpoint,
    protocol: 'https',
    connectTimeout: CONNECT_TIMEOUT_MS,
    readTimeout: READ_TIMEOUT_MS,
    credential,
  } as unknown as ConstructorParameters<typeof kms.default>[0]);
  return {
    async getSecretValue(request) {
      const { body } = await client.getSecretValue(new kms.GetSecretValueRequest(request));
      return {
        ...(body?.secretData === undefined ? {} : { secretData: body.secretData }),
        ...(body?.secretDataType === undefined ? {} : { secretDataType: body.secretDataType }),
      };
    },
    async encrypt(request) {
      const { body } = await client.encrypt(new kms.EncryptRequest(request));
      return body?.ciphertextBlob === undefined ? {} : { ciphertextBlob: body.ciphertextBlob };
    },
    async decrypt(request) {
      const { body } = await client.decrypt(new kms.DecryptRequest(request));
      return body?.plaintext === undefined ? {} : { plaintext: body.plaintext };
    },
  };
}
