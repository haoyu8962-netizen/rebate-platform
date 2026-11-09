// B1-01zzt 规则测试的 KMS SDK 桩（claude-independent，SPEC_REF deaba4fb）。content-wiring.test.ts 用 vi.mock 把
// apps/api/src/modules/platform/kms/sdk.ts 换成这里的 createKmsSdkClient：真的 kmsAccessOf 走到这里，不碰真 SDK、
// 不联网。本文件运行时不导入任何应用代码，vi.mock 的工厂可以放心动态导入它。
import type { KmsSdkClient } from '../../../../apps/api/src/modules/platform/kms/sdk.ts';

/** 合成的 SDK 原文标记：不得出现在错误对象或日志里。 */
export const SDK_MARKER = 'sdk-raw-text-marker-b1-01zzt';

export interface SecretAnswer {
  readonly secretData?: string;
  readonly secretDataType?: string;
}

interface SdkState {
  /** createKmsSdkClient 被调用的次数。 */
  created: number;
  /** getSecretValue 收到的完整 secret 名，按调用顺序。 */
  reads: string[];
  /** 不为 null 时 getSecretValue 抛它。 */
  readFailure: Error | null;
  /** 完整 secret 名（couli/<appEnv>/<逻辑名>）到应答。 */
  readonly secrets: Map<string, SecretAnswer>;
}

export const sdk: SdkState = {
  created: 0,
  reads: [],
  readFailure: null,
  secrets: new Map(),
};

/** 每个测试前调用。 */
export function resetSdk(): void {
  sdk.created = 0;
  sdk.reads = [];
  sdk.readFailure = null;
  sdk.secrets.clear();
}

export async function createKmsSdkClient(): Promise<KmsSdkClient> {
  sdk.created += 1;
  return {
    getSecretValue: async ({ secretName }) => {
      sdk.reads.push(secretName);
      if (sdk.readFailure !== null) throw sdk.readFailure;
      const answer = sdk.secrets.get(secretName);
      if (answer === undefined) throw new Error(`${SDK_MARKER}: no secret ${secretName}`);
      return { ...answer };
    },
    encrypt: () => Promise.reject(new Error(`${SDK_MARKER}: encrypt is not used here`)),
    decrypt: () => Promise.reject(new Error(`${SDK_MARKER}: decrypt is not used here`)),
  };
}
