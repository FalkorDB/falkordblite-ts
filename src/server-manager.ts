import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile, unlink, mkdtemp } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { registerServer, unregisterServer } from './cleanup.js';

export interface ServerManagerOptions {
  /** Absolute path to the redis-server binary. */
  redisServerPath: string;
  /** Generated redis.conf content. */
  config: string;
  /** Path to the Unix socket (must match the config). */
  socketPath: string;
  /** Path to write the config file. Uses a temp file if not provided. */
  configPath?: string;
  /** Startup timeout in milliseconds. Defaults to 10 000. */
  startupTimeoutMs?: number;
  /** Interval between PING polls in milliseconds. Defaults to 100. */
  pollIntervalMs?: number;
  /** If true, pipe redis-server stdout/stderr to the parent process. */
  inheritStdio?: boolean;
}

export class ServerManager {
  private process: ChildProcess | undefined;
  private configFilePath: string | undefined;
  private ownsConfigFile = false;
  private readonly options: ServerManagerOptions;

  constructor(options: ServerManagerOptions) {
    this.options = options;
  }

  /** Start the redis-server child process and wait until it's ready. */
  async start(): Promise<void> {
    // Clean up a stale socket from a previous run if it exists.
    if (existsSync(this.options.socketPath)) {
      await unlink(this.options.socketPath);
    }

    // Write config to file.
    if (this.options.configPath) {
      this.configFilePath = this.options.configPath;
      await writeFile(this.configFilePath, this.options.config, 'utf-8');
      this.ownsConfigFile = false;
    } else {
      const tmpDir = await mkdtemp(join(tmpdir(), 'falkordblite-'));
      this.configFilePath = join(tmpDir, 'redis.conf');
      await writeFile(this.configFilePath, this.options.config, 'utf-8');
      this.ownsConfigFile = true;
    }

    // Spawn redis-server.
    const child = spawn(this.options.redisServerPath, [this.configFilePath], {
      stdio: this.options.inheritStdio
        ? 'inherit'
        : ['ignore', 'pipe', 'pipe'],
    });

    this.process = child;

    // Collect stderr for error reporting.
    let stderr = '';
    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
    }

    // Handle early exit (binary not found, bad config, etc.).
    const earlyExit = new Promise<never>((_, reject) => {
      child.on('error', (err) => {
        reject(
          new Error(`Failed to spawn redis-server: ${err.message}`),
        );
      });
      child.on('exit', (code, signal) => {
        if (code !== null && code !== 0) {
          reject(
            new Error(
              `redis-server exited with code ${code} before becoming ready.\nstderr: ${stderr}`,
            ),
          );
        } else if (signal) {
          reject(
            new Error(
              `redis-server was killed by signal ${signal} before becoming ready.`,
            ),
          );
        }
      });
    });

    // Poll the Unix socket until we get a PONG.
    const timeoutMs = this.options.startupTimeoutMs ?? 10_000;
    const pollMs = this.options.pollIntervalMs ?? 100;

    const ready = this.waitForReady(timeoutMs, pollMs);

    try {
      await Promise.race([ready, earlyExit]);
    } catch (err) {
      // Ensure the process is killed if startup failed.
      this.killProcess();
      await this.cleanupFiles();
      throw err;
    }

