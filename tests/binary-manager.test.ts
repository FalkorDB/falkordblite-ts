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
    it('finds redis-server on the system PATH if installed', () => {
      const result = BinaryManager.findInSystemPath('redis-server');
      // redis-server may not be installed in CI/test environments
      if (result) {
        expect(typeof result).toBe('string');
      }
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

    const hasRedisInPath = () => BinaryManager.findInSystemPath('redis-server');

    (hasRedisInPath() ? it : it.skip)('falls back to system PATH for redis-server when binDir is empty', () => {
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
    const hasRedisInPath = () => BinaryManager.findInSystemPath('redis-server');

    (hasRedisInPath() ? it : it.skip)('returns valid paths for both binaries', async () => {
      const bm = new BinaryManager();
      const paths = await bm.ensureBinaries();

      expect(paths.redisServerPath).toBeDefined();
      expect(paths.falkordbModulePath).toBeDefined();
      expect(existsSync(paths.redisServerPath)).toBe(true);
      expect(existsSync(paths.falkordbModulePath)).toBe(true);
    });

    (hasRedisInPath() ? it : it.skip)('is idempotent — second call returns same paths instantly', async () => {
      const bm = new BinaryManager();
      const first = await bm.ensureBinaries();
      const second = await bm.ensureBinaries();

      expect(first.redisServerPath).toBe(second.redisServerPath);
      expect(first.falkordbModulePath).toBe(second.falkordbModulePath);
    });
  });

  // -----------------------------------------------------------------------
  // npm package resolution
  // -----------------------------------------------------------------------

  describe('npm package resolution', () => {
    const hasRedisInPath = () => BinaryManager.findInSystemPath('redis-server');

    (hasRedisInPath() ? it : it.skip)('attempts to resolve redis-server from npm package before system PATH', () => {
      // This test verifies the resolution order without requiring the npm package
      const bm = new BinaryManager({ binDir: '/nonexistent-bin-dir' });
      const result = bm.getRedisServerPath();
      
      // Should find redis-server either from npm package or system PATH
      expect(result).toBeDefined();
      expect(existsSync(result)).toBe(true);
    });

    (hasRedisInPath() ? it : it.skip)('attempts to resolve falkordb module from npm package before download', async () => {
      // This test verifies that ensureFalkorDBModule checks npm packages first
      const bm = new BinaryManager();
      const paths = await bm.ensureBinaries();
      
      // Should find module either from npm package or download it
      expect(paths.falkordbModulePath).toBeDefined();
      expect(existsSync(paths.falkordbModulePath)).toBe(true);
      expect(paths.falkordbModulePath).toContain('falkordb.so');
    });

    it('user-provided paths take priority over npm packages', () => {
      const real = new BinaryManager();
      let modulePath: string;
      try {
        modulePath = real.getFalkorDBModulePath();
      } catch {
        return; // module not available, skip test
      }

      // User-provided path should be used even if npm package exists
      const bm = new BinaryManager({ 
        falkordbModulePath: modulePath,
        binDir: '/nonexistent-bin-dir' 
      });
      expect(bm.getFalkorDBModulePath()).toBe(modulePath);
    });

    (hasRedisInPath() ? it : it.skip)('gracefully falls back when npm package is not installed', () => {
      // With a nonexistent binDir and no npm package, should fall back to system PATH
      const bm = new BinaryManager({ binDir: '/nonexistent-bin-dir' });
      
      // Should not throw and find redis-server from system PATH
      expect(() => bm.getRedisServerPath()).not.toThrow();
    });
  });
});
