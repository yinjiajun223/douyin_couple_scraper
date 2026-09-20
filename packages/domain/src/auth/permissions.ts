export type WorkspaceRole = 'admin' | 'operator' | 'readonly';

export type Permission =
  | 'workspace:manage'
  | 'members:manage'
  | 'campaign:read'
  | 'campaign:write'
  | 'candidate:read'
  | 'candidate:write'
  | 'outreach:read'
  | 'outreach:write'
  | 'device:manage'
  | 'audit:read'
  | 'export:run';

export const ROLE_PERMISSIONS: Readonly<Record<WorkspaceRole, readonly Permission[]>> = {
  admin: [
    'workspace:manage',
    'members:manage',
    'campaign:read',
    'campaign:write',
    'candidate:read',
    'candidate:write',
    'outreach:read',
    'outreach:write',
    'device:manage',
    'audit:read',
    'export:run',
  ],
  operator: [
    'campaign:read',
    'campaign:write',
    'candidate:read',
    'candidate:write',
    'outreach:read',
    'outreach:write',
    'device:manage',
    'export:run',
  ],
  readonly: ['campaign:read', 'candidate:read', 'outreach:read', 'export:run'],
};

export class PermissionDeniedError extends Error {
  constructor(readonly permission: Permission) {
    super(`当前角色缺少权限：${permission}`);
    this.name = 'PermissionDeniedError';
  }
}

export function hasPermission(role: WorkspaceRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function assertPermission(role: WorkspaceRole, permission: Permission): void {
  if (!hasPermission(role, permission)) throw new PermissionDeniedError(permission);
}
