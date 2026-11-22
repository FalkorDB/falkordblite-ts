# falkordblite

[![CI](https://github.com/FalkorDB/falkordblite-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/FalkorDB/falkordblite-ts/actions/workflows/ci.yml)
[![Coverage](https://codecov.io/gh/FalkorDB/falkordblite-ts/branch/main/graph/badge.svg)](https://codecov.io/gh/FalkorDB/falkordblite-ts)
[![npm version](https://img.shields.io/npm/v/falkordblite.svg)](https://www.npmjs.com/package/falkordblite)
[![license](https://img.shields.io/github/license/falkordb/falkordblite-ts.svg)](https://github.com/falkordb/falkordblite-py)
[![node](https://img.shields.io/node/v/falkordblite.svg)](package.json)

Embedded FalkorDB for Node.js/TypeScript. Zero-config graph database that runs
locally (redis-server + FalkorDB module) and connects over a Unix socket.

## Quick start

```ts
import { FalkorDB } from 'falkordblite';

const db = await FalkorDB.open();
await db.selectGraph('quickstart').query('RETURN 1');
await db.close();
```

## Installation

```bash
npm install falkordblite
```

The package prefers `redis-server` on your `PATH` over the pre-built Redis
binary in the platform package, so installing an older bundle does not replace
your system Redis. It uses a bundled FalkorDB module only when its release
matches the configured version; otherwise, it downloads the requested module.

The platform packages bundle Redis 8.10.3 and FalkorDB 6.2.0.

If you also want to connect to remote servers, install the upstream client:

```bash
npm install falkordb
```

## Examples

See the `examples/` directory:

- `basic.ts` - minimal usage
- `persistence.ts` - durable data with a path
- `multiple-graphs.ts` - isolated graphs in one DB
- `migration.ts` - 1-line change to remote
- `graphrag-example.ts` - use with GraphRAG tooling

## API reference

### `FalkorDB.open(options?)`

Create a new embedded FalkorDB instance. This resolves binaries, generates a
redis.conf, starts a local redis-server process, and connects a falkordb client.

Returns: `Promise<FalkorDB>`

### `FalkorDB` instance methods

- `selectGraph(graphId: string): Graph`
- `list(): Promise<string[]>`
- `info(section?: string): Promise<unknown>` (Redis INFO output)
- `configGet(configKey: string): Promise<unknown>`
- `configSet(configKey: string, value: number | string): Promise<void>`
- `close(): Promise<void>`

### `FalkorDB` getters

- `socketPath: string` - Unix socket path for the embedded server
- `pid: number | undefined` - redis-server PID
- `isRunning: boolean` - whether the server is still alive

### Graph API (from `falkordb`)

`selectGraph()` returns the exact `Graph` type from the `falkordb` package, so
all graph methods (query, roQuery, delete, copy, explain, profile, slowLog,
constraints, indexes, etc.) work the same. See the upstream client docs for
details.

### Advanced exports

The package also exports internal building blocks for advanced usage:

- `ConfigGenerator`, `ServerManager`, `BinaryManager`
- `registerServer`, `unregisterServer`

These are not required for normal usage but can help with custom embedding.

## Configuration options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `path` | `string` | temp dir | Data directory for persistence. If set, periodic snapshots are enabled. |
| `redisServerPath` | `string` | auto | Custom redis-server binary path. |
| `modulePath` | `string` | auto | Custom FalkorDB module (.so) path. |
| `maxMemory` | `string` | unset | Redis maxmemory, e.g. `"256mb"`. |
| `logLevel` | `'debug' \| 'verbose' \| 'notice' \| 'warning'` | unset | Redis log level. |
| `logFile` | `string` | stdout | Redis log file path. |
| `timeout` | `number` | `10000` | Startup timeout in milliseconds. |
| `additionalConfig` | `Record<string, string>` | none | Extra redis.conf key/value pairs. |
| `falkordbVersion` | `string` | `v6.2.0` | FalkorDB module release tag to download. |
| `inheritStdio` | `boolean` | `false` | Pipe redis-server stdout/stderr to the parent. |

Tip: use `additionalConfig` to set a TCP port (for external tools) by adding
`{ port: '6379' }`.

Downloaded modules are cached per release. A custom `modulePath` takes
precedence over `falkordbVersion`.

### Upgrading persisted data

Back up existing data before upgrading. FalkorDB 6.2 can read data saved by the
previous default, 4.18.3, but once 6.2 saves it, 4.18.3 cannot read it.
Graphs with CCH indexes must have those indexes removed, and data using RDB
encoding versions older than 19 must first be saved by a compatible 4.x release;
see the [upstream upgrade notes](https://github.com/FalkorDB/FalkorDB/releases/tag/v6.2.0#upgrade-notes).

## Migration guide (embedded -> remote)

Your graph code stays the same. Only the import and connection line changes:

```ts
// Embedded
import { FalkorDB } from 'falkordblite';
const db = await FalkorDB.open();

// Remote (falkordb-ts)
import { FalkorDB } from 'falkordb';
const db = await FalkorDB.connect({
  socket: { host: '127.0.0.1', port: 6379 },
});
```

## Platform support

| Platform | Status |
| --- | --- |
| Linux x64 | ✅ Fully supported (pre-built module available) |
| macOS arm64 | ✅ Fully supported (pre-built module available) |
| macOS x64 | Use system redis-server + custom module path |
| Windows | Use WSL2 or a remote server |

## Troubleshooting

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for common issues and fixes.

## Contributing

Contributions are welcome. Please open an issue for major changes, and ensure
`npm run lint && npm test && npm run build` passes before submitting a PR.

## License

This package is MIT licensed; see [LICENSE](LICENSE). The FalkorDB module is
separately licensed under SSPLv1 or AGPLv3.
