import type { Pool, RowDataPacket } from 'mysql2/promise';

import type { WorkspaceRole } from './permissions.js';

interface MemberRow extends RowDataPacket {
  created_at: Date;
  display_name: string;
  email: string;
  id: string;
  role: WorkspaceRole;
  status: 'active' | 'disabled';
}

interface DeviceDirectoryRow extends RowDataPacket {
  collector_version: string | null;
  id: string;
  last_seen_at: Date | null;
  name: string;
  owner_display_name: string;
  owner_user_id: string;
  parser_version: string | null;
  status: 'active' | 'revoked';
}

export async function listWorkspaceMembers(pool: Pool, workspaceId: string) {
  const [rows] = await pool.query<MemberRow[]>(
    `SELECT users.id, users.email, users.display_name, users.status,
            memberships.role, memberships.created_at
     FROM memberships
     JOIN users ON users.id = memberships.user_id
     WHERE memberships.workspace_id = ?
     ORDER BY users.status, memberships.created_at`,
    [workspaceId],
  );
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    status: row.status,
    role: row.role,
    joinedAt: row.created_at,
  }));
}

export async function listWorkspaceDevices(
  pool: Pool,
  workspaceId: string,
  actorUserId: string,
  actorRole: WorkspaceRole,
) {
  const values: string[] = [workspaceId];
  const ownerFilter = actorRole === 'admin' ? '' : 'AND devices.owner_user_id = ?';
  if (actorRole !== 'admin') values.push(actorUserId);
  const [rows] = await pool.query<DeviceDirectoryRow[]>(
    `SELECT devices.id, devices.name, devices.status, devices.owner_user_id,
            users.display_name AS owner_display_name, devices.collector_version,
            devices.parser_version, devices.last_seen_at
     FROM devices
     JOIN users ON users.id = devices.owner_user_id
     WHERE devices.workspace_id = ? ${ownerFilter}
     ORDER BY devices.status, devices.updated_at DESC`,
    values,
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    ownerUserId: row.owner_user_id,
    ownerDisplayName: row.owner_display_name,
    collectorVersion: row.collector_version,
    parserVersion: row.parser_version,
    lastSeenAt: row.last_seen_at,
  }));
}