    // Register with global cleanup.
    registerServer(this);
  }

  /**
   * Stop the redis-server gracefully, falling back to SIGTERM/SIGKILL.
   * @param save If true, persist data to disk before shutting down (SHUTDOWN SAVE).
   */
  async stop(save = false): Promise<void> {
    if (!this.process || this.process.exitCode !== null) {
      await this.cleanupFiles();
      unregisterServer(this);
      return;
    }

    // Try SHUTDOWN via the socket.
    try {
      await this.sendCommand('SHUTDOWN', save ? 'SAVE' : 'NOSAVE');
    } catch {
      // Command may fail if server is already shutting down — that's fine.
    }

    // Wait for the process to exit.
    const exited = await this.waitForExit(5_000);

    if (!exited) {
      // Escalate: SIGTERM.
      this.process.kill('SIGTERM');
      const exitedAfterTerm = await this.waitForExit(3_000);

      if (!exitedAfterTerm) {
        // Last resort: SIGKILL.
        this.process.kill('SIGKILL');
        await this.waitForExit(2_000);
      }
    }

    await this.cleanupFiles();
    unregisterServer(this);
  }

  /** Check whether the child process is still alive. */
  isRunning(): boolean {
    return this.process !== undefined && this.process.exitCode === null;
  }

  /** Return the PID of the child process, if running. */
  getPid(): number | undefined {
    return this.process?.pid;
  }

  /** The Unix socket path this server is listening on. */
  get socketPath(): string {
    return this.options.socketPath;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Poll the Unix socket with Redis PING commands until we get PONG
   * or the timeout expires.
   */
  private waitForReady(timeoutMs: number, pollMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;

      const attempt = () => {
        if (Date.now() > deadline) {
          reject(
            new Error(
              `redis-server did not become ready within ${timeoutMs}ms`,
            ),
          );
          return;
        }

        this.ping()
          .then(() => resolve())
          .catch(() => {
            setTimeout(attempt, pollMs);
          });
      };

      attempt();
    });
  }

  /** Send a Redis PING over the Unix socket and resolve if we get +PONG. */
  private ping(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.options.socketPath);
      let responded = false;

      socket.setTimeout(1_000);

      socket.on('connect', () => {
        // RESP: *1\r\n$4\r\nPING\r\n
        socket.write('*1\r\n$4\r\nPING\r\n');
      });

      socket.on('data', (data) => {
        const response = data.toString();
        if (response.includes('+PONG')) {
          responded = true;
          socket.destroy();
          resolve();
        }
      });

      socket.on('error', (err) => {
        if (!responded) {
          socket.destroy();
          reject(err);
        }
      });

      socket.on('timeout', () => {
        if (!responded) {
          socket.destroy();
          reject(new Error('PING timed out'));
        }
      });
    });
  }

  /**
   * Send an arbitrary Redis command over the Unix socket.
   * Used for SHUTDOWN NOSAVE.
   */
  private sendCommand(...args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.options.socketPath);

      socket.setTimeout(3_000);

      socket.on('connect', () => {
        // Encode as RESP array.
        const parts = [`*${args.length}\r\n`];
        for (const arg of args) {
          parts.push(`$${Buffer.byteLength(arg)}\r\n${arg}\r\n`);
        }
        socket.write(parts.join(''));
      });

      let buf = '';
      socket.on('data', (data) => {
        buf += data.toString();
        socket.destroy();
        resolve(buf);
      });

      socket.on('error', (err) => {
        socket.destroy();
        reject(err);
      });

      socket.on('timeout', () => {
        socket.destroy();
        reject(new Error('Command timed out'));
      });

      // The server may close the connection on SHUTDOWN.
      socket.on('close', () => {
        resolve(buf);
      });
    });
  }

  /** Wait for the child process to exit, with a timeout. */
  private waitForExit(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.process || this.process.exitCode !== null) {
        resolve(true);
        return;
      }

      const timer = setTimeout(() => {
        resolve(false);
      }, timeoutMs);

      this.process.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /** Force-kill the child process without waiting. */
  private killProcess(): void {
    if (this.process && this.process.exitCode === null) {
      this.process.kill('SIGKILL');
    }
  }

  /** Remove the config file and socket file. */
  private async cleanupFiles(): Promise<void> {
    if (this.configFilePath && this.ownsConfigFile) {
      try {
        await unlink(this.configFilePath);
      } catch {
        // Already gone — fine.
      }
    }

    try {
      await unlink(this.options.socketPath);
    } catch {
      // Already gone — fine.
    }
  }
}
