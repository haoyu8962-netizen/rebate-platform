import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { Fixture } from '../apply/kit.ts';

export { open, close, fixture, type Harness } from '../apply/kit.ts';
export { hits, rule, seedBlock } from './http-kit.ts';

/** Independent HMAC-shaped synthetic values; never a real phone, ID or device. */
export async function identity(f: Pick<Fixture, 'h' | 'actor' | 'clock' | 'hmac'>) {
  const values = {
    phone: '1'.repeat(64),
    id_no: '2'.repeat(64),
    device: '3'.repeat(64),
    alipay: f.hmac,
    bank_card: f.hmac,
    wechat_openid: f.hmac,
  };
  const { appId, userId, deviceId } = f.actor;
  await sql`UPDATE app.users SET phone_hmac=${values.phone}, phone_cipher=${Buffer.from('fixture')}
    WHERE app_id=${appId} AND id=${userId}`.execute(f.h.db);
  await sql`INSERT INTO app.realname
    (id,app_id,user_id,status,name_cipher,id_no_cipher,id_no_hmac,birth_date_cipher,provider,verified_at)
    VALUES (${randomUUID()},${appId},${userId},'verified',${Buffer.from('fixture')},
      ${Buffer.from('fixture')},${values.id_no},${Buffer.from('fixture')},'fixture',${f.clock.now()})`.execute(
    f.h.db,
  );
  await sql`INSERT INTO app.devices
    (id,app_id,device_hash,id_source,platform,app_version,last_seen_at,install_secret_cipher)
    VALUES (${deviceId},${appId},${values.device},'idfv','ios','2.0.0',${f.clock.now()},${Buffer.from('fixture')})`.execute(
    f.h.db,
  );
  return values;
}
