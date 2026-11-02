// B1-30a 规则测试的 SDK 桩（claude-independent，SPEC_REF deb521c2）。各测试文件用 vi.mock 把
// apps/api/src/modules/platform/kms/sdk.ts 换成这里的 createKmsSdkClient，不碰真 SDK，不联网。
// 这个文件不在运行时导入任何应用代码，所以 vi.mock 的工厂可以放心动态导入它。
// encrypt / decrypt 是可逆变换，密文里带着加密时的 encryptionContext：两边的 context 不一致就解不开。
import { vi, type Mock } from 'vitest';
import type { KmsConfig } from '../../../../apps/api/src/modules/platform/config/kms.ts';
import type { KmsSdkClient } from '../../../../apps/api/src/modules/platform/kms/sdk.ts';

/** 合成的 SDK 原文标记：不得出现在错误对象或日志里。 */
export const SDK_MARKER = 'sdk-raw-text-marker-b1-30a';

export interface SecretAnswer {
  readonly secretData?: string;
  readonly secretDataType?: string;
}

interface SdkState {
  /** vi.mock 的工厂被调用的次数：sdk.ts 被加载过才不是 0。 */
  moduleLoads: number;
  /** createKmsSdkClient 收到的配置，一次调用一条。 */
  created: KmsConfig[];
  /** 不为 null 时 createKmsSdkClient 拒绝。 */
  createFailure: Error | null;
  /** 完整 secret 名（couli/<appEnv>/<逻辑名>）到应答。 */
  readonly secrets: Map<string, SecretAnswer>;
  readonly getSecretValue: Mock<KmsSdkClient['getSecretValue']>;
  readonly encrypt: Mock<KmsSdkClient['encrypt']>;
  readonly decrypt: Mock<KmsSdkClient['decrypt']>;
}

export const sdk: SdkState = {
  moduleLoads: 0,
  created: [],
  createFailure: null,
  secrets: new Map(),
  getSecretValue: vi.fn<KmsSdkClient['getSecretValue']>(),
  encrypt: vi.fn<KmsSdkClient['encrypt']>(),
  decrypt: vi.fn<KmsSdkClient['decrypt']>(),
};

/** 每个测试前调用：清空记录，装回默认应答。moduleLoads 不清（工厂一个文件只跑一次）。 */
export function resetSdk(): void {
  sdk.created = [];
  sdk.createFailure = null;
  sdk.secrets.clear();
  sdk.getSecretValue.mockReset();
  sdk.encrypt.mockReset();
  sdk.decrypt.mockReset();
  sdk.getSecretValue.mockImplementation(async (request) => {
    const answer = sdk.secrets.get(request.secretName);
    if (answer === undefined) throw new Error(`${SDK_MARKER}: no secret ${request.secretName}`);
    return { ...answer };
  });
  sdk.encrypt.mockImplementation(async (request) => ({
    ciphertextBlob: Buffer.from(
      JSON.stringify({ plaintext: request.plaintext, context: request.encryptionContext }),
      'utf8',
    ).toString('base64'),
  }));
  sdk.decrypt.mockImplementation(async (request) => {
    let parsed: { readonly plaintext: string; readonly context: unknown };
    try {
      parsed = JSON.parse(Buffer.from(request.ciphertextBlob, 'base64').toString('utf8')) as {
        readonly plaintext: string;
        readonly context: unknown;
      };
    } catch {
      throw new Error(`${SDK_MARKER}: not a blob of this stub`);
    }
    if (JSON.stringify(parsed.context) !== JSON.stringify(request.encryptionContext)) {
      throw new Error(`${SDK_MARKER}: encryption context differs`);
    }
    return { plaintext: parsed.plaintext };
  });
}

export async function createKmsSdkClient(config: KmsConfig): Promise<KmsSdkClient> {
  sdk.created.push(config);
  if (sdk.createFailure !== null) throw sdk.createFailure;
  return {
    getSecretValue: (request) => sdk.getSecretValue(request),
    encrypt: (request) => sdk.encrypt(request),
    decrypt: (request) => sdk.decrypt(request),
  };
}
