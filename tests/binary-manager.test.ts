import { existsSync } from 'node:fs';
import { platform, arch } from 'node:os';
import { BinaryManager, FALKORDB_VERSION } from '../src/binary-manager';
import { cleanupAll } from './helpers';

afterAll(async () => {
  await cleanupAll();
});

describe('BinaryManager', () => {
  // -----------------------------------------------------------------------
  // Platform detection
  // -----------------------------------------------------------------------

  describe('detectPlatform', () => {
    it('returns a key matching the current os-arch', () => {
      const key = BinaryManager.detectPlatform();
      expect(key).toBe(`${platform()}-${arch()}`);
    });

    it('returns one of the supported platform keys', () => {
      const key = BinaryManager.detectPlatform();
      expect(['linux-x64', 'darwin-arm64']).toContain(key);
    });
  });

  // -----------------------------------------------------------------------
  // System PATH lookup
  // -----------------------------------------------------------------------

  describe('findInSystemPath', () => {
    it('finds redis-server on the system PATH', () => {
      const result = BinaryManager.findInSystemPath('redis-server');
      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
    });

    it('returns undefined for a nonexistent binary', () => {
      const result = BinaryManager.findInSystemPath(
        'nonexistent-binary-xyz-99999',
      );
      expect(result).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // FALKORDB_VERSION constant
  // -----------------------------------------------------------------------

  describe('FALKORDB_VERSION', () => {
    it('is a semver string prefixed with v', () => {
      expect(FALKORDB_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
    });
  });

  // -----------------------------------------------------------------------
  // Path resolution priority
  // -----------------------------------------------------------------------

  describe('path resolution priority', () => {
    it('user-provided redis-server path takes highest priority', () => {
      const systemPath = BinaryManager.findInSystemPath('redis-server');
      if (!systemPath) return; // skip if not installed

      const bm = new BinaryManager({ redisServerPath: systemPath });
      expect(bm.getRedisServerPath()).toBe(systemPath);
    });

    it('throws when user-provided redis-server path does not exist', () => {
      const bm = new BinaryManager({
        redisServerPath: '/nonexistent/redis-server',
      });
      expect(() => bm.getRedisServerPath()).toThrow('not found at');
    });

    it('user-provided falkordb module path takes highest priority', () => {
      // Resolve the real module path first
      const real = new BinaryManager();
      let modulePath: string;
      try {
        modulePath = real.getFalkorDBModulePath();
      } catch {
        return; // module not downloaded yet
      }

      const bm = new BinaryManager({ falkordbModulePath: modulePath });
      expect(bm.getFalkorDBModulePath()).toBe(modulePath);
    });

    it('throws when user-provided falkordb module path does not exist', () => {
      const bm = new BinaryManager({
        falkordbModulePath: '/nonexistent/falkordb.so',
      });
      expect(() => bm.getFalkorDBModulePath()).toThrow('not found at');
    });

    it('falls back to system PATH for redis-server when binDir is empty', () => {
      const bm = new BinaryManager({ binDir: '/nonexistent-bin-dir' });
      const result = bm.getRedisServerPath();
      expect(result).toBeDefined();
      expect(existsSync(result)).toBe(true);
    });

    it('resolves falkordb module from the default bin/ directory', () => {
      const bm = new BinaryManager();
      const modulePath = bm.getFalkorDBModulePath();

      expect(modulePath).toBeDefined();
      expect(existsSync(modulePath)).toBe(true);
      expect(modulePath).toContain('falkordb.so');
    });
  });

  // -----------------------------------------------------------------------
  // ensureBinaries
  // -----------------------------------------------------------------------

  describe('ensureBinaries', () => {
    it('returns valid paths for both binaries', async () => {
      const bm = new BinaryManager();
      const paths = await bm.ensureBinaries();

      expect(paths.redisServerPath).toBeDefined();
      expect(paths.falkordbModulePath).toBeDefined();
      expect(existsSync(paths.redisServerPath)).toBe(true);
      expect(existsSync(paths.falkordbModulePath)).toBe(true);
    });

    it('is idempotent — second call returns same paths instantly', async () => {
      const bm = new BinaryManager();
      const first = await bm.ensureBinaries();
      const second = await bm.ensureBinaries();

      expect(first.redisServerPath).toBe(second.redisServerPath);
      expect(first.falkordbModulePath).toBe(second.falkordbModulePath);
    });
  });
});
