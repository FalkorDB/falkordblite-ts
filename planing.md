# FalkorDBLite-TS: Project Plan

> Embedded FalkorDB for Node.js/TypeScript — the "SQLite moment" for graph databases in the JS ecosystem.

## Overview

**FalkorDBLite-TS** (`falkordblite-ts`) mirrors the Python [FalkorDBLite](https://github.com/falkordb/falkordblite) project, providing a zero-config embedded FalkorDB graph database for Node.js. It spawns a `redis-server` + `falkordb.so` sub-process, communicates over a Unix domain socket (or named pipe on Windows), and exposes the same API as [`falkordb-ts`](https://github.com/FalkorDB/falkordb-ts) so users can migrate to a remote server by changing a single line of code.

### Target User Experience

```typescript
// Embedded (falkordblite-ts) — no Docker, no ports, no config
import { FalkorDB } from 'falkordblite';

const db = await FalkorDB.open({ path: './my_graph.db' });
const graph = db.selectGraph('social');
await graph.query('CREATE (:Person {name:"Alice"})-[:KNOWS]->(:Person {name:"Bob"})');
const result = await graph.query('MATCH (p)-[:KNOWS]->(f) RETURN p.name, f.name');
console.log(result.data); // [['Alice', 'Bob']]
await db.close();

// Migration to production — change one line:
// import { FalkorDB } from 'falkordb';
// const db = await FalkorDB.connect({ socket: { host: 'localhost', port: 6379 }});
```

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│  User's Node.js Process                           │
│                                                    │
│  falkordblite-ts                                  │
│  ┌────────────────────────────────────────────┐   │
│  │ FalkorDB (public API)                      │   │
│  │   - open(opts) / close()                   │   │
│  │   - selectGraph(name) → Graph              │   │
│  │   - list() / info()                        │   │
│  ├────────────────────────────────────────────┤   │
│  │ ServerManager                              │   │
│  │   - spawn redis-server child process       │   │
│  │   - configure Unix socket / named pipe     │   │
│  │   - health checks & graceful shutdown      │   │
│  ├────────────────────────────────────────────┤   │
│  │ BinaryManager                              │   │
│  │   - locate/download redis-server binary    │   │
│  │   - locate/download falkordb.so module     │   │
│  │   - platform detection (linux/mac/win)     │   │
│  ├────────────────────────────────────────────┤   │
│  │ ConfigGenerator                            │   │
│  │   - generate redis.conf                    │   │
│  │   - Unix socket path, persistence, etc.    │   │
│  └────────────────────────────────────────────┘   │
│         │  Unix Domain Socket / Named Pipe        │
│         ▼                                          │
│  ┌────────────────────────────────────────────┐   │
│  │ redis-server (child process)               │   │
│  │   --loadmodule falkordb.so                 │   │
│  │   --unixsocket /tmp/falkordblite-XXXX.sock │   │
│  │   --port 0 (no TCP)                        │   │
│  └────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────┘
```

**Key design decisions:**
- The `FalkorDB` class wraps `falkordb-ts`'s `FalkorDB` internally, connecting it to the spawned local server.
- Communication is via Unix socket (no TCP ports exposed) — same approach as the Python version.
- The `Graph` object returned by `selectGraph()` is the actual `falkordb-ts` `Graph` — ensuring 100% API compatibility.

---

## Project Phases & Tasks for Claude Code

### Phase 1: Project Scaffolding

**Task 1.1 — Initialize the repository**
```
Create a new TypeScript project "falkordblite-ts" with:
- package.json (name: "falkordblite", main entry, types entry, engines: node >= 18)
- tsconfig.json (target: ES2022, module: NodeNext, strict: true, outDir: dist)
- .gitignore (node_modules, dist, *.sock, bin/)
- ESLint config (flat config, @typescript-eslint)
- Jest config for TypeScript (ts-jest)
- README.md with project description
- LICENSE (MIT or match FalkorDB's licensing)
```

**Task 1.2 — Define package dependencies**
```
Add dependencies:
  - falkordb (the falkordb-ts npm package) — peer + regular dependency
  - redis (the node-redis package, same version falkordb-ts uses)
  
Add devDependencies:
  - typescript, ts-jest, jest, @types/jest, @types/node
  - eslint, @typescript-eslint/*
  - rimraf (for clean builds)

Add scripts:
  - build, test, lint, clean, prepublishOnly
```

---

### Phase 2: Binary Management

**Task 2.1 — Create `src/binary-manager.ts`**
```
Implement a BinaryManager class that:

1. Defines supported platforms: { os: 'linux'|'darwin'|'win32', arch: 'x64'|'arm64' }
2. Has a method `ensureBinaries()` that:
   a. Checks if redis-server and falkordb.so already exist in the expected location
      (package's own bin/ directory OR a user-specified path)
   b. If not found, checks for system-installed redis-server (which redis-server)
   c. If no system redis-server, downloads pre-built binaries:
      - redis-server from a configurable URL/GitHub release
      - falkordb.so from FalkorDB GitHub releases
   d. Sets executable permissions (chmod +x)
3. Has getRedisServerPath(): string
4. Has getFalkorDBModulePath(): string
5. Binary paths should be resolved in this priority order:
   a. User-provided paths in options
   b. Package-local bin/ directory  
   c. System PATH

Platform-specific notes:
- Linux: redis-server + falkordb.so
- macOS: redis-server + falkordb.dylib (or .so), needs libomp
- Windows: redis-server.exe + falkordb.dll (via WSL or native)

For the MVP, focus on Linux x64 and macOS arm64/x64.
Create a postinstall script that runs ensureBinaries().
```

**Task 2.2 — Create `scripts/postinstall.ts`**
```
Create a postinstall script that:
1. Detects the current platform
2. Downloads the appropriate redis-server and falkordb.so binaries
3. Places them in the package's bin/ directory
4. Sets correct permissions
5. Verifies the binaries work (redis-server --version)
6. Prints a success message or clear error with troubleshooting steps

This script should be referenced in package.json "scripts.postinstall".
Handle network failures gracefully — if binaries can't be downloaded, 
print instructions for manual setup.
```

---

### Phase 3: Server Lifecycle Management

**Task 3.1 — Create `src/config-generator.ts`**
```
Implement a ConfigGenerator class that generates a redis.conf string:

Parameters:
- unixSocketPath: string (auto-generated temp path if not provided)
- dbDir: string (directory for RDB/AOF persistence)  
- dbFilename: string (default: "dump.rdb")
- falkordbModulePath: string
- port: number (default: 0 — disables TCP)
- maxMemory?: string (e.g., "256mb")
- logLevel?: 'debug'|'verbose'|'notice'|'warning'
- logFile?: string (default: "" — stdout)
- additionalConfig?: Record<string, string>

The generated config should:
- Set `unixsocket <path>` and `unixsocketperm 700`
- Set `port 0` (no TCP by default)
- Set `loadmodule <falkordb.so path>`
- Set `dir <dbDir>` for persistence
- Set `daemonize no`
- Set `save ""` by default (disable automatic snapshots) OR allow user config
- Set `bind 127.0.0.1` as fallback safety
- Include any additionalConfig key-value pairs

Method: generate(): string — returns the full redis.conf content
Method: getSocketPath(): string
```

**Task 3.2 — Create `src/server-manager.ts`**
```
Implement a ServerManager class that manages the redis-server child process:

Constructor options:
- redisServerPath: string
- config: string (the generated redis.conf content)
- configPath?: string (write config to this file, or use a temp file)

Methods:
- async start(): Promise<void>
  1. Write the config to a temp file
  2. Spawn redis-server as a child process using Node.js child_process.spawn()
  3. Pipe stdout/stderr for logging (configurable)
  4. Wait for the server to be ready by:
     a. Polling the Unix socket with a PING command
     b. Timeout after 10 seconds (configurable) with clear error
  5. Store the child process reference

- async stop(): Promise<void>
  1. Send SHUTDOWN NOSAVE command via the socket
  2. Wait for the child process to exit (with timeout)
  3. If process doesn't exit, send SIGTERM, then SIGKILL
  4. Clean up the temp config file
  5. Clean up the Unix socket file

- isRunning(): boolean
  Check if the child process is alive

- getPid(): number | undefined

Error handling:
- If redis-server fails to start, capture stderr and throw descriptive error
- Handle EADDRINUSE (socket already exists) — clean up stale sockets
- Register process.on('exit') handler to clean up on unexpected exit
- Register process.on('SIGINT') and process.on('SIGTERM') for graceful shutdown
```

**Task 3.3 — Process cleanup & safety**
```
Create `src/cleanup.ts`:

Implement global cleanup tracking:
1. Keep a Set<ServerManager> of all active server instances
2. Register a single process.on('exit') handler that stops all servers
3. Register process.on('SIGINT') and process.on('SIGTERM') handlers
4. Handle the case where the parent Node.js process crashes
5. On startup, detect and clean up stale socket files from previous runs

This ensures no orphaned redis-server processes are left running.
```

---

### Phase 4: Core FalkorDB Wrapper (API Layer)

**Task 4.1 — Create `src/falkordb.ts` — Main entry point**
```
Implement the FalkorDB class (this is the main public API):

import { FalkorDB as FalkorDBClient } from 'falkordb';

interface FalkorDBLiteOptions {
  path?: string;            // DB file path (like SQLite), default: in-memory
  redisServerPath?: string; // Custom redis-server binary path
  modulePath?: string;      // Custom falkordb.so path
  maxMemory?: string;       // e.g., "256mb"
  logLevel?: 'debug' | 'verbose' | 'notice' | 'warning';
  logFile?: string;
  timeout?: number;         // Server start timeout in ms
  additionalConfig?: Record<string, string>;
}

class FalkorDB {
  private serverManager: ServerManager;
  private client: FalkorDBClient;
  private options: FalkorDBLiteOptions;

  // Static factory method (matches falkordb-ts pattern)
  static async open(options?: FalkorDBLiteOptions): Promise<FalkorDB>;

  // Graph operations — delegate to internal falkordb-ts client
  selectGraph(graphId: string): Graph;  // Returns falkordb-ts Graph
  
  // Database operations
  async list(): Promise<string[]>;       // List all graphs
  async info(): Promise<object>;         // Server info
  async configGet(name: string): Promise<string>;
  async configSet(name: string, value: string): Promise<void>;
  
  // Lifecycle
  async close(): Promise<void>;          // Stop server + close connection
  
  // Getters
  get socketPath(): string;
  get pid(): number | undefined;
  get isRunning(): boolean;
}

Key implementation details:
1. open() should:
   a. Call BinaryManager.ensureBinaries()
   b. Generate config via ConfigGenerator
   c. Start server via ServerManager
   d. Connect falkordb-ts client to the Unix socket
   e. Return a ready-to-use FalkorDB instance

2. selectGraph() should return the EXACT Graph type from falkordb-ts
   so that query(), roQuery(), delete(), copy() etc. all work identically.

3. close() should:
   a. Close the falkordb-ts client connection
   b. Stop the redis-server process
   c. Clean up temp files

4. If path is provided, configure persistence (RDB) to that directory.
   If path is not provided, use a temp directory (ephemeral).
```

**Task 4.2 — Create `src/index.ts` — Package exports**
```
Create the main package entry point that re-exports:

export { FalkorDB } from './falkordb';
export type { FalkorDBLiteOptions } from './falkordb';

// Re-export commonly used types from falkordb-ts for convenience
export { Graph, QueryResult, Node, Edge, Path } from 'falkordb';
```

---

### Phase 5: Testing

**Task 5.1 — Unit tests for ConfigGenerator**
```
Create tests/config-generator.test.ts:
- Test default config generation
- Test custom socket path
- Test custom persistence directory
- Test additional config options
- Test that port is 0 by default
- Test that the module is loaded
```

**Task 5.2 — Unit tests for BinaryManager**
```
Create tests/binary-manager.test.ts:
- Test platform detection
- Test binary path resolution priority
- Test that ensureBinaries() finds system redis-server
- Mock download scenarios
```

**Task 5.3 — Integration tests for ServerManager**
```
Create tests/server-manager.test.ts:
(These require actual redis-server + falkordb.so binaries)
- Test server start and PING
- Test server stop and cleanup
- Test stale socket cleanup
- Test timeout on failed start
- Test multiple concurrent servers
```

**Task 5.4 — End-to-end tests**
```
Create tests/e2e.test.ts:
- Test full lifecycle: open → create graph → query → close
- Test graph CRUD operations (CREATE, MATCH, DELETE)
- Test multiple graphs in same database
- Test persistence (open → write → close → reopen → read)
- Test ephemeral mode (no path = temp directory)
- Test concurrent access from same process
- Test that the Graph API is identical to falkordb-ts
- Test error handling (bad queries, connection issues)

Test the "migration path":
- Write a test that works with falkordblite's FalkorDB
- Show that the same test works with falkordb-ts's FalkorDB  
  (connected to the embedded server) — proving API compatibility
```

**Task 5.5 — Create test fixtures and helpers**
```
Create tests/helpers.ts:
- Helper to get test binary paths
- Helper to create temp directories
- Helper to wait for conditions
- afterAll cleanup that kills any orphaned processes
```

---

### Phase 6: Build, Packaging & Distribution

**Task 6.1 — Build pipeline**
```
Configure the build:
1. TypeScript compilation → dist/
2. Generate .d.ts type declarations
3. Ensure bin/ directory with binaries is included in the package
4. Create a proper .npmignore (exclude tests, src, .github)
5. Verify package.json fields:
   - "main": "dist/index.js"
   - "types": "dist/index.d.ts"  
   - "files": ["dist", "bin", "scripts"]
   - "scripts.postinstall": "node scripts/postinstall.js"
```

**Task 6.2 — GitHub Actions CI**
```
Create .github/workflows/ci.yml:
- Run on: push to main, PRs
- Matrix: Node 18, 20, 22 × ubuntu-latest, macos-latest
- Steps:
  1. Checkout
  2. Setup Node.js
  3. Install dependencies (npm ci)
  4. Build (npm run build)
  5. Lint (npm run lint)
  6. Test (npm test)
  7. Upload coverage to Codecov
```

**Task 6.3 — GitHub Actions Publish**
```
Create .github/workflows/publish.yml:
- Trigger: GitHub release created
- Steps:
  1. Build
  2. Test
  3. Publish to npm
```

---

### Phase 7: Documentation & Examples

**Task 7.1 — README.md**
```
Write a comprehensive README with:
- Project description & badges
- Quick start (3-line example)
- Installation instructions
- Full API reference
- Configuration options table
- Migration guide (falkordblite → falkordb-ts)
- Platform support matrix
- Troubleshooting section
- Contributing guide link
```

**Task 7.2 — Examples directory**
```
Create examples/:
- basic.ts — minimal usage
- persistence.ts — data that survives restarts
- multiple-graphs.ts — working with multiple graphs
- migration.ts — showing the 1-line migration to remote server
- graphrag-example.ts — using with GraphRAG-SDK
```

**Task 7.3 — TROUBLESHOOTING.md**
```
Document common issues:
- Binary not found
- Permission errors
- macOS libomp requirement
- Socket file permission issues
- Port conflicts (shouldn't happen with port 0, but document anyway)
- WSL requirements for Windows
```

---

## Recommended Implementation Order for Claude Code

Feed these tasks to Claude Code in this sequence. Each task should be a separate prompt/session:

### Sprint 1: Foundation (Tasks 1.1 → 1.2 → 3.1 → 3.2 → 3.3)
Get the project scaffolded and the server lifecycle working. At the end of this sprint you should be able to spawn and stop a redis-server process.

### Sprint 2: Binaries (Tasks 2.1 → 2.2)
Get binary management working. After this sprint, `npm install` should automatically set up the required binaries.

### Sprint 3: Core API (Tasks 4.1 → 4.2)
Wire everything together into the public FalkorDB class. After this sprint the basic usage example should work end-to-end.

### Sprint 4: Testing (Tasks 5.5 → 5.1 → 5.2 → 5.3 → 5.4)
Build out the test suite. Start with helpers, then unit tests, then integration/e2e.

### Sprint 5: CI/CD & Packaging (Tasks 6.1 → 6.2 → 6.3)
Get the build and publish pipeline working.

### Sprint 6: Documentation (Tasks 7.1 → 7.2 → 7.3)
Polish the docs and examples.

---

## File Structure

```
falkordblite-ts/
├── src/
│   ├── index.ts                 # Package entry & re-exports
│   ├── falkordb.ts              # Main FalkorDB class (public API)
│   ├── server-manager.ts        # Redis server process lifecycle
│   ├── config-generator.ts      # Redis config generation
│   ├── binary-manager.ts        # Binary detection & download
│   ├── cleanup.ts               # Global process cleanup
│   └── types.ts                 # Shared TypeScript interfaces
├── scripts/
│   └── postinstall.ts           # npm postinstall binary setup
├── bin/                         # Pre-built binaries (gitignored, populated on install)
│   ├── linux-x64/
│   │   ├── redis-server
│   │   └── falkordb.so
│   ├── darwin-arm64/
│   │   ├── redis-server
│   │   └── falkordb.so
│   └── darwin-x64/
│       ├── redis-server
│       └── falkordb.so
├── tests/
│   ├── helpers.ts
│   ├── config-generator.test.ts
│   ├── binary-manager.test.ts
│   ├── server-manager.test.ts
│   └── e2e.test.ts
├── examples/
│   ├── basic.ts
│   ├── persistence.ts
│   ├── multiple-graphs.ts
│   └── migration.ts
├── .github/
│   └── workflows/
│       ├── ci.yml
│       └── publish.yml
├── package.json
├── tsconfig.json
├── jest.config.js
├── eslint.config.mjs
├── .gitignore
├── .npmignore
├── README.md
├── TROUBLESHOOTING.md
├── CONTRIBUTING.md
└── LICENSE
```

---

## Key Design Principles

1. **API parity with `falkordb-ts`** — The `Graph` object must be identical. Users change one import line to migrate.
2. **Zero config by default** — `FalkorDB.open()` with no arguments should just work (ephemeral in-memory graph).
3. **Sub-process isolation** — The redis-server runs as a child process, not embedded in the Node.js runtime. This matches the Python version's architecture.
4. **Unix socket communication** — No TCP ports exposed by default. No port conflicts.
5. **Clean shutdown** — Register exit handlers. Never leave orphaned redis-server processes.
6. **Platform support** — Linux x64 and macOS arm64/x64 as MVP. Windows via WSL as stretch goal.

---

## Notes for Claude Code Prompts

When giving each task to Claude Code, include:
- A reference to this plan document
- The specific task number and description
- Any files already created in previous tasks
- The target file path and expected exports
- Remind it to use `falkordb` npm package (the falkordb-ts client) as the underlying client
- Remind it that the `Graph` returned by `selectGraph()` must be the actual falkordb-ts `Graph` type
