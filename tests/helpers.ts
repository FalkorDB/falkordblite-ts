import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BinaryManager, type BinaryPaths } from '../src/binary-manager';

// ---------------------------------------------------------------------------
// Binary paths (cached across all tests in a single worker)
// ---------------------------------------------------------------------------

let cachedPaths: BinaryPaths | undefined;

/**
 * Resolve redis-server and falkordb.so paths for tests.
 * Result is cached — first call may download the module, subsequent calls
 * are instant.
 */
export async function getTestBinaryPaths(): Promise<BinaryPaths> {
  if (cachedPaths) return cachedPaths;
  const bm = new BinaryManager();
  cachedPaths = await bm.ensureBinaries();
  return cachedPaths;
}

// ---------------------------------------------------------------------------
// Temp directories
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

/** Create a temp directory that will be removed by `cleanupAll()`. */
export async function makeTempDir(
  prefix = 'falkordblite-test-',
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Generic cleanup registry
// ---------------------------------------------------------------------------

const cleanupFns: Array<() => Promise<void>> = [];

/**
 * Register a cleanup function that runs during `cleanupAll()`.
 * Use this to ensure servers / DB instances are torn down even when a
 * test fails mid-way.
 */
export function onCleanup(fn: () => Promise<void>): void {
  cleanupFns.push(fn);
}

/**
 * Run all registered cleanup functions, then remove temp directories.
 * Call this in the top-level `afterAll` of every test file that creates
 * servers, DB instances, or temp directories.
 */
export async function cleanupAll(): Promise<void> {
  // Run registered cleanup functions (stop servers, close DBs, etc.)
  await Promise.allSettled(cleanupFns.map((fn) => fn()));
  cleanupFns.length = 0;

  // Remove temp directories
  await Promise.allSettled(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs.length = 0;
}

// ---------------------------------------------------------------------------
// Polling helper
// ---------------------------------------------------------------------------

/**
 * Poll `fn` until it returns true, or throw after `timeoutMs`.
 */
export async function waitFor(
  fn: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
