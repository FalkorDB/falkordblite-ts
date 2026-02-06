// ---------------------------------------------------------------------------
// Primary public API
// ---------------------------------------------------------------------------

export { FalkorDB } from './falkordb.js';
export type { FalkorDBLiteOptions } from './falkordb.js';

// ---------------------------------------------------------------------------
// Re-export commonly used types from falkordb-ts for convenience.
// Users can work with Graph, ConstraintType, EntityType without a
// separate `import` from the falkordb package.
// ---------------------------------------------------------------------------

export { Graph, ConstraintType, EntityType } from 'falkordb';

// ---------------------------------------------------------------------------
// Internal building blocks (advanced usage / testing)
// ---------------------------------------------------------------------------

export { ConfigGenerator } from './config-generator.js';
export type { ConfigGeneratorOptions } from './config-generator.js';

export { ServerManager } from './server-manager.js';
export type { ServerManagerOptions } from './server-manager.js';

export { BinaryManager, FALKORDB_VERSION } from './binary-manager.js';
export type {
  BinaryManagerOptions,
  BinaryPaths,
  SupportedPlatform,
} from './binary-manager.js';

export { registerServer, unregisterServer } from './cleanup.js';
