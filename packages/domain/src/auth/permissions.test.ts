import { describe, expect, it } from 'vitest';

import { assertPermission, hasPermission, PermissionDeniedError } from './permissions.js';

describe('工作区角色权限矩阵', () => {
  it('管理员拥有成员和工作区管理权限', () => {
    expect(hasPermission('admin', 'members:manage')).toBe(true);
    expect(hasPermission('admin', 'workspace:manage')).toBe(true);
  });

  it('运营可写业务数据但不能管理系统成员', () => {
    expect(hasPermission('operator', 'campaign:write')).toBe(true);
    expect(hasPermission('operator', 'candidate:write')).toBe(true);
    expect(() => assertPermission('operator', 'members:manage')).toThrow(PermissionDeniedError);
  });

  it('只读成员可查看但不能写入', () => {
    expect(hasPermission('readonly', 'candidate:read')).toBe(true);
    expect(hasPermission('readonly', 'outreach:write')).toBe(false);
    expect(() => assertPermission('readonly', 'campaign:write')).toThrow(PermissionDeniedError);
  });
});
