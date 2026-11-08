// Use case POST /v1/devices (BR-ID-09; 04 §6.1). The request schema has already checked the
// headers, the hash format and id_source; this service applies the invalid-hash list, issues
// device_id and install_secret and stores the row. It sends no job and publishes no event.
// B1-02zzi (D10-1034 ②): the invalid-hash list is read for the request's app on every
// registration (specs seeds ∪ the app's device.invalid_hashes), before any transaction, so an
// operator's change applies to the next registration; a failed read means the seeds alone.
// B1-03f (BR-ID-05 device.ip_register_per_hour, BR-ID-09 hot-hash monitoring): after the
// invalid-hash list and before anything is issued, risk's per-IP slot is reserved (refused: 42901,
// nothing issued or stored). An explicit insert failure releases the slot; an unknown outcome
// keeps it while risk checks the device row (after the insert transaction has ended). A stored device is then counted for the hot-hash
// alert (alert only; its failure never fails the registration).
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { DeviceIdSource } from '@couli/contracts-ts';
import {
  CLOCK,
  FIELD_CRYPTO,
  newUuidV7,
  type Clock,
  type FieldCrypto,
} from '../../platform/index.ts';
import type { DeviceRegistrationRisk } from '../../risk/index.ts';
import {
  installSecretContext,
  isRegistrableDeviceHash,
  isWellFormedDeviceHash,
} from '../domain/device.ts';
import { DevicesRepository } from '../infra/devices.repository.ts';
import type { InvalidDeviceHashes } from '../infra/invalid-device-hashes.ts';
import { newInstallSecret } from '../infra/issue.ts';

/**
 * Token of the invalid-hash list (config device.invalid_hashes) by app: InvalidDeviceHashes
 * (createInvalidDeviceHashes), read for every registration.
 */
export const INVALID_DEVICE_HASHES = Symbol('INVALID_DEVICE_HASHES');

/** Token of risk's device registration ports (DeviceRegistrationRisk), assembled by app.module. */
export const DEVICE_REGISTRATION_RISK = Symbol('DEVICE_REGISTRATION_RISK');

/** The ports identity uses; risk's createDeviceRegistrationRisk implements them structurally. */
export type DeviceRegistrationPorts = Pick<
  DeviceRegistrationRisk,
  'reserve' | 'release' | 'reconcile' | 'recordSuccess'
>;

export interface RegisterDeviceCommand {
  /** X-App-Id */
  readonly appId: string;
  /** X-Platform */
  readonly platform: string;
  /** X-App-Version */
  readonly appVersion: string;
  readonly deviceHash: string;
  readonly idSource: DeviceIdSource;
  /** The client IP as the gateway identified it (Fastify request.ip). */
  readonly clientIp: string;
}

export type RegisterDeviceResult =
  | {
      readonly kind: 'registered';
      readonly deviceId: string;
      /** Returned to the client once; only its ciphertext is stored. */
      readonly installSecret: string;
    }
  | { readonly kind: 'invalid_device_hash' }
  /** BR-ID-05: the per-IP hourly registration limit (or its store) refused; nothing issued. */
  | { readonly kind: 'rate_limited'; readonly retryAfterSec: number };

/**
 * Did the database answer the insert with an error (so nothing was committed)? A SQLSTATE outside
 * the connection classes (08 connection exception, 57P admin/crash shutdown, XX internal) means
 * the statement was rejected; anything else (a socket error, a lost acknowledgement, an error
 * without a code) leaves the outcome unknown.
 */
export function isDefiniteInsertFailure(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null
      ? (Reflect.get(error, 'code') as unknown)
      : undefined;
  if (typeof code !== 'string' || !/^[0-9A-Z]{5}$/.test(code)) return false;
  return !code.startsWith('08') && !code.startsWith('57P') && !code.startsWith('XX');
}

@Injectable()
export class RegisterDeviceService {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(INVALID_DEVICE_HASHES) private readonly invalidHashes: InvalidDeviceHashes,
    @Inject(DevicesRepository) private readonly devices: DevicesRepository,
    // Absent when the process has no keyring (local / test without FIELD_KEY_PROVIDER).
    @Optional() @Inject(FIELD_CRYPTO) private readonly fieldCrypto: FieldCrypto | undefined,
    @Inject(DEVICE_REGISTRATION_RISK) private readonly risk: DeviceRegistrationPorts,
  ) {}

  async register(command: RegisterDeviceCommand): Promise<RegisterDeviceResult> {
    // A malformed hash is refused without reading the configuration.
    if (!isWellFormedDeviceHash(command.deviceHash)) return { kind: 'invalid_device_hash' };
    // Read on the pool before anything else (no transaction is held yet); never rejects.
    const invalidHashes = await this.invalidHashes.forApp(command.appId);
    if (!isRegistrableDeviceHash(command.deviceHash, invalidHashes)) {
      return { kind: 'invalid_device_hash' };
    }
    if (this.fieldCrypto === undefined) {
      throw new Error('identity: device registration needs the field-encryption keyring');
    }
    const admission = await this.risk.reserve({
      appId: command.appId,
      clientIp: command.clientIp,
    });
    if (admission.code !== 0) {
      return { kind: 'rate_limited', retryAfterSec: admission.retryAfterSec };
    }
    const reservation = admission.reservation;
    const now = this.clock.now();
    const deviceId = newUuidV7(now);
    let installSecret: string;
    let cipher: string;
    try {
      installSecret = newInstallSecret();
      cipher = this.fieldCrypto.encrypt(installSecret, installSecretContext(deviceId));
    } catch (error) {
      await this.risk.release(reservation);
      throw error;
    }
    try {
      await this.devices.insert({
        id: deviceId,
        appId: command.appId,
        deviceHash: command.deviceHash,
        idSource: command.idSource,
        platform: command.platform,
        appVersion: command.appVersion,
        installSecretCipher: Buffer.from(cipher, 'utf8'),
        now,
      });
    } catch (error) {
      if (isDefiniteInsertFailure(error)) {
        await this.risk.release(reservation);
      } else {
        // The check waits for the insert transaction's advisory lock before reading (S1 r1),
        // scoped to this app; a timeout or error keeps the slot.
        await this.risk.reconcile(reservation, deviceId, (id) =>
          this.devices.exists(command.appId, id),
        );
      }
      throw error;
    }
    try {
      await this.risk.recordSuccess({
        appId: command.appId,
        deviceHash: command.deviceHash,
        deviceId,
      });
    } catch {
      // Alert only (BR-ID-09): the stored device stays registered.
    }
    return { kind: 'registered', deviceId, installSecret };
  }
}
