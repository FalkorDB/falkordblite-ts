import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FalkorDB as FalkorDBClient } from 'falkordb';
import type { Graph } from 'falkordb';
import { BinaryManager } from './binary-manager.js';
import { ConfigGenerator } from './config-generator.js';
import { ServerManager } from './server-manager.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface FalkorDBLiteOptions {
  /** Database directory for persistence (like SQLite's file path).
   *  If omitted, uses a temp directory — data is ephemeral. */
  path?: string;
  /** Custom redis-server binary path. */
  redisServerPath?: string;
  /** Custom FalkorDB module (.so) path. */
  modulePath?: string;
  /** Memory limit, e.g. "256mb". */
  maxMemory?: string;
  /** Redis log level. */
  logLevel?: 'debug' | 'verbose' | 'notice' | 'warning';
  /** Log file path. */
  logFile?: string;
  /** Server startup timeout in ms. Defaults to 10 000. */
  timeout?: number;
  /** Extra redis.conf key-value pairs. */
  additionalConfig?: Record<string, string>;
  /** FalkorDB release version tag (e.g. "v4.16.3"). */
  falkordbVersion?: string;
  /** If true, pipe redis-server stdout/stderr to parent process. */
  inheritStdio?: boolean;
}

// ---------------------------------------------------------------------------
// FalkorDB — public API
// ---------------------------------------------------------------------------

export class FalkorDB {
  private readonly server: ServerManager;
  private readonly client: FalkorDBClient;
  private readonly dbDir: string;
  private readonly ownsTempDir: boolean;

  private constructor(
    server: ServerManager,
    client: FalkorDBClient,
    dbDir: string,
    ownsTempDir: boolean,
  ) {
    this.server = server;
    this.client = client;
    this.dbDir = dbDir;
    this.ownsTempDir = ownsTempDir;
  }

  // -----------------------------------------------------------------------
  // Factory
  // -----------------------------------------------------------------------

  /**
   * Open an embedded FalkorDB instance.
   *
   * Orchestrates binary resolution, config generation, server startup,
   * and client connection in one call.
   *
   * - If `options.path` is provided, data persists to that directory.
   * - If omitted, an ephemeral in-memory graph is used (temp dir, no saves).
   */
  static async open(options?: FalkorDBLiteOptions): Promise<FalkorDB> {
    const opts = options ?? {};

    // 1. Resolve binaries (downloads FalkorDB module if needed)
    const bm = new BinaryManager({
      redisServerPath: opts.redisServerPath,
      falkordbModulePath: opts.modulePath,
      falkordbVersion: opts.falkordbVersion,
    });
    const bins = await bm.ensureBinaries();

    // 2. Resolve data directory
    let dbDir: string;
    let ownsTempDir: boolean;

    if (opts.path) {
      dbDir = resolve(opts.path);
      await mkdir(dbDir, { recursive: true });
      ownsTempDir = false;
    } else {
      dbDir = await mkdtemp(join(tmpdir(), 'falkordblite-data-'));
      ownsTempDir = true;
    }

    // 3. Generate redis.conf
    const additionalConfig: Record<string, string> = {
      ...opts.additionalConfig,
    };

    // Enable periodic RDB snapshots when persistence is requested.
    // The default config has `save ""` (disabled). Placing this in
    // additionalConfig appends a new save rule after the `save ""` line,
    // which Redis processes sequentially: clear → add rule.
    if (opts.path) {
      additionalConfig['save'] ??= '60 1';
    }

    const configGen = new ConfigGenerator({
      falkordbModulePath: bins.falkordbModulePath,
      dbDir,
      maxMemory: opts.maxMemory,
      logLevel: opts.logLevel,
      logFile: opts.logFile,
      additionalConfig: Object.keys(additionalConfig).length > 0
        ? additionalConfig
        : undefined,
    });

    const config = configGen.generate();
    const socketPath = configGen.getSocketPath();

    // 4. Start the redis-server child process
    const server = new ServerManager({
      redisServerPath: bins.redisServerPath,
      config,
      socketPath,
      startupTimeoutMs: opts.timeout,
      inheritStdio: opts.inheritStdio,
    });

    await server.start();

    // 5. Connect the falkordb-ts client via the Unix socket
    let client: FalkorDBClient;
    try {
      client = await FalkorDBClient.connect({
        socket: { path: socketPath },
      });
    } catch (err) {
      // If client connection fails, tear down the server we just started.
      await server.stop();
      if (ownsTempDir) {
        await rm(dbDir, { recursive: true, force: true }).catch(() => {});
      }
      throw err;
    }

    return new FalkorDB(server, client, dbDir, ownsTempDir);
  }

  // -----------------------------------------------------------------------
  // Graph operations
  // -----------------------------------------------------------------------

  /**
   * Select a graph by name.
   *
   * Returns the **exact `Graph` type** from the `falkordb` npm package,
   * so `query()`, `roQuery()`, `delete()`, `copy()`, index operations,
   * etc. all work identically to `falkordb-ts`.
   */
  selectGraph(graphId: string): Graph {
    return this.client.selectGraph(graphId);
  }

  // -----------------------------------------------------------------------
  // Database operations (delegated to falkordb-ts client)
  // -----------------------------------------------------------------------

  /** List all graph names in this database. */
  list(): Promise<string[]> {
    return this.client.list();
  }

  /** Get server info (Redis INFO output). */
  info(section?: string) {
    return this.client.info(section);
  }

  /** Get a FalkorDB module configuration value. */
  configGet(configKey: string) {
    return this.client.configGet(configKey);
  }

  /** Set a FalkorDB module configuration value. */
  configSet(configKey: string, value: number | string): Promise<void> {
    return this.client.configSet(configKey, value);
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Close the client connection and stop the embedded server.
   *
   * If the instance was opened without a `path` (ephemeral mode),
   * the temporary data directory is also removed.
   */
  async close(): Promise<void> {
    // 1. Close the falkordb-ts client connection
    try {
      await this.client.close();
    } catch {
      // Client may already be disconnected.
    }

    // 2. Stop the redis-server process (save RDB if persistent)
    await this.server.stop(!this.ownsTempDir);

    // 3. Clean up temp data directory (ephemeral mode only)
    if (this.ownsTempDir) {
      await rm(this.dbDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // -----------------------------------------------------------------------
  // Getters
  // -----------------------------------------------------------------------

  /** The Unix socket path the embedded server is listening on. */
  get socketPath(): string {
    return this.server.socketPath;
  }

  /** PID of the embedded redis-server child process. */
  get pid(): number | undefined {
    return this.server.getPid();
  }

  /** Whether the embedded redis-server is still running. */
  get isRunning(): boolean {
    return this.server.isRunning();
  }
}
