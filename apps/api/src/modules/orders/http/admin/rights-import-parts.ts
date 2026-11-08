// B1-09g: reading the multipart/form-data body of POST /admin/v1/rights-imports (contract
// adminCreateRightsImport: text parts kind, platform, time_basis, from, to, union_account_id,
// reason_sub (B1-09v, CT-24zw) and the file `file`, in any order). Called by the handler inside the guard's business callback only,
// so a refused account never consumes the body (as platform readSingleUpload).
//   - a body above the route's bodyLimit (Content-Length up front, or the bytes counted while
//     streaming): RightsImportPartsRejection 413 / data.fields [body]; on overflow it stops
//     consuming the request at once;
//   - not multipart, a part of another name, a malformed body or the plugin's own client errors:
//     400 / data.fields [body];
//   - a repeated text part names itself, a second file names `file`: reported in `invalid` (the
//     handler answers 20001 with the first of them).
// Limits: the admin entry's default is one file and no field; this request reads under its own
// counts through the plugin's public per-request option `request.parts({ limits })` (F1-09t),
// one spare of each so a repeat is reported, not cut off; fileSize stays the global one.
// Values are returned as sent; the use case validates them. Neither a value nor the file is logged.
// Erasable syntax only; no NestJS import.
import type { RightsImportFormFields } from '../../domain/rights-import.ts';
import type { RightsImportUpload } from '../../application/rights-imports.ts';
import type { SingleUploadRequest } from '../../../platform/index.ts';

/** The admin entry's request with the plugin's public reader taking per-request busboy counts. */
export interface RightsImportPartsRequest extends SingleUploadRequest {
  parts(options?: { readonly limits?: object }): ReturnType<SingleUploadRequest['parts']>;
}

/** A refused body: the HTTP status; the 20001 envelope names `body`. */
export class RightsImportPartsRejection extends Error {
  readonly statusCode: 400 | 413;

  constructor(statusCode: 400 | 413) {
    super(statusCode === 413 ? 'rights import body too large' : 'invalid rights import body');
    this.name = 'RightsImportPartsRejection';
    this.statusCode = statusCode;
  }
}

const FIELDS = [
  'kind',
  'platform',
  'time_basis',
  'from',
  'to',
  'union_account_id',
  'reason_sub',
] as const;
type FieldName = (typeof FIELDS)[number];
/** Seven text parts and one file, one spare of each so a repeat is reported, not cut off. */
export const RIGHTS_IMPORT_LIMITS = Object.freeze({ files: 2, fields: 14, parts: 16 });

export interface RightsImportParts {
  readonly fields: RightsImportFormFields;
  readonly file: RightsImportUpload | undefined;
  /** Repeated parts, in the order met. */
  readonly invalid: readonly string[];
}

interface Part {
  readonly type: string;
  readonly fieldname: string;
  readonly value?: unknown;
  readonly filename?: string;
  readonly mimetype?: string;
  toBuffer?: () => Promise<Buffer>;
}

const isField = (name: string): name is FieldName => (FIELDS as readonly string[]).includes(name);
const tooLarge = (): RightsImportPartsRejection => new RightsImportPartsRejection(413);
const invalidBody = (): RightsImportPartsRejection => new RightsImportPartsRejection(400);

export async function readRightsImportParts(
  request: RightsImportPartsRequest,
): Promise<RightsImportParts> {
  if (!request.isMultipart()) throw invalidBody();
  const limit = request.routeOptions.bodyLimit;
  const declared = request.headers['content-length'];
  if (declared !== undefined && /^\d+$/.test(declared) && Number(declared) > limit) {
    throw tooLarge();
  }

  const raw = request.raw;
  let received = 0;
  let rejectOverflow: (error: RightsImportPartsRejection) => void = () => undefined;
  const overflow = new Promise<never>((_resolve, reject) => {
    rejectOverflow = reject;
  });
  overflow.catch(() => undefined);
  const onData = (chunk: Buffer | string): void => {
    received += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
    if (received > limit) {
      raw.removeListener('data', onData);
      raw.unpipe();
      rejectOverflow(tooLarge());
    }
  };
  raw.on('data', onData);
  const step = <T>(promise: Promise<T>): Promise<T> => {
    promise.catch(() => undefined);
    return Promise.race([promise, overflow]);
  };

  const values: Partial<Record<FieldName, string>> = {};
  const invalid: string[] = [];
  let file: RightsImportUpload | undefined;
  const parts = request.parts({ limits: RIGHTS_IMPORT_LIMITS });
  try {
    for (;;) {
      const next = await step(parts.next());
      if (next.done === true) break;
      const part = next.value as Part;
      const name = part.fieldname;
      if (part.type === 'file') {
        if (name !== 'file' || part.toBuffer === undefined) throw invalidBody();
        const bytes = new Uint8Array(await step(part.toBuffer()));
        if (file !== undefined) {
          if (!invalid.includes('file')) invalid.push('file');
        } else {
          file = { bytes, filename: part.filename ?? '', mimetype: part.mimetype ?? '' };
        }
      } else if (part.type === 'field' && isField(name)) {
        if (Object.hasOwn(values, name) || typeof part.value !== 'string') {
          if (!invalid.includes(name)) invalid.push(name);
        } else {
          values[name] = part.value;
        }
      } else {
        throw invalidBody();
      }
    }
    if (received > limit) throw tooLarge();
    return { fields: values, file, invalid };
  } catch (error) {
    raw.removeListener('data', onData);
    raw.unpipe();
    if (received > limit) throw tooLarge();
    if (error instanceof RightsImportPartsRejection) throw error;
    if (error instanceof Error && error.name === 'FastifyError') {
      const code = (error as { code?: unknown }).code;
      throw code === 'FST_REQ_FILE_TOO_LARGE' ? tooLarge() : invalidBody();
    }
    // busboy reports a malformed body with a plain Error: a bad request, not a server error.
    if (error instanceof Error && Object.getPrototypeOf(error) === Error.prototype) {
      throw invalidBody();
    }
    throw error;
  } finally {
    raw.removeListener('data', onData);
  }
}
