import { tmpdir } from 'node:os';
import { ConfigGenerator, type ConfigGeneratorOptions } from '../src/config-generator';

// Minimal valid options for most tests.
const DEFAULTS: ConfigGeneratorOptions = {
  dbDir: '/tmp/test-db',
  falkordbModulePath: '/path/to/falkordb.so',
};

/** Parse a redis.conf string into a key→value map (last value wins). */
function parse(config: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of config.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(' ');
    if (idx === -1) continue;
    result[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
  }
  return result;
}

describe('ConfigGenerator', () => {
  it('generates valid config with all required defaults', () => {
    const gen = new ConfigGenerator(DEFAULTS);
    const parsed = parse(gen.generate());

    expect(parsed['port']).toBe('0');
    expect(parsed['bind']).toBe('127.0.0.1');
    expect(parsed['daemonize']).toBe('no');
    expect(parsed['unixsocketperm']).toBe('700');
    expect(parsed['loadmodule']).toBe('/path/to/falkordb.so');
    expect(parsed['dir']).toBe('/tmp/test-db');
    expect(parsed['dbfilename']).toBe('dump.rdb');
  });

  it('auto-generates a socket path in tmpdir when none provided', () => {
    const gen = new ConfigGenerator(DEFAULTS);
    const socketPath = gen.getSocketPath();

    expect(socketPath).toContain('falkordblite-');
    expect(socketPath).toContain('.sock');
    expect(socketPath.startsWith(tmpdir())).toBe(true);
  });

  it('uses a custom socket path when provided', () => {
    const custom = '/tmp/my-custom.sock';
    const gen = new ConfigGenerator({ ...DEFAULTS, unixSocketPath: custom });

    expect(gen.getSocketPath()).toBe(custom);

    const config = gen.generate();
    expect(config).toContain(`unixsocket ${custom}`);
  });

  it('sets port to 0 by default (no TCP)', () => {
    const parsed = parse(new ConfigGenerator(DEFAULTS).generate());
    expect(parsed['port']).toBe('0');
  });

  it('allows a custom port', () => {
    const parsed = parse(
      new ConfigGenerator({ ...DEFAULTS, port: 6380 }).generate(),
    );
    expect(parsed['port']).toBe('6380');
  });

  it('loads the FalkorDB module', () => {
    const config = new ConfigGenerator(DEFAULTS).generate();
    expect(config).toContain('loadmodule /path/to/falkordb.so');
  });

  it('sets custom persistence directory and filename', () => {
    const gen = new ConfigGenerator({
      ...DEFAULTS,
      dbDir: '/data/my-graph',
      dbFilename: 'graph.rdb',
    });
    const parsed = parse(gen.generate());

    expect(parsed['dir']).toBe('/data/my-graph');
    expect(parsed['dbfilename']).toBe('graph.rdb');
  });

  it('disables automatic snapshots by default', () => {
    const parsed = parse(new ConfigGenerator(DEFAULTS).generate());
    expect(parsed['save']).toBe('""');
  });

  it('sets maxmemory when provided', () => {
    const parsed = parse(
      new ConfigGenerator({ ...DEFAULTS, maxMemory: '512mb' }).generate(),
    );
    expect(parsed['maxmemory']).toBe('512mb');
  });

  it('omits maxmemory when not provided', () => {
    const config = new ConfigGenerator(DEFAULTS).generate();
    expect(config).not.toContain('maxmemory');
  });

  it('sets loglevel when provided', () => {
    const parsed = parse(
      new ConfigGenerator({ ...DEFAULTS, logLevel: 'debug' }).generate(),
    );
    expect(parsed['loglevel']).toBe('debug');
  });

  it('omits loglevel when not provided', () => {
    const config = new ConfigGenerator(DEFAULTS).generate();
    expect(config).not.toContain('loglevel');
  });

  it('includes additional config options', () => {
    const gen = new ConfigGenerator({
      ...DEFAULTS,
      additionalConfig: { hz: '100', timeout: '300' },
    });
    const parsed = parse(gen.generate());

    expect(parsed['hz']).toBe('100');
    expect(parsed['timeout']).toBe('300');
  });

  it('generates unique socket paths for different instances', () => {
    const gen1 = new ConfigGenerator(DEFAULTS);
    const gen2 = new ConfigGenerator(DEFAULTS);
    expect(gen1.getSocketPath()).not.toBe(gen2.getSocketPath());
  });

  it('ends with a newline', () => {
    const config = new ConfigGenerator(DEFAULTS).generate();
    expect(config.endsWith('\n')).toBe(true);
  });
});
