import { describe, expect, it } from 'vitest';

import { adminBootstrapInputSchema, hashPassword, verifyPassword } from './passwords.js';

describe('Argon2id 管理员密码', () => {
  it('拒绝弱密码和不完整输入', () => {
    const result = adminBootstrapInputSchema.safeParse({
      workspaceId: '00000000-0000-4000-8000-000000000001',
      email: 'admin@example.test',
      displayName: '管理员',
      password: 'admin123',
    });

    expect(result.success).toBe(false);
  });

  it('生成 Argon2id 哈希并校验正确与错误密码', async () => {
    const password = 'StrongAdmin2026';
    const passwordHash = await hashPassword(password);

    expect(passwordHash).toMatch(/^\$argon2id\$/);
    await expect(verifyPassword(passwordHash, password)).resolves.toBe(true);
    await expect(verifyPassword(passwordHash, 'WrongAdmin2026')).resolves.toBe(false);
    expect(passwordHash).not.toContain(password);
  });
});
