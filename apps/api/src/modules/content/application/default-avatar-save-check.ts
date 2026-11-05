// B2-03w (D10-637): the save-time check of me.default_avatar_url (config.business). identity's
// GET /v1/me swaps the avatar:default sentinel for this value and answers 50001 when it is not a
// usable https URL (D22 / D23). A write that sets it (single update, batch or rollback) is
// refused with 20001 fields=[me.default_avatar_url] unless the value passes the same four tests
// identity applies on read, one by one: a string, starting with https:// (any case), parseable by
// URL.canParse, and with a non-empty hostname. ContentAdminModule combines it with the
// bridge_origins check and the assembler's checks; it runs only for writes of its own key.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import type { ConfigItemSaveCheck } from './config-item-admin.ts';

export const DEFAULT_AVATAR_URL_KEY = 'me.default_avatar_url';

/** Whether identity's GET /v1/me would accept `value` as the default avatar URL. */
export function defaultAvatarUrlValid(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (!/^https:\/\//i.test(value)) return false;
  if (!URL.canParse(value)) return false;
  return new URL(value).hostname !== '';
}

export function defaultAvatarSaveCheck(): ConfigItemSaveCheck {
  return {
    keys: [DEFAULT_AVATAR_URL_KEY],
    refusals(_stored, written) {
      if (!written.has(DEFAULT_AVATAR_URL_KEY)) return [];
      return defaultAvatarUrlValid(written.get(DEFAULT_AVATAR_URL_KEY))
        ? []
        : [DEFAULT_AVATAR_URL_KEY];
    },
  };
}
