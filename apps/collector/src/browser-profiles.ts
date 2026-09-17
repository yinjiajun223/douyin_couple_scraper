import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { chromium } from 'playwright';
import type { BrowserContext } from 'playwright';

type PersistentContextOptions = NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>;

const REGISTRY_VERSION = 1;
const systemBrowserProfilePattern =
  /[\\/]AppData[\\/]Local[\\/](?:Google[\\/]Chrome|Microsoft[\\/]Edge)[\\/]User Data(?:[\\/]|$)/iu;

export interface CollectorBrowserProfile {
  createdAt: string;
  id: string;
  label: string;
  userDataDir: string;
}

interface ProfileRegistry {
  activeProfileId: string | null;
  profiles: CollectorBrowserProfile[];
  version: typeof REGISTRY_VERSION;
}

export interface PersistentBrowserLauncher {
  launchPersistentContext(
    userDataDir: string,
    options: PersistentContextOptions,
  ): Promise<BrowserContext>;
}

export class CollectorProfileNotFoundError extends Error {
  public constructor(profileId: string) {
    super(`Collector browser profile ${profileId} was not found.`);
    this.name = 'CollectorProfileNotFoundError';
  }
}

export class UnsafeCollectorDataDirectoryError extends Error {
  public constructor() {
    super('Collector data cannot use a daily Chrome or Edge user-data directory.');
    this.name = 'UnsafeCollectorDataDirectoryError';
  }
}

export class CollectorBrowserProfileStore {
  public readonly dataRoot: string;
  private readonly profilesRoot: string;
  private readonly registryPath: string;

  public constructor(dataDirectory: string) {
    this.dataRoot = path.resolve(dataDirectory);
    if (systemBrowserProfilePattern.test(this.dataRoot)) {
      throw new UnsafeCollectorDataDirectoryError();
    }
    this.profilesRoot = path.join(this.dataRoot, 'browser-profiles');
    this.registryPath = path.join(this.dataRoot, 'browser-profiles.json');
  }

  public async createProfile(label: string): Promise<CollectorBrowserProfile> {
    const normalizedLabel = label.replace(/\s+/gu, ' ').trim();
    if (!normalizedLabel || normalizedLabel.length > 80) {
      throw new RangeError('Profile label must contain 1 to 80 characters.');
    }
    const registry = await this.readRegistry();
    const id = randomUUID();
    const userDataDir = this.profileDirectory(id);
    const profile = {
      createdAt: new Date().toISOString(),
      id,
      label: normalizedLabel,
      userDataDir,
    };
    await mkdir(userDataDir, { recursive: true });
    registry.profiles.push(profile);
    registry.activeProfileId ??= id;
    await this.writeRegistry(registry);
    return profile;
  }

  public async listProfiles(): Promise<CollectorBrowserProfile[]> {
    return (await this.readRegistry()).profiles;
  }

  public async selectProfile(profileId: string): Promise<CollectorBrowserProfile> {
    const registry = await this.readRegistry();
    const profile = registry.profiles.find((entry) => entry.id === profileId);
    if (!profile) throw new CollectorProfileNotFoundError(profileId);
    registry.activeProfileId = profileId;
    await this.writeRegistry(registry);
    return profile;
  }

  public async getSelectedProfile(): Promise<CollectorBrowserProfile | null> {
    const registry = await this.readRegistry();
    if (!registry.activeProfileId) return null;
    return registry.profiles.find((entry) => entry.id === registry.activeProfileId) ?? null;
  }

  private profileDirectory(profileId: string): string {
    const directory = path.resolve(this.profilesRoot, profileId);
    const requiredPrefix = `${path.resolve(this.profilesRoot)}${path.sep}`;
    if (!directory.startsWith(requiredPrefix)) throw new UnsafeCollectorDataDirectoryError();
    return directory;
  }

  private async readRegistry(): Promise<ProfileRegistry> {
    await mkdir(this.profilesRoot, { recursive: true });
    try {
      const raw = JSON.parse(await readFile(this.registryPath, 'utf8')) as unknown;
      if (!isProfileRegistry(raw)) throw new Error('Invalid collector browser profile registry.');
      for (const profile of raw.profiles) {
        if (profile.userDataDir !== this.profileDirectory(profile.id)) {
          throw new UnsafeCollectorDataDirectoryError();
        }
      }
      return raw;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { activeProfileId: null, profiles: [], version: REGISTRY_VERSION };
    }
  }

  private async writeRegistry(registry: ProfileRegistry): Promise<void> {
    await mkdir(this.dataRoot, { recursive: true });
    const temporaryPath = `${this.registryPath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporaryPath, this.registryPath);
  }
}

export async function launchSelectedCollectorProfile(
  store: CollectorBrowserProfileStore,
  launcher: PersistentBrowserLauncher = chromium,
): Promise<BrowserContext> {
  const profile = await store.getSelectedProfile();
  if (!profile) throw new CollectorProfileNotFoundError('active');
  return launcher.launchPersistentContext(profile.userDataDir, {
    channel: 'chrome',
    headless: false,
    viewport: { height: 900, width: 1_440 },
  });
}

function isProfileRegistry(value: unknown): value is ProfileRegistry {
  if (!value || typeof value !== 'object') return false;
  const registry = value as Partial<ProfileRegistry>;
  return (
    registry.version === REGISTRY_VERSION &&
    (registry.activeProfileId === null || typeof registry.activeProfileId === 'string') &&
    Array.isArray(registry.profiles) &&
    registry.profiles.every(
      (profile) =>
        profile &&
        typeof profile.id === 'string' &&
        typeof profile.label === 'string' &&
        typeof profile.createdAt === 'string' &&
        typeof profile.userDataDir === 'string',
    )
  );
}
