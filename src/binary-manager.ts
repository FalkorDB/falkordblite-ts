import { existsSync, createWriteStream } from 'node:fs';
import { chmod, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { platform, arch } from 'node:os';
import { execFileSync } from 'node:child_process';
import { get as httpsGet } from 'node:https';
import { get as httpGet } from 'node:http';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default FalkorDB release version to download. */
export const FALKORDB_VERSION = 'v4.16.3';

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
  /** Directory to store downloaded binaries. Defaults to &lt;package-root&gt;/bin. */
  binDir?: string;
  /** FalkorDB GitHub release tag, e.g. "v4.16.3". */
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

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Ensure all required binaries are available.
   *
   * - Downloads the FalkorDB module from GitHub if not already present.
   * - Verifies redis-server is reachable (user path → bin/ → system PATH).
   *
   * Idempotent: skips downloads when the target file already exists.
   */
  async ensureBinaries(): Promise<BinaryPaths> {
    const falkordbModulePath = await this.ensureFalkorDBModule();
    const redisServerPath = this.resolveRedisServer();
    return { redisServerPath, falkordbModulePath };
  }

  /** Resolve redis-server path (no download). Throws if not found. */
  getRedisServerPath(): string {
    return this.resolveRedisServer();
  }

  /** Resolve FalkorDB module path (no download). Throws if not found. */
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

    // 3. Platform-specific npm package (@falkordblite/<platform>)
    try {
      const key = BinaryManager.detectPlatform();
      const pkgName = `@falkordblite/${key}`;
      const pkgDir = join(
        require.resolve(`${pkgName}/package.json`),
        '..',
      );
      const npmBin = join(pkgDir, 'bin', PLATFORMS[key].redisServerBin);
      if (existsSync(npmBin)) return npmBin;
    } catch {
      // Package not installed — fall through to system PATH.
    }

    // 4. System PATH
    const system = BinaryManager.findInSystemPath('redis-server');
    if (system) return system;

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

    // 2. Package-local bin/ directory
    const key = BinaryManager.detectPlatform();
    const local = join(this.binDir, key, PLATFORMS[key].moduleName);
    if (existsSync(local)) return local;

    // 3. Platform-specific npm package (@falkordblite/<platform>)
    try {
      const pkgName = `@falkordblite/${key}`;
      const pkgDir = join(
        require.resolve(`${pkgName}/package.json`),
        '..',
      );
      const npmBin = join(pkgDir, 'bin', PLATFORMS[key].moduleName);
      if (existsSync(npmBin)) return npmBin;
    } catch {
      // Package not installed — fall through.
    }

    throw new Error(
      'FalkorDB module not found. Run `npm run postinstall` to download it,\n' +
      'or pass falkordbModulePath in options.',
    );
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

    // Check platform-specific npm package first
    try {
      const pkgName = `@falkordblite/${key}`;
      const pkgDir = join(require.resolve(`${pkgName}/package.json`), '..');
      const npmBin = join(pkgDir, 'bin', meta.moduleName);
      if (existsSync(npmBin)) return npmBin;
    } catch {
      // Not installed — proceed with download.
    }

    const targetDir = join(this.binDir, key);
    const targetPath = join(targetDir, meta.moduleName);

    // Idempotent: already present → skip
    if (existsSync(targetPath)) return targetPath;

    const url =
      `https://github.com/FalkorDB/FalkorDB/releases/download/` +
      `${this.falkordbVersion}/${meta.falkordbAsset}`;

    await mkdir(targetDir, { recursive: true });

    console.log(`Downloading FalkorDB module (${meta.falkordbAsset})...`);
    await downloadFile(url, targetPath);
    await chmod(targetPath, 0o755);
    console.log(`  saved to ${targetPath}`);

    return targetPath;
  }
}

// ---------------------------------------------------------------------------
// Download helper (module-internal)
// ---------------------------------------------------------------------------

/**
 * Download a file from `url` to `destPath`, following HTTP redirects
 * (GitHub release URLs redirect through S3).
 * Cleans up partial files on failure.
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

      const file = createWriteStream(destPath);
      res.pipe(file);

      file.on('finish', () => {
        file.close(() => resolve());
      });

      file.on('error', (err) => {
        unlink(destPath).catch(() => {});
        reject(err);
      });
    });

    req.on('error', (err) => {
      unlink(destPath).catch(() => {});
      reject(err);
    });
  });
}
