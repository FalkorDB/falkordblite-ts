import type { ServerManager } from './server-manager.js';

/** All live ServerManager instances that need cleanup on exit. */
const activeServers = new Set<ServerManager>();

let handlersRegistered = false;

/** Register a running server for automatic cleanup. */
export function registerServer(server: ServerManager): void {
  activeServers.add(server);
  ensureHandlers();
}

/** Unregister a server (e.g. after a clean stop). */
export function unregisterServer(server: ServerManager): void {
  activeServers.delete(server);
}

/** Synchronously stop all servers. Called from 'exit' handler. */
function stopAllSync(): void {
  for (const server of activeServers) {
    // In a synchronous exit handler we can only try to kill the process.
    // We cannot await async operations.
    const pid = server.getPid();
    if (pid !== undefined && server.isRunning()) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Process may already be gone.
      }
    }
  }
  activeServers.clear();
}

/** Gracefully stop all servers (async). Used in SIGINT/SIGTERM handlers. */
async function stopAllAsync(): Promise<void> {
  const servers = Array.from(activeServers);
  await Promise.allSettled(servers.map((s) => s.stop()));
  activeServers.clear();
}

function ensureHandlers(): void {
  if (handlersRegistered) return;
  handlersRegistered = true;

  // Synchronous last-resort cleanup when the process exits.
  process.on('exit', () => {
    stopAllSync();
  });

  // Graceful shutdown on signals.
  const signalHandler = async (signal: NodeJS.Signals) => {
    await stopAllAsync();
    // Re-raise the signal so the default handler can terminate the process.
    process.kill(process.pid, signal);
  };

  process.once('SIGINT', () => void signalHandler('SIGINT'));
  process.once('SIGTERM', () => void signalHandler('SIGTERM'));

  // Handle uncaught exceptions — attempt cleanup, then re-throw.
  process.on('uncaughtException', (err) => {
    stopAllSync();
    throw err;
  });
}
