// B1-30a / BR-ID-33: initialize a WrappedKeyring whose data keys are wrapped by KMS (prod; the staging
// file key is keyring-init.ts). Run once per keyring by whoever opens KMS, on a machine with the RAM
// role (kms:Encrypt on KMS_KEY_ID):
//
//   KMS_REGION_ID=… KMS_ENDPOINT=… KMS_KEY_ID=… KMS_RAM_ROLE=… \
//     node apps/api/scripts/keyring-init-kms.ts <output-file>
//
// Then set FIELD_KEY_PROVIDER=kms and FIELD_KEYRING_FILE=<output-file>. An existing output is never
// overwritten: replacing a keyring makes everything encrypted under it unreadable.
// Nothing printed contains key material, a path or a KMS error's text.
// Exit codes: 0 created, 1 any failure.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readKmsConfig } from '../src/modules/platform/config/kms.ts';
import { writeKmsKeyring } from '../src/modules/platform/kms/keyring-init.ts';
import { kmsAccessOf } from '../src/modules/platform/kms/index.ts';

const USAGE = 'usage: node apps/api/scripts/keyring-init-kms.ts <output-file>\n';

export async function main(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<number> {
  const [outputFile, ...rest] = args;
  if (outputFile === undefined || outputFile === '' || rest.length > 0) {
    process.stderr.write(USAGE);
    return 1;
  }
  const { kms, problems } = readKmsConfig('prod', env);
  const access = kmsAccessOf({ appEnv: 'prod', kms });
  if (access === null) {
    process.stderr.write(`keyring-init-kms failed: ${problems[0] ?? 'KMS_* is not set'}\n`);
    return 1;
  }
  try {
    await writeKmsKeyring(access, outputFile);
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
    const reason =
      code === 'EEXIST'
        ? 'the output file already exists (it was not changed)'
        : 'the keyring could not be created';
    process.stderr.write(`keyring-init-kms failed: ${reason}\n`);
    return 1;
  }
  process.stdout.write('keyring-init-kms: created the keyring (version 1)\n');
  return 0;
}

function executedDirectly(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (executedDirectly()) {
  main(process.argv.slice(2), process.env).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stderr.write('keyring-init-kms failed: unexpected error\n');
      process.exitCode = 1;
    },
  );
}
