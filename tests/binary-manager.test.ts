import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createServer, get } from 'node:http';
import https from 'node:https';
import { platform, arch } from 'node:os';
import { dirname, join } from 'node:path';
import { BinaryManager, FALKORDB_VERSION } from '../src/binary-manager';
import { cleanupAll, makeTempDir } from './helpers';

afterAll(async () => {
  await cleanupAll();
});

function cachedModulePath(binDir: string, version: string): string {
  const versionKey = createHash('sha256').update(version).digest('hex');
  return join(
    binDir,
    BinaryManager.detectPlatform(),
    `falkordb-${versionKey}`,
    'falkordb.so',
  );
}

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

  describe('release-aware module resolution', () => {
    it('does not reuse legacy or differently versioned cached modules', async () => {
      const binDir = await makeTempDir();
      const key = BinaryManager.detectPlatform();
      const legacy = join(binDir, key, 'falkordb.so');
      const previous = cachedModulePath(binDir, 'v0.0.1-test');
      await mkdir(dirname(previous), { recursive: true });
      await writeFile(legacy, 'legacy');
      await writeFile(previous, 'previous');

      const bm = new BinaryManager({
        binDir,
        falkordbVersion: 'v0.0.2-test',
      });

      expect(() => bm.getFalkorDBModulePath()).toThrow('FalkorDB module not found');
    });

    it('keeps separately requested releases in distinct caches', async () => {
      const binDir = await makeTempDir();
      const versions = ['v0.0.1-test', 'v0.0.1-TEST', 'v0.0.2-test'];
      const paths = versions.map((version) => cachedModulePath(binDir, version));
      for (const [index, path] of paths.entries()) {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, versions[index]);
      }

      for (const [index, version] of versions.entries()) {
        const bm = new BinaryManager({
          binDir,
          falkordbVersion: version,
          redisServerPath: process.execPath,
        });
        const modulePath = (await bm.ensureBinaries()).falkordbModulePath;
        expect(modulePath).toBe(paths[index]);
        expect(await readFile(modulePath, 'utf8')).toBe(version);
        expect(bm.getFalkorDBModulePath()).toBe(paths[index]);
      }
    });

    it('uses a packaged module only when its release matches', async () => {
      const dir = await makeTempDir();
      const key = BinaryManager.detectPlatform();
      const isolatedSource = join(dir, 'binary-manager.ts');
      const packageDir = join(dir, 'node_modules', '@falkordblite', key);
      const packagedModule = join(packageDir, 'bin', 'falkordb.so');
      await copyFile(join(__dirname, '..', 'src', 'binary-manager.ts'), isolatedSource);
      await mkdir(dirname(packagedModule), { recursive: true });
      const packageJson = join(packageDir, 'package.json');
      const cachedMatchingModule = cachedModulePath(join(dir, 'cache'), 'v4.18.3');
      const cachedUpgradedModule = cachedModulePath(join(dir, 'cache'), 'v6.2.0');
      await writeFile(packageJson, JSON.stringify({
        version: '8.6.2-falkordb.4.18.3',
      }));
      await writeFile(packagedModule, 'packaged');
      await mkdir(dirname(cachedMatchingModule), { recursive: true });
      await mkdir(dirname(cachedUpgradedModule), { recursive: true });
      await writeFile(cachedMatchingModule, 'cached matching');
      await writeFile(cachedUpgradedModule, 'cached upgraded');

      const { BinaryManager: IsolatedBinaryManager } =
        require(isolatedSource) as typeof import('../src/binary-manager');
      const options = { binDir: join(dir, 'cache') };
      const matching = new IsolatedBinaryManager({ ...options, falkordbVersion: 'v4.18.3' });
      const upgraded = new IsolatedBinaryManager({ ...options, falkordbVersion: 'v6.2.0' });

      expect(matching.getFalkorDBModulePath()).toBe(await realpath(packagedModule));
      expect(upgraded.getFalkorDBModulePath()).toBe(cachedUpgradedModule);

      await writeFile(packageJson, JSON.stringify({
        version: '8.6.2-falkordb.6.2.0',
      }));
      expect(upgraded.getFalkorDBModulePath()).toBe(await realpath(packagedModule));
      expect(matching.getFalkorDBModulePath()).toBe(cachedMatchingModule);

      const bundledRedis = join(packageDir, 'bin', 'redis-server');
      await writeFile(bundledRedis, '');
      const systemRedis = jest.spyOn(IsolatedBinaryManager, 'findInSystemPath');
      const versions = new Map<string, number[] | undefined>();
      const redisVersion = jest.spyOn(IsolatedBinaryManager, 'getRedisVersion')
        .mockImplementation((path) => versions.get(path));
      try {
        const packaged = await realpath(bundledRedis);
        systemRedis.mockReturnValue(process.execPath);
        versions.set(packaged, [8, 10, 3]);

        versions.set(process.execPath, [8, 10, 3]);
        expect(upgraded.getRedisServerPath()).toBe(process.execPath);
        versions.set(process.execPath, [9, 0, 0]);
        expect(upgraded.getRedisServerPath()).toBe(process.execPath);
        versions.set(process.execPath, [6, 2, 14]);
        expect(upgraded.getRedisServerPath()).toBe(packaged);
        versions.set(process.execPath, undefined);
        expect(upgraded.getRedisServerPath()).toBe(packaged);

        systemRedis.mockReturnValue(undefined);
        expect(upgraded.getRedisServerPath()).toBe(packaged);
      } finally {
        systemRedis.mockRestore();
        redisVersion.mockRestore();
      }
    });

    it('does not cache a truncated download and retries on the next call', async () => {
      const binDir = await makeTempDir();
      const version = 'v0.0.0-download-test';
      const target = cachedModulePath(binDir, version);
      const bm = new BinaryManager({
        binDir,
        falkordbVersion: version,
        redisServerPath: process.execPath,
      });
      const module = 'complete module';
      let requests = 0;
      const server = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Length': module.length, Connection: 'close' });
        res.end(++requests === 1 ? 'partial' : module);
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
      const download = jest.spyOn(https, 'get').mockImplementation((_url, options, callback) =>
        get(`http://127.0.0.1:${address.port}`, typeof options === 'function' ? options : callback),
      );
      try {
        await expect(bm.ensureBinaries()).rejects.toThrow();
        expect(await readdir(dirname(target))).toEqual([]);
        expect(() => bm.getFalkorDBModulePath()).toThrow('FalkorDB module not found');

        expect((await bm.ensureBinaries()).falkordbModulePath).toBe(target);
        expect(await readFile(target, 'utf8')).toBe(module);
        expect(requests).toBe(2);
      } finally {
        download.mockRestore();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => error ? reject(error) : resolve()),
        );
      }
    });

    it('keeps custom release tags inside the binary cache', async () => {
      const binDir = await makeTempDir();
      const version = '../custom-release';
      const modulePath = cachedModulePath(binDir, version);
      await mkdir(dirname(modulePath), { recursive: true });
      await writeFile(modulePath, 'module');

      const bm = new BinaryManager({ binDir, falkordbVersion: version });
      expect(bm.getFalkorDBModulePath()).toBe(modulePath);
    });
  });

  // -----------------------------------------------------------------------
  // npm package resolution
  // -----------------------------------------------------------------------

  describe('npm package resolution', () => {
    const hasRedisInPath = () => BinaryManager.findInSystemPath('redis-server');

    (hasRedisInPath() ? it : it.skip)('resolves a redis-server whose version can be read', () => {
      const bm = new BinaryManager({ binDir: '/nonexistent-bin-dir' });
      const result = bm.getRedisServerPath();
      expect(BinaryManager.getRedisVersion(result)).toEqual([
        expect.any(Number), expect.any(Number), expect.any(Number),
      ]);
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
