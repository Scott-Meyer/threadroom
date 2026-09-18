# Threadroom service

A private, dependency-free Node 24+ package for the local Threadroom API and website. Neither process needs Pi, a checkout, or the other process to stay alive. They communicate through the existing HTTP API; nothing starts automatically.

## Pack and run

From the source checkout:

```sh
npm pack --workspace threadroom-service
```

`prepack` copies the current `src/` and `public/` into generated `dist/` resources. The tarball includes the CLI and those resources, not Pi, tests, examples, or a database. There is no separate backend implementation to maintain. The package is private: use the tarball, not a registry release.

Extract the tarball into a stable directory of your choice, then run its CLI with Node 24+ (replace `/absolute/install/package` below). Package-manager installation of the tarball also exposes the `threadroom-service` executable.

```sh
node /absolute/install/package/bin/threadroom-service.js api
# In another terminal:
node /absolute/install/package/bin/threadroom-service.js ui
```

The API listens at `http://127.0.0.1:4310`; the website at `http://127.0.0.1:4311`. Both run in the foreground from independent terminals. Stop with Ctrl-C; stopping Pi does not stop those terminals. Do not use Pi's background-task launcher for everyday hosting: Pi shutdown/reload terminates its owned tasks. The API starts empty, without demo records. The UI never opens a database. To run directly from this checkout, use `node packages/service/bin/threadroom-service.js` with the same commands. The recognized checkout CLI uses current source even after a previous pack; an extracted package uses only its bundled snapshot.

These are **local, unauthenticated loopback services**, not safe public endpoints. The CLI forces loopback binding even if `HOST` is set. Browser CORS checks are not authentication. Do not expose them through a public proxy or tunnel without a separate security design.

## Data and explicit endpoints

Default storage is stable across working directories:

- macOS: `~/Library/Application Support/Threadroom/threadroom.sqlite`
- Linux/other Unix: `$XDG_DATA_HOME/threadroom/threadroom.sqlite` when that variable is absolute, otherwise `~/.local/share/threadroom/threadroom.sqlite`
- Windows: `%LOCALAPPDATA%\Threadroom\threadroom.sqlite`, or `~/AppData/Local/Threadroom/threadroom.sqlite`

No existing checkout database is discovered, copied, or adopted. To select one intentionally:

```sh
node /absolute/install/package/bin/threadroom-service.js api \
  --database /absolute/data/threadroom.sqlite --port 4310
node /absolute/install/package/bin/threadroom-service.js ui \
  --api-url http://127.0.0.1:4310 --port 4311
```

`--database` requires an absolute path. Otherwise `THREADROOM_DB` is honored (a relative environment value is explicitly resolved against the invocation directory); without either, the per-user path above is used. New API directories/files have private permissions; existing directories are not chmodded. Back up the database with a SQLite-aware backup or while the API is stopped, retaining any WAL state.

Ports accept `0` for an OS-selected free port; the ready message reports the actual URL. `--port` overrides `PORT` for API or `UI_PORT` for UI. `--api-url` overrides `THREADROOM_API_URL`. No discovery, socket fallback, or server auto-start occurs. For nondefault UI ports, set `THREADROOM_UI_ORIGINS` on the API to comma-separated allowed browser origins. A port-0 UI origin cannot be known until it reports readiness; configure the API's origins accordingly. `--help` and `--version` do not start services.

## Optional macOS launchd configuration

Generating configuration is not installation or activation:

```sh
node /absolute/install/package/bin/threadroom-service.js launchd-config \
  --output-dir /absolute/review-directory \
  --database /absolute/data/threadroom.sqlite
```

This writes only `local.threadroom.api.plist` and `local.threadroom.ui.plist` in the requested directory, replacing those files if present. It never writes `~/Library/LaunchAgents`, calls `launchctl`, creates a database, or starts anything. `--api-port` and `--ui-port` select distinct, nonzero ports; `--api-url` optionally selects the UI's API endpoint. The API job receives the matching UI origins.

The two independent jobs use `KeepAlive`, an absolute Node executable and installed CLI path, an absolute database path, and a stable per-user working directory. Standard/error logs are `api.log`, `api.error.log`, `ui.log`, and `ui.error.log` in that working directory. Paths with spaces or XML characters are escaped, not shell-expanded. Keep the installed package and Node at those paths; regenerate configuration if either moves.

**Before any separately approved manual activation:** inspect the generated plists and ports, then prepare the printed working/log directory and database parent privately. For the default macOS path, the explicit preparation is:

```sh
mkdir -p "$HOME/Library/Application Support/Threadroom"
chmod 700 "$HOME/Library/Application Support/Threadroom"
# Prepare a different explicit database parent similarly, if selected.
```

Only after review/approval would you copy the plists to LaunchAgents and activate them using your usual launchd workflow. This package does not do that step, and generating files does not mean the service is installed, running, or configured in Pi. Running the foreground commands remains a complete alternative. Job logs may contain durable record paths and diagnostics; keep them private and manage retention yourself.
