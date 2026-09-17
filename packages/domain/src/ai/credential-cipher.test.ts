import { describe, expect, it } from 'vitest';

import { CredentialCipher, CredentialKeyUnavailableError } from './credential-cipher.js';

describe('CredentialCipher', () => {
  it('uses authenticated, context-bound encryption without retaining plaintext', () => {
    const cipher = CredentialCipher.fromSingleKey('a'.repeat(32));
    const material = cipher.encrypt('provider-secret-value', 'workspace:connection');

    expect(material.ciphertext.toString('utf8')).not.toContain('provider-secret-value');
    expect(cipher.decrypt(material, 'workspace:connection')).toBe('provider-secret-value');
    expect(() => cipher.decrypt(material, 'another-workspace:connection')).toThrow();
  });

  it('can decrypt an old key version while encrypting with the active version', () => {
    const oldCipher = new CredentialCipher({ activeVersion: 1, keys: { 1: 'a'.repeat(32) } });
    const oldMaterial = oldCipher.encrypt('rotated-secret', 'scope');
    const rotatingCipher = new CredentialCipher({
      activeVersion: 2,
      keys: { 1: 'a'.repeat(32), 2: 'b'.repeat(32) },
    });

    expect(rotatingCipher.decrypt(oldMaterial, 'scope')).toBe('rotated-secret');
    expect(rotatingCipher.encrypt('rotated-secret', 'scope').keyVersion).toBe(2);
    expect(() =>
      new CredentialCipher({ activeVersion: 2, keys: { 2: 'b'.repeat(32) } }).decrypt(
        oldMaterial,
        'scope',
      ),
    ).toThrow(CredentialKeyUnavailableError);
  });
});
