// Pairing a device to a user.
//
// 1. The user creates a single-use pairing token (POST /v1/enrollments).
// 2. Their provisioning app hands it to the device (BLE/SoftAP provisioning data).
// 3. The device redeems it (POST /v1/device/enroll) and receives a brand-new
//    device id + MQTT password. Any earlier enrollment of the same hardware is
//    superseded and its broker connection closed.

import type { BrokerManagement } from "../broker/management.ts";
import { config } from "../config.ts";
import { db, models, sqlState } from "../db.ts";
import { log } from "../log.ts";
import { ApiError } from "../http/errors.ts";
import { platformFor } from "../platforms/index.ts";
import { invalidateDevice } from "./cache.ts";
import {
  generateDeviceId,
  generateDevicePassword,
  generatePairingToken,
  hashDevicePassword,
  hashPairingToken,
  normalizePairingToken,
} from "./ids.ts";

export async function createEnrollmentToken(ownerId: string, deviceName: string | null, ttlMinutes: number) {
  const token = generatePairingToken();
  const row = await models.EnrollmentToken.create({
    ownerId,
    deviceName,
    tokenHash: hashPairingToken(token),
    expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
  });
  return { row, token };
}

export interface EnrollRequest {
  token: string;
  hardwareId: string;
  platform: string;
  chip?: string;
  name?: string;
  fwVersion?: string;
}

export interface EnrollResult {
  deviceId: string;
  password: string;
  name: string;
}

const invalidToken = () => new ApiError(401, "invalid_token", "pairing token is invalid, used or expired");

export async function enrollDevice(req: EnrollRequest, management: BrokerManagement): Promise<EnrollResult> {
  const canonical = normalizePairingToken(req.token);
  if (!canonical) throw invalidToken();
  const platform = platformFor(req.platform);
  if (!platform) throw new ApiError(400, "unsupported_platform", `platform ${req.platform} is not supported`);

  const password = generateDevicePassword();
  const passwordHash = hashDevicePassword(password, config.DEVICE_PASSWORD_PEPPER);

  for (let attempt = 0; ; attempt++) {
    const deviceId = generateDeviceId();
    try {
      const result = await db.transaction(async (tx) => {
        const t = tx.orm.public;
        // Claim the token atomically: only one redemption can flip usedAt.
        const token = await t.EnrollmentToken.where({ tokenHash: hashPairingToken(canonical), usedAt: null })
          .where((e) => e.expiresAt.gt(new Date()))
          .update({ usedAt: new Date(), deviceId });
        if (!token) throw invalidToken();

        const superseded = await t.Device.where({ hardwareId: req.hardwareId, status: "active" })
          .select("id")
          .updateAll({ status: "superseded", revokedAt: new Date(), online: false, connectionName: null });

        const name = req.name?.trim() || token.deviceName || `${platform.id}-${deviceId}`;
        await t.Device.create({
          id: deviceId,
          ownerId: token.ownerId,
          name,
          hardwareId: req.hardwareId,
          platform: platform.id,
          chip: req.chip ?? null,
          fwVersion: req.fwVersion ?? null,
          passwordHash,
        });
        return { name, superseded: superseded.map((d) => d.id) };
      });

      for (const old of result.superseded) {
        invalidateDevice(old);
        await management.closeUserConnections(old, "device re-enrolled");
      }
      log.info({ deviceId, superseded: result.superseded }, "device enrolled");
      return { deviceId, password, name: result.name };
    } catch (err) {
      // Device id collision (unique violation): try another id.
      if (sqlState(err) === "23505" && attempt < 5) continue;
      throw err;
    }
  }
}

/** Unpairs a device: credentials stop working and its live connection is closed. */
export async function revokeDevice(id: string, management: BrokerManagement): Promise<void> {
  await models.Device.where({ id, status: "active" }).update({
    status: "revoked",
    revokedAt: new Date(),
    online: false,
    connectionName: null,
  });
  invalidateDevice(id);
  await management.closeUserConnections(id, "device unpaired");
}
