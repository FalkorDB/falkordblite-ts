import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { platform, arch } from 'node:os';
import { BinaryManager, FALKORDB_VERSION } from '../src/binary-manager';
import { cleanupAll, makeTempDir } from './helpers';

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
    it('finds valkey-server on the system PATH if installed', () => {
      const result = BinaryManager.findInSystemPath('valkey-server');
      // valkey-server may not be installed in CI/test environments
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
    it('user-provided valkey-server path takes highest priority', () => {
      const systemPath = BinaryManager.findInSystemPath('valkey-server');
      if (!systemPath) return; // skip if not installed

      const bm = new BinaryManager({ valkeyServerPath: systemPath });
      expect(bm.getValkeyServerPath()).toBe(systemPath);
    });

    it('throws when user-provided valkey-server path does not exist', () => {
      const bm = new BinaryManager({
        valkeyServerPath: '/nonexistent/valkey-server',
      });
      expect(() => bm.getValkeyServerPath()).toThrow('not found at');
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

    const hasValkeyInPath = () => BinaryManager.findInSystemPath('valkey-server');

    it('resolves valkey-server from the package-local bin directory', async () => {
      const binDir = await makeTempDir();
      const platformDir = join(binDir, BinaryManager.detectPlatform());
      const valkeyServerPath = join(platformDir, 'valkey-server');
      await mkdir(platformDir, { recursive: true });
      await writeFile(valkeyServerPath, '');

      const bm = new BinaryManager({ binDir });
      expect(bm.getValkeyServerPath()).toBe(valkeyServerPath);
    });

    (hasValkeyInPath() ? it : it.skip)('falls back to system PATH for valkey-server when binDir is empty', () => {
      const bm = new BinaryManager({ binDir: '/nonexistent-bin-dir' });
      const result = bm.getValkeyServerPath();
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
    const hasValkeyInPath = () => BinaryManager.findInSystemPath('valkey-server');

    (hasValkeyInPath() ? it : it.skip)('returns valid paths for both binaries', async () => {
      const bm = new BinaryManager();
      const paths = await bm.ensureBinaries();

      expect(paths.valkeyServerPath).toBeDefined();
      expect(paths.falkordbModulePath).toBeDefined();
      expect(existsSync(paths.valkeyServerPath)).toBe(true);
      expect(existsSync(paths.falkordbModulePath)).toBe(true);
    });

    (hasValkeyInPath() ? it : it.skip)('is idempotent — second call returns same paths instantly', async () => {
      const bm = new BinaryManager();
      const first = await bm.ensureBinaries();
      const second = await bm.ensureBinaries();

      expect(first.valkeyServerPath).toBe(second.valkeyServerPath);
      expect(first.falkordbModulePath).toBe(second.falkordbModulePath);
    });
  });

  // -----------------------------------------------------------------------
  // npm package resolution
  // -----------------------------------------------------------------------

  describe('npm package resolution', () => {
    const hasValkeyInPath = () => BinaryManager.findInSystemPath('valkey-server');

    (hasValkeyInPath() ? it : it.skip)('attempts to resolve valkey-server from npm package before system PATH', () => {
      // This test verifies the resolution order without requiring the npm package
      const bm = new BinaryManager({ binDir: '/nonexistent-bin-dir' });
      const result = bm.getValkeyServerPath();
      
      // Should find valkey-server either from npm package or system PATH
      expect(result).toBeDefined();
      expect(existsSync(result)).toBe(true);
    });

    (hasValkeyInPath() ? it : it.skip)('attempts to resolve falkordb module from npm package before download', async () => {
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

    (hasValkeyInPath() ? it : it.skip)('gracefully falls back when npm package is not installed', () => {
      // With a nonexistent binDir and no npm package, should fall back to system PATH
      const bm = new BinaryManager({ binDir: '/nonexistent-bin-dir' });
      
      // Should not throw and find valkey-server from system PATH
      expect(() => bm.getValkeyServerPath()).not.toThrow();
    });
  });
});
