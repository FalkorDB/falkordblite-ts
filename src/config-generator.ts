import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

export interface ConfigGeneratorOptions {
  /** Path for the Unix domain socket. Auto-generated if not provided. */
  unixSocketPath?: string;
  /** Directory for RDB/AOF persistence files. */
  dbDir: string;
  /** RDB filename. Defaults to "dump.rdb". */
  dbFilename?: string;
  /** Absolute path to falkordb.so module. */
  falkordbModulePath: string;
  /** TCP port. Defaults to 0 (disabled). */
  port?: number;
  /** Memory limit, e.g. "256mb". */
  maxMemory?: string;
  /** Redis log level. */
  logLevel?: 'debug' | 'verbose' | 'notice' | 'warning';
  /** Log file path. Empty string means stdout. */
  logFile?: string;
  /** Extra redis.conf key-value pairs. */
  additionalConfig?: Record<string, string>;
}

export class ConfigGenerator {
  private readonly socketPath: string;
  private readonly options: ConfigGeneratorOptions;

  constructor(options: ConfigGeneratorOptions) {
    this.options = options;
    this.socketPath =
      options.unixSocketPath ?? ConfigGenerator.generateSocketPath(options.dbDir);
  }

  /** Generate a unique socket path inside the configured dbDir. */
  private static generateSocketPath(dbDir: string): string {
    const id = randomBytes(8).toString('hex');
    return join(dbDir, `falkordblite-${id}.sock`);
  }

  /** Return the Unix socket path this config will use. */
  getSocketPath(): string {
    return this.socketPath;
  }

  /** Generate the full redis.conf content. */
  generate(): string {
    const lines: string[] = [];

    const set = (key: string, value: string) => {
      lines.push(`${key} ${value}`);
    };

    // Unix socket
    set('unixsocket', this.socketPath);
    set('unixsocketperm', '700');

    // Disable TCP by default
    set('port', String(this.options.port ?? 0));
    set('bind', '127.0.0.1');

    // FalkorDB module
    set('loadmodule', this.options.falkordbModulePath);

    // Persistence
    set('dir', this.options.dbDir);
    set('dbfilename', this.options.dbFilename ?? 'dump.rdb');

    // Disable automatic snapshots by default
    set('save', '""');

    // Foreground mode
    set('daemonize', 'no');

    // Logging
    if (this.options.logLevel) {
      set('loglevel', this.options.logLevel);
    }
    set('logfile', this.options.logFile ?? '""');

    // Memory limit
    if (this.options.maxMemory) {
      set('maxmemory', this.options.maxMemory);
    }

    // User-provided overrides
    if (this.options.additionalConfig) {
      for (const [key, value] of Object.entries(
        this.options.additionalConfig,
      )) {
        set(key, value);
      }
    }

    return lines.join('\n') + '\n';
  }
}
