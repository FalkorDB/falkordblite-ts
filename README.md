# falkordblite

[![CI](https://github.com/FalkorDB/falkordblite-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/FalkorDB/falkordblite-ts/actions/workflows/ci.yml)
[![Coverage](https://codecov.io/gh/FalkorDB/falkordblite-ts/branch/main/graph/badge.svg)](https://codecov.io/gh/FalkorDB/falkordblite-ts)
[![npm version](https://img.shields.io/npm/v/falkordblite.svg)](https://www.npmjs.com/package/falkordblite)
[![license](https://img.shields.io/github/license/falkordb/falkordblite-ts.svg)](https://github.com/FalkorDB/falkordblite-ts/blob/main/LICENSE)
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

The package uses the newer of `redis-server` on your `PATH` and the pre-built
Redis binary in the platform package (the system binary wins ties), so an
older system Redis does not block the module and an older bundle does not
replace a newer system Redis. It uses a bundled FalkorDB module only when its
release matches the configured version; otherwise, it downloads the requested
module.

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

When changing the bundled Redis or FalkorDB version, run
`packages/update-license-files.sh <redis_version> <falkordb_version>` (requires
Redis >= 8.0.0, FalkorDB >= v6.2.0, Python >= 3.9, and Cargo >= 1.85.0, the
minimum tested for the edition-2024 manifests) and update
`LICENSE`, `NOTICE`, and this README in the same PR. When the macOS asset's
toolchain changes, also set `MACOS_LLVM_VERSION` and `MACOS_OPENSSL_VERSION`;
when the Linux asset's toolchain changes, set `LINUX_LLVM_VERSION`. Use the
versions recorded by the respective builds and regenerate the platform notices.
The publish workflow rejects unmapped FalkorDB release/asset pairs; update its
reviewed toolchain mapping when moving to another asset.
If the asset's Rust toolchain changes, also update `rust_license_source_ref` in
`packages/update-license-files.sh` before regenerating notices; it pins the
Rust standard-library license and attribution sources.

## License

falkordblite consists of components under different licenses. Where a
component is offered under more than one license, you choose the license that
applies to your use.

| Component | Where it comes from | License |
| --- | --- | --- |
| falkordblite wrapper (this package) | `falkordblite` | MIT — see [LICENSE](LICENSE) |
| Redis server (`redis-server`) | bundled in `@falkordblite/linux-x64` / `@falkordblite/darwin-arm64` | RSALv2, SSPLv1 or AGPLv3 (licensee's choice) — [full texts](https://github.com/redis/redis/blob/8.10.3/LICENSE.txt) |
| FalkorDB module (`falkordb.so`, v6.2.0+) | bundled in the platform packages, or downloaded by `postinstall` | SSPLv1 or AGPLv3 (licensee's choice) — [LICENSE](https://github.com/FalkorDB/FalkorDB/blob/v6.2.0/LICENSE), [SSPL](https://github.com/FalkorDB/FalkorDB/blob/v6.2.0/LICENSE-SSPL), [AGPL](https://github.com/FalkorDB/FalkorDB/blob/v6.2.0/LICENSE-AGPL) |

The `falkordblite` package itself contains no Redis or FalkorDB binaries; it
runs `redis-server` as a separate process and talks to it over a socket. Each
platform package ships the full license texts, a `NOTICE` listing the exact
bundled versions and source locations, and `THIRD-PARTY-NOTICES.txt` with
notices for embedded dependencies. See also [NOTICE](NOTICE). A
`redis-server` found on your `PATH` is governed by the license under which you
obtained it.
