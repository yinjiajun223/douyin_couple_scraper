import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export interface EncryptedCredential {
  authTag: Buffer;
  ciphertext: Buffer;
  iv: Buffer;
  keyVersion: number;
}

export interface CredentialKeyringConfig {
  activeVersion: number;
  keys: Readonly<Record<number, string>>;
}

export class CredentialKeyUnavailableError extends Error {
  public constructor(public readonly keyVersion: number) {
    super(`Credential encryption key version ${keyVersion} is unavailable.`);
    this.name = 'CredentialKeyUnavailableError';
  }
}

export class CredentialCipher {
  private readonly keys = new Map<number, Buffer>();

  public readonly activeVersion: number;

  public constructor(config: CredentialKeyringConfig) {
    this.activeVersion = config.activeVersion;
    for (const [rawVersion, secret] of Object.entries(config.keys)) {
      const version = Number(rawVersion);
      if (!Number.isInteger(version) || version < 1 || secret.length < 32) {
        throw new TypeError(
          'Credential key versions must be positive integers with 32+ character secrets.',
        );
      }
      this.keys.set(version, deriveEncryptionKey(secret));
    }
    if (!this.keys.has(this.activeVersion)) {
      throw new CredentialKeyUnavailableError(this.activeVersion);
    }
  }

  public static fromSingleKey(secret: string, version = 1): CredentialCipher {
    return new CredentialCipher({ activeVersion: version, keys: { [version]: secret } });
  }

  public encrypt(plaintext: string, context: string): EncryptedCredential {
    if (!plaintext) throw new TypeError('Credential cannot be empty.');
    const key = this.requireKey(this.activeVersion);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      authTag: cipher.getAuthTag(),
      ciphertext,
      iv,
      keyVersion: this.activeVersion,
    };
  }

  public decrypt(material: EncryptedCredential, context: string): string {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.requireKey(material.keyVersion),
      material.iv,
    );
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(material.authTag);
    return Buffer.concat([decipher.update(material.ciphertext), decipher.final()]).toString('utf8');
  }

  private requireKey(version: number): Buffer {
    const key = this.keys.get(version);
    if (!key) throw new CredentialKeyUnavailableError(version);
    return key;
  }
}

function deriveEncryptionKey(secret: string): Buffer {
  return createHash('sha256')
    .update('douyin-ops/credential-encryption/v1\0', 'utf8')
    .update(secret, 'utf8')
    .digest();
}
