import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ServerManager } from '../src/server-manager';
import { ConfigGenerator } from '../src/config-generator';
import {
  getTestBinaryPaths,
  makeTempDir,
  onCleanup,
  cleanupAll,
} from './helpers';

jest.setTimeout(30_000);

let redisServerPath: string;
let falkordbModulePath: string;

beforeAll(async () => {
  const paths = await getTestBinaryPaths();
  redisServerPath = paths.redisServerPath;
  falkordbModulePath = paths.falkordbModulePath;
});

afterAll(async () => {
  await cleanupAll();
});

/** Create a config + socketPath for a fresh server in the given dbDir. */
function makeConfig(dbDir: string) {
  const gen = new ConfigGenerator({ dbDir, falkordbModulePath });
  return { config: gen.generate(), socketPath: gen.getSocketPath() };
}

describe('ServerManager', () => {
  // -----------------------------------------------------------------------
  // Start and stop
  // -----------------------------------------------------------------------

  describe('start and stop', () => {
    it('starts a server that reports isRunning and has a PID', async () => {
      const dbDir = await makeTempDir();
      const { config, socketPath } = makeConfig(dbDir);

      const server = new ServerManager({ redisServerPath, config, socketPath });
      onCleanup(() => server.stop());

      await server.start();

      expect(server.isRunning()).toBe(true);
      expect(server.getPid()).toBeDefined();
      expect(typeof server.getPid()).toBe('number');
      expect(server.socketPath).toBe(socketPath);

      await server.stop();

      expect(server.isRunning()).toBe(false);
    });

    it('cleans up the socket file after stop', async () => {
      const dbDir = await makeTempDir();
      const { config, socketPath } = makeConfig(dbDir);

      const server = new ServerManager({ redisServerPath, config, socketPath });
      onCleanup(() => server.stop());

      await server.start();
      expect(existsSync(socketPath)).toBe(true);

      await server.stop();
      expect(existsSync(socketPath)).toBe(false);
    });

    it('stop is idempotent — calling twice does not throw', async () => {
      const dbDir = await makeTempDir();
      const { config, socketPath } = makeConfig(dbDir);

      const server = new ServerManager({ redisServerPath, config, socketPath });
      onCleanup(() => server.stop());

      await server.start();
      await server.stop();
      await expect(server.stop()).resolves.toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Stale socket cleanup
  // -----------------------------------------------------------------------

  describe('stale socket cleanup', () => {
    it('removes a stale socket file before starting', async () => {
      const dbDir = await makeTempDir();
      const { config, socketPath } = makeConfig(dbDir);

      // Plant a stale file at the socket path.
      await writeFile(socketPath, 'stale');
      expect(existsSync(socketPath)).toBe(true);

      const server = new ServerManager({ redisServerPath, config, socketPath });
      onCleanup(() => server.stop());

      await server.start();
      expect(server.isRunning()).toBe(true);

      await server.stop();
    });
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  describe('error handling', () => {
    it('throws when redis-server binary does not exist', async () => {
      const dbDir = await makeTempDir();
      const { config, socketPath } = makeConfig(dbDir);

      const server = new ServerManager({
        redisServerPath: '/nonexistent/redis-server',
        config,
        socketPath,
        startupTimeoutMs: 3_000,
      });

      await expect(server.start()).rejects.toThrow('Failed to spawn');
    });

    it('throws when the loaded module does not exist', async () => {
      const dbDir = await makeTempDir();
      const socketPath = join(dbDir, 'test.sock');

      // Build a config that references a nonexistent module.
      const badConfig = [
        `unixsocket ${socketPath}`,
        'unixsocketperm 700',
        'port 0',
        'bind 127.0.0.1',
        'loadmodule /nonexistent/falkordb.so',
        `dir ${dbDir}`,
        'daemonize no',
      ].join('\n');

      const server = new ServerManager({
        redisServerPath,
        config: badConfig,
        socketPath,
        startupTimeoutMs: 5_000,
      });

      await expect(server.start()).rejects.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Multiple concurrent servers
  // -----------------------------------------------------------------------

  describe('multiple concurrent servers', () => {
    it('runs two servers at the same time on different sockets', async () => {
      const dbDir1 = await makeTempDir();
      const dbDir2 = await makeTempDir();
      const cfg1 = makeConfig(dbDir1);
      const cfg2 = makeConfig(dbDir2);

      const server1 = new ServerManager({
        redisServerPath,
        config: cfg1.config,
        socketPath: cfg1.socketPath,
      });
      const server2 = new ServerManager({
        redisServerPath,
        config: cfg2.config,
        socketPath: cfg2.socketPath,
      });
      onCleanup(() => server1.stop());
      onCleanup(() => server2.stop());

      await Promise.all([server1.start(), server2.start()]);

      expect(server1.isRunning()).toBe(true);
      expect(server2.isRunning()).toBe(true);
      expect(server1.getPid()).not.toBe(server2.getPid());
      expect(server1.socketPath).not.toBe(server2.socketPath);

      await Promise.all([server1.stop(), server2.stop()]);

      expect(server1.isRunning()).toBe(false);
      expect(server2.isRunning()).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // SHUTDOWN SAVE
  // -----------------------------------------------------------------------

  describe('save on shutdown', () => {
    it('stops cleanly with save=true', async () => {
      const dbDir = await makeTempDir();
      const { config, socketPath } = makeConfig(dbDir);

      const server = new ServerManager({ redisServerPath, config, socketPath });
      onCleanup(() => server.stop());

      await server.start();
      await server.stop(true); // SHUTDOWN SAVE

      expect(server.isRunning()).toBe(false);
    });
  });
});
