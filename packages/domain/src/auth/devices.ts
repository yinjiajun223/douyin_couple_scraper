import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { Pool, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';

import { writeAuditEvent } from '../audit/audit-events.js';
import type { WorkspaceRole } from './permissions.js';

const semanticVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);

const pairingInputSchema = z
  .object({
    code: z.string().trim().min(8).max(32).transform(normalizePairingCode),
    name: z.string().trim().min(2).max(200),
    collectorVersion: semanticVersionSchema,
    parserVersion: semanticVersionSchema,
  })
  .strict();

interface PairingRow extends RowDataPacket {
  created_by_user_id: string;
  expires_at: Date;
  id: string;
  used_at: Date | null;
  workspace_id: string;
}

interface DeviceRow extends RowDataPacket {
  collector_version: string | null;
  device_id: string;
  name: string;
  owner_user_id: string;
  parser_version: string | null;
  status: string;
  workspace_id: string;
}

export class PairingCodeInvalidError extends Error {
  constructor() {
    super('配对码无效');
    this.name = 'PairingCodeInvalidError';
  }
}

export class PairingCodeExpiredError extends Error {
  constructor() {
    super('配对码已过期');
    this.name = 'PairingCodeExpiredError';
  }
}

export class PairingCodeAlreadyUsedError extends Error {
  constructor() {
    super('配对码已经使用');
    this.name = 'PairingCodeAlreadyUsedError';
  }
}

export class DeviceAccessDeniedError extends Error {
  constructor() {
    super('无权管理该设备');
    this.name = 'DeviceAccessDeniedError';
  }
}

export class DeviceNotActiveError extends Error {
  constructor() {
    super('设备不存在或已撤销');
    this.name = 'DeviceNotActiveError';
  }
}

export interface DevicePrincipal {
  deviceId: string;
  workspaceId: string;
  ownerUserId: string;
  name: string;
  collectorVersion: string | null;
  parserVersion: string | null;
}

export interface PairingCodeResult {
  pairingCodeId: string;
  code: string;
  expiresAt: Date;
}

export interface DeviceTokenResult {
  deviceId: string;
  token: string;
}

export async function createDevicePairingCode(
  pool: Pool,
  workspaceId: string,
  userId: string,
  expiresInSeconds = 10 * 60,
): Promise<PairingCodeResult> {
  if (expiresInSeconds < 60 || expiresInSeconds > 60 * 60) {
    throw new RangeError('配对码有效期必须在 1 到 60 分钟之间');
  }
  const pairingCodeId = randomUUID();
  const code = formatPairingCode(randomBytes(9).toString('base64url').toUpperCase().slice(0, 12));
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
  await pool.execute(
    `INSERT INTO device_pairing_codes
     (id, workspace_id, created_by_user_id, code_hash, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    [pairingCodeId, workspaceId, userId, hashToken(normalizePairingCode(code)), expiresAt],
  );
  await writeAuditEvent(pool, {
    workspaceId,
    actorUserId: userId,
    action: 'device.pairing_code_created',
    subjectType: 'device_pairing_code',
    subjectId: pairingCodeId,
    summary: { expiresAt: expiresAt.toISOString() },
  });
  return { pairingCodeId, code, expiresAt };
}

export async function pairDevice(pool: Pool, rawInput: unknown): Promise<DeviceTokenResult> {
  const input = pairingInputSchema.parse(rawInput);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query<PairingRow[]>(
      `SELECT pairing.id, pairing.workspace_id, pairing.created_by_user_id,
              pairing.expires_at, pairing.used_at
       FROM device_pairing_codes pairing
       JOIN users ON users.id = pairing.created_by_user_id
       JOIN memberships
         ON memberships.workspace_id = pairing.workspace_id
        AND memberships.user_id = pairing.created_by_user_id
       WHERE pairing.code_hash = ?
         AND users.status = 'active'
         AND memberships.role IN ('admin', 'operator')
       LIMIT 1
       FOR UPDATE`,
      [hashToken(input.code)],
    );
    const pairing = rows[0];
    if (!pairing) throw new PairingCodeInvalidError();
    if (pairing.used_at) throw new PairingCodeAlreadyUsedError();
    if (pairing.expires_at.getTime() <= Date.now()) throw new PairingCodeExpiredError();

    const deviceId = randomUUID();
    const token = randomBytes(32).toString('base64url');
    await connection.execute(
      `INSERT INTO devices
       (id, workspace_id, owner_user_id, name, token_hash, collector_version, parser_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        deviceId,
        pairing.workspace_id,
        pairing.created_by_user_id,
        input.name,
        hashToken(token),
        input.collectorVersion,
        input.parserVersion,
      ],
    );
    await connection.execute(
      `UPDATE device_pairing_codes
       SET used_at = CURRENT_TIMESTAMP(3), paired_device_id = ?
       WHERE id = ?`,
      [deviceId, pairing.id],
    );
    await writeAuditEvent(connection, {
      workspaceId: pairing.workspace_id,
      actorUserId: pairing.created_by_user_id,
      actorDeviceId: deviceId,
      action: 'device.paired',
      subjectType: 'device',
      subjectId: deviceId,
      summary: {
        name: input.name,
        collectorVersion: input.collectorVersion,
        parserVersion: input.parserVersion,
      },
    });
    await connection.commit();
    return { deviceId, token };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function authenticateDevice(
  pool: Pool,
  token: string | undefined,
): Promise<DevicePrincipal | null> {
  if (!token) return null;
  const [rows] = await pool.query<DeviceRow[]>(
    `SELECT devices.id AS device_id, devices.workspace_id, devices.owner_user_id,
            devices.name, devices.status, devices.collector_version, devices.parser_version
     FROM devices
     JOIN users ON users.id = devices.owner_user_id
     JOIN memberships
       ON memberships.workspace_id = devices.workspace_id
      AND memberships.user_id = devices.owner_user_id
     WHERE devices.token_hash = ?
       AND devices.status = 'active'
       AND devices.revoked_at IS NULL
       AND users.status = 'active'
       AND memberships.role IN ('admin', 'operator')
     LIMIT 1`,
    [hashToken(token)],
  );
  const device = rows[0];
  if (!device) return null;

  await pool.execute('UPDATE devices SET last_seen_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [
    device.device_id,
  ]);
  return {
    deviceId: device.device_id,
    workspaceId: device.workspace_id,
    ownerUserId: device.owner_user_id,
    name: device.name,
    collectorVersion: device.collector_version,
    parserVersion: device.parser_version,
  };
}

