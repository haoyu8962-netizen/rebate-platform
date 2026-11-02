// B1-30a: creates a field-encryption keyring wrapped by KMS, for apps/api/scripts/keyring-init-kms.ts.
// Same writing discipline as apps/api/scripts/keyring-init.ts: an exclusively created temporary file
// (0600) in the output's directory, fsynced, then hard-linked, so the output never holds a partial
// keyring and an existing output is never overwritten. Prints nothing; holds only wrapped keys.
import { randomBytes } from 'node:crypto';
import { link, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createWrappedKeyring } from '../crypto/index.ts';
import type { KmsAccess } from './index.ts';

export async function writeKmsKeyring(kms: KmsAccess, outputFile: string): Promise<void> {
  const keyring = await createWrappedKeyring(kms.keyProvider);
  const text = `${JSON.stringify(keyring, null, 2)}\n`;
  const directory = dirname(outputFile);
  const temporary = join(directory, `.keyring-init.${randomBytes(16).toString('hex')}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.chmod(0o600);
      await file.writeFile(text, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await link(temporary, outputFile);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
