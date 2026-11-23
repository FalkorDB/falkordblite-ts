import { createHash } from 'node:crypto';
import { existsSync, createWriteStream, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { platform, arch } from 'node:os';
import { execFileSync } from 'node:child_process';
import { get as httpsGet } from 'node:https';
import { get as httpGet } from 'node:http';
import { pipeline } from 'node:stream/promises';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default FalkorDB release version to download. */
export const FALKORDB_VERSION = 'v6.2.0';

export function matchesFalkorDBPackageRelease(
  packageVersion: string,
  falkordbVersion: string,
): boolean {
  const release = falkordbVersion.replace(/^v/, '');
  const packageRelease = /-falkordb\.(.+)$/.exec(packageVersion)?.[1];
  const packagingRevision = packageRelease?.match(/^(.*)-license\.\d+$/);
  const packagedRelease = packagingRevision?.[1] ?? packageRelease;
  const isPlainRelease = /^\d+\.\d+\.\d+$/.test(release);
  const isPlainRevisionBase =
    !!packagingRevision && /^\d+\.\d+\.\d+$/.test(packagingRevision[1]);
  return (
    packagedRelease === release &&
    (!packagingRevision || isPlainRelease)
  ) || (
    !!packagingRevision &&
    packageRelease === release &&
    !isPlainRevisionBase
  );
}

/** Maximum HTTP redirects to follow (GitHub → S3). */
const MAX_REDIRECTS = 5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SupportedPlatform = 'linux-x64' | 'darwin-arm64';

interface PlatformMeta {
  /** Asset filename on the FalkorDB GitHub release. */
  falkordbAsset: string;
  /** Local filename for the downloaded module. */
  moduleName: string;
  /** redis-server binary name on this platform. */
  redisServerBin: string;
}

export interface BinaryManagerOptions {
  /** Custom path to a redis-server binary. Takes highest priority. */
  redisServerPath?: string;
  /** Custom path to a FalkorDB module (.so). Takes highest priority. */
  falkordbModulePath?: string;
  /** Directory to store downloaded binaries. Defaults to <package-root>/bin. */
  binDir?: string;
  /** FalkorDB GitHub release tag, e.g. "v6.2.0". */
  falkordbVersion?: string;
}

export interface BinaryPaths {
  redisServerPath: string;
  falkordbModulePath: string;
}

// ---------------------------------------------------------------------------
// Platform map (MVP: linux-x64, darwin-arm64)
// ---------------------------------------------------------------------------

const PLATFORMS: Record<SupportedPlatform, PlatformMeta> = {
  'linux-x64': {
    falkordbAsset: 'falkordb-x64.so',
    moduleName: 'falkordb.so',
    redisServerBin: 'redis-server',
  },
  'darwin-arm64': {
    falkordbAsset: 'falkordb-macos-arm64v8.so',
    moduleName: 'falkordb.so',
    redisServerBin: 'redis-server',
  },
};

export function resolvePackagedFalkorDBModule(
  packageJsonPath: string,
  falkordbVersion: string,
  platform: SupportedPlatform,
): string | undefined {
  const packageName = `@falkordblite/${platform}/package.json`;
  const packageInfo: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  if (
    typeof packageInfo !== 'object' ||
    packageInfo === null ||
    !('version' in packageInfo) ||
    typeof packageInfo.version !== 'string'
  ) {
    throw new Error(`Missing version in ${packageName}`);
  }

  if (!matchesFalkorDBPackageRelease(packageInfo.version, falkordbVersion)) {
    return undefined;
  }
  const modulePath = join(
    dirname(packageJsonPath),
    'bin',
    PLATFORMS[platform].moduleName,
  );
  return existsSync(modulePath) ? modulePath : undefined;
}

// ---------------------------------------------------------------------------
// BinaryManager
// ---------------------------------------------------------------------------

export class BinaryManager {
  private readonly binDir: string;
  private readonly falkordbVersion: string;
  private readonly userRedisServerPath?: string;
  private readonly userModulePath?: string;

  constructor(options?: BinaryManagerOptions) {
    this.userRedisServerPath = options?.redisServerPath;
    this.userModulePath = options?.falkordbModulePath;
    this.falkordbVersion = options?.falkordbVersion ?? FALKORDB_VERSION;
    this.binDir = options?.binDir ?? join(__dirname, '..', 'bin');
  }

  // -----------------------------------------------------------------------
  // Static helpers
  // -----------------------------------------------------------------------

  /** Detect the current platform. Throws on unsupported platforms. */
  static detectPlatform(): SupportedPlatform {
    const os = platform();
    const a = arch();
    const key = `${os}-${a}`;
    if (!(key in PLATFORMS)) {
      throw new Error(
        `Unsupported platform: ${os}-${a}. ` +
        `Supported: ${Object.keys(PLATFORMS).join(', ')}`,
      );
    }
    return key as SupportedPlatform;
  }

  /** Look up a binary on the system PATH. Returns absolute path or undefined. */
  static findInSystemPath(name: string): string | undefined {
    try {
      const cmd = platform() === 'win32' ? 'where' : 'which';
      const result = execFileSync(cmd, [name], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return result.split('\n')[0] || undefined;
    } catch {
      return undefined;
    }
  }

  /** Read a redis-server binary's version, e.g. [8, 10, 3]. Returns undefined if unknown. */
  static getRedisVersion(redisServerPath: string): number[] | undefined {
    try {
      const output = execFileSync(redisServerPath, ['--version'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5_000,
      });
      const match = /\bv=(\d+)\.(\d+)\.(\d+)/.exec(output);
      return match ? match.slice(1).map(Number) : undefined;
    } catch {
      return undefined;
    }
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Ensure all required binaries are available.
   *
   * - Downloads the FalkorDB module from GitHub if not already present.
   * - Verifies redis-server is reachable (user path → bin/ → newer of system PATH and platform package).
   *
   * Idempotent: skips downloads when the target file already exists.
   */
  async ensureBinaries(): Promise<BinaryPaths> {
    const falkordbModulePath = await this.ensureFalkorDBModule();
    const redisServerPath = this.resolveRedisServer();
    return { redisServerPath, falkordbModulePath };
  }

  /**
   * Resolve redis-server path (no download).
   * @throws {Error} If redis-server is not found in the configured path, packaged binaries, or system PATH.
   */
  getRedisServerPath(): string {
    return this.resolveRedisServer();
  }

  /**
   * Resolve FalkorDB module path (no download).
   * @throws {Error} If the FalkorDB module is not found and cannot be resolved.
   */
  getFalkorDBModulePath(): string {
    return this.resolveFalkorDBModule();
  }

  // -----------------------------------------------------------------------
  // Private: path resolution
  // -----------------------------------------------------------------------

  private resolveRedisServer(): string {
    // 1. User-provided path
    if (this.userRedisServerPath) {
      if (!existsSync(this.userRedisServerPath)) {
        throw new Error(
          `redis-server not found at: ${this.userRedisServerPath}`,
        );
      }
      return this.userRedisServerPath;
    }

    // 2. Package-local bin/ directory
    try {
      const key = BinaryManager.detectPlatform();
      const local = join(this.binDir, key, PLATFORMS[key].redisServerBin);
      if (existsSync(local)) return local;
    } catch {
      // Platform detection failed — skip bin/ check, fall through to PATH.
    }

    // 3. System PATH or platform package (@falkordblite/<platform>)
    const system = BinaryManager.findInSystemPath('redis-server');
    let packaged: string | undefined;
    try {
      const key = BinaryManager.detectPlatform();
      const pkgName = `@falkordblite/${key}`;
      const pkgDir = dirname(require.resolve(`${pkgName}/package.json`));
      const npmBin = join(pkgDir, 'bin', PLATFORMS[key].redisServerBin);
      if (existsSync(npmBin)) packaged = npmBin;
    } catch {
      // Package not installed.
    }

    // Use whichever is newer: an older system Redis may not load the module,
    // and an older bundled Redis may not read data saved by the system Redis.
    if (system && packaged) {
      const systemVersion = BinaryManager.getRedisVersion(system);
      const packagedVersion = BinaryManager.getRedisVersion(packaged);
      if (!systemVersion) return packaged;
      if (!packagedVersion || compareVersions(systemVersion, packagedVersion) >= 0) {
        return system;
      }
      return packaged;
    }
    const found = system ?? packaged;
    if (found) return found;

    throw new Error(
      'redis-server not found. Install it with:\n' +
      '  Ubuntu/Debian: sudo apt install redis-server\n' +
      '  macOS:         brew install redis\n' +
      'Or pass redisServerPath in options.',
    );
  }

  private resolveFalkorDBModule(): string {
    // 1. User-provided path
    if (this.userModulePath) {
      if (!existsSync(this.userModulePath)) {
        throw new Error(
          `FalkorDB module not found at: ${this.userModulePath}`,
        );
      }
      return this.userModulePath;
    }

    const key = BinaryManager.detectPlatform();
    const managed = this.findManagedFalkorDBModule(key);
    if (managed) return managed;

    throw new Error(
      'FalkorDB module not found. Run `npm run postinstall` to download it,\n' +
      'or pass falkordbModulePath in options.',
    );
  }

  private cachedFalkorDBModulePath(key: SupportedPlatform): string {
    // Release tags remain distinct on case-insensitive filesystems.
    const versionKey = createHash('sha256').update(this.falkordbVersion).digest('hex');
    return join(
      this.binDir,
      key,
      `falkordb-${versionKey}`,
      PLATFORMS[key].moduleName,
    );
  }

  private findManagedFalkorDBModule(key: SupportedPlatform): string | undefined {
    const packageName = `@falkordblite/${key}/package.json`;
    let packageJsonPath: string;
    try {
      packageJsonPath = require.resolve(packageName);
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'MODULE_NOT_FOUND'
      ) {
        const cached = this.cachedFalkorDBModulePath(key);
        return existsSync(cached) ? cached : undefined;
      }
      throw error;
    }

    const packaged = resolvePackagedFalkorDBModule(
      packageJsonPath,
      this.falkordbVersion,
      key,
    );
    if (packaged) return packaged;

    const cached = this.cachedFalkorDBModulePath(key);
    return existsSync(cached) ? cached : undefined;
  }

  // -----------------------------------------------------------------------
  // Private: download
  // -----------------------------------------------------------------------

  private async ensureFalkorDBModule(): Promise<string> {
    // User-provided path — use directly
    if (this.userModulePath) {
      if (!existsSync(this.userModulePath)) {
        throw new Error(
          `FalkorDB module not found at: ${this.userModulePath}`,
        );
      }
      return this.userModulePath;
    }

    const key = BinaryManager.detectPlatform();
    const meta = PLATFORMS[key];
    const managed = this.findManagedFalkorDBModule(key);
    if (managed) return managed;

    const targetPath = this.cachedFalkorDBModulePath(key);
    const url =
      `https://github.com/FalkorDB/FalkorDB/releases/download/` +
      `${encodeURIComponent(this.falkordbVersion)}/${meta.falkordbAsset}`;

    const targetDir = dirname(targetPath);
    await mkdir(targetDir, { recursive: true });
    const stagingDir = await mkdtemp(join(targetDir, '.download-'));
    const stagingPath = join(stagingDir, meta.moduleName);
    try {
      console.log(`Downloading FalkorDB module (${meta.falkordbAsset})...`);
      await downloadFile(url, stagingPath);
      await chmod(stagingPath, 0o755);
      await rename(stagingPath, targetPath);
    } finally {
      await rm(stagingDir, { recursive: true, force: true });
    }
    console.log(`  saved to ${targetPath}`);

    return targetPath;
  }
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Download helper (module-internal)
// ---------------------------------------------------------------------------

/**
 * Download a file from `url` to `destPath`, following HTTP redirects
 * (GitHub release URLs redirect through S3).
 * The caller cleans up the staging directory on failure.
 */
function downloadFile(
  url: string,
  destPath: string,
  redirectsLeft = MAX_REDIRECTS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redirectsLeft <= 0) {
      reject(new Error('Too many HTTP redirects'));
      return;
    }

    const get = url.startsWith('https:') ? httpsGet : httpGet;

    const req = get(url, (res) => {
      const { statusCode } = res;

      // Follow redirects
      if (
        (statusCode === 301 ||
          statusCode === 302 ||
          statusCode === 307 ||
          statusCode === 308) &&
        res.headers.location
      ) {
        res.resume();
        downloadFile(res.headers.location, destPath, redirectsLeft - 1)
          .then(resolve, reject);
        return;
      }

      if (statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${statusCode} downloading ${url}`));
        return;
      }

      // Log file size if available
      const contentLength = res.headers['content-length'];
      if (contentLength) {
        const mb = (parseInt(contentLength, 10) / (1024 * 1024)).toFixed(1);
        console.log(`  size: ${mb} MB`);
      }

      pipeline(res, createWriteStream(destPath)).then(resolve, reject);
    });

    req.on('error', reject);
  });
}