export async function rotateDeviceToken(
  pool: Pool,
  workspaceId: string,
  deviceId: string,
  actorUserId: string,
  actorRole: WorkspaceRole,
): Promise<DeviceTokenResult> {
  await assertDeviceManagementScope(pool, workspaceId, deviceId, actorUserId, actorRole);
  const token = randomBytes(32).toString('base64url');
  await pool.execute(
    `UPDATE devices SET token_hash = ?, updated_at = CURRENT_TIMESTAMP(3)
     WHERE workspace_id = ? AND id = ? AND status = 'active'`,
    [hashToken(token), workspaceId, deviceId],
  );
  await writeAuditEvent(pool, {
    workspaceId,
    actorUserId,
    action: 'device.token_rotated',
    subjectType: 'device',
    subjectId: deviceId,
    summary: { rotated: true },
  });
  return { deviceId, token };
}

export async function revokeDevice(
  pool: Pool,
  workspaceId: string,
  deviceId: string,
  actorUserId: string,
  actorRole: WorkspaceRole,
): Promise<void> {
  await assertDeviceManagementScope(pool, workspaceId, deviceId, actorUserId, actorRole);
  await pool.execute(
    `UPDATE devices
     SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP(3)
     WHERE workspace_id = ? AND id = ? AND status = 'active'`,
    [workspaceId, deviceId],
  );
  await writeAuditEvent(pool, {
    workspaceId,
    actorUserId,
    action: 'device.revoked',
    subjectType: 'device',
    subjectId: deviceId,
    summary: { revoked: true },
  });
}

async function assertDeviceManagementScope(
  pool: Pool,
  workspaceId: string,
  deviceId: string,
  actorUserId: string,
  actorRole: WorkspaceRole,
): Promise<void> {
  const [rows] = await pool.query<DeviceRow[]>(
    `SELECT id AS device_id, workspace_id, owner_user_id, name, status,
            collector_version, parser_version
     FROM devices WHERE workspace_id = ? AND id = ? AND status = 'active' LIMIT 1`,
    [workspaceId, deviceId],
  );
  const device = rows[0];
  if (!device) throw new DeviceNotActiveError();
  if (actorRole !== 'admin' && device.owner_user_id !== actorUserId) {
    throw new DeviceAccessDeniedError();
  }
}

function normalizePairingCode(code: string): string {
  return code.replaceAll('-', '').toUpperCase();
}

function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
