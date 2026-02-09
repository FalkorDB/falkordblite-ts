# Troubleshooting

## Binary not found

**redis-server not found**

The package now includes pre-built `redis-server` binaries for supported platforms
(Linux x64, macOS arm64). If the binary is not found:

- Ensure you're on a supported platform
- If using `--no-optional` during install, the platform-specific packages may not
  have been installed. Re-run `npm install` without that flag
- Install Redis on your system as a fallback:
  - Ubuntu/Debian: `sudo apt install redis-server`
  - macOS: `brew install redis`
- Or pass a custom path:
  ```ts
  const db = await FalkorDB.open({ redisServerPath: '/path/to/redis-server' });
  ```

**FalkorDB module not found**

The package now includes pre-built FalkorDB modules for supported platforms.
If the module is not found:

- Ensure you're on a supported platform
- If using `--no-optional` during install, the platform-specific packages may not
  have been installed. Re-run `npm install` without that flag
- As a fallback, the module will be downloaded from GitHub on first run
- Or pass a custom module path:
  ```ts
  const db = await FalkorDB.open({ modulePath: '/path/to/falkordb.so' });
  ```

## Download failures

- Check your network/proxy settings and retry `npm run postinstall`.
- Pin a specific module release via `falkordbVersion`.
- Download the module manually and pass `modulePath`.

## Permission errors (EACCES)

- Ensure the binaries are executable:
  ```bash
  chmod +x /path/to/redis-server /path/to/falkordb.so
  ```
- Confirm the data directory and temp directory are writable by your user.

## macOS libomp requirement

The FalkorDB module may require OpenMP. Install it via Homebrew:

```bash
brew install libomp
```

## Socket file permission issues

- The Unix socket uses permissions `700` by default.
- Remove stale socket files if needed (e.g., `/tmp/falkordblite-*.sock`).
- Ensure the process runs under the same user that owns the socket path.

## Port conflicts

By default, `falkordblite` disables TCP (`port 0`). If you enable a port via
`additionalConfig`, choose a free port and ensure firewall rules allow it.

## Windows / WSL

Embedded binaries are provided for Linux x64 and macOS arm64 only. On Windows:

- Use WSL2 and the Linux binaries, or
- Run a remote FalkorDB server and connect via the `falkordb` client.

## Tests hang or Jest warns about open handles

If Jest reports open handles, re-run with:

```bash
npm test -- --detectOpenHandles
```
