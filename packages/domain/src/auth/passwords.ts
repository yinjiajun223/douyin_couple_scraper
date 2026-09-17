import argon2 from 'argon2';
import { z } from 'zod';

export const strongPasswordSchema = z
  .string()
  .min(12, '密码至少需要 12 个字符')
  .max(200)
  .regex(/[a-z]/, '密码必须包含小写字母')
  .regex(/[A-Z]/, '密码必须包含大写字母')
  .regex(/[0-9]/, '密码必须包含数字');

export const adminBootstrapInputSchema = z
  .object({
    workspaceId: z.uuid(),
    email: z
      .email()
      .max(320)
      .transform((value) => value.trim().toLowerCase()),
    displayName: z.string().trim().min(2).max(200),
    password: strongPasswordSchema,
  })
  .strict();

export type AdminBootstrapInput = z.infer<typeof adminBootstrapInputSchema>;

const ARGON2ID_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2ID_OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(passwordHash, password);
  } catch {
    return false;
  }
}
