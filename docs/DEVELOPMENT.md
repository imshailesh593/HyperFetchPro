# Development guide

## Prerequisites

- Node.js 22+ (24 recommended). The store uses the built-in `node:sqlite`.
- .NET 9 SDK and the Windows 10 SDK (10.0.19041+) for the WinUI app.
- Git. No Rust, Python or Visual Studio IDE needed (VS Build Tools are enough).

## Layout

| Path | What | Tests |
|---|---|---|
| `packages/engine` | `Downloader`, `probe`, `Throttle` | 8, local range server |
| `packages/store` | `Store` (SQLite, migrations, repositories) | 4 |
| `packages/scheduler` | `DownloadManager`, `Scheduler` | 10, fake downloader + one real HTTP run |
| `packages/media` | yt-dlp/ffmpeg discovery, install, `simplify`, `MediaDownloader` | 9, fake yt-dlp script |
| `apps/core-host` | `Api`, stdio host, local IPC server | 14 |
| `apps/native-host` | browser native-messaging relay | covered by an end-to-end script |
| `apps/extension` | MV3 extension (plain JS, no build step) | manual |
| `apps/windows/DownloadManager` | WinUI 3 app | manual / screenshot |

Dependency rule: UIs depend only on the [protocol](PROTOCOL.md). Packages never import UI code. `engine` knows nothing about the database.

## Commands

```powershell
npm install
npm test                                       # all workspaces that define a test script
npm run build --workspace @dm/core-host        # bundle host.mjs (esbuild; @dm/* aliased to source)
npm run build --workspace @dm/native-host      # bundle native-host.cjs
# type-check one package
cd packages\engine; npx tsc -p tsconfig.json --noEmit
# WinUI app
cd apps\windows\DownloadManager
dotnet build -c Debug -p:Platform=x64
```

The app locates the core in this order: `DM_CORE_HOST`, `<exe folder>\core\host.mjs`, then a search upward for `apps\core-host\dist\host.mjs` (works from the build output during development).

## Conventions

- TypeScript, ES modules, strict mode. Tests use Vitest; packages that use pipes or child processes set `pool: 'forks'`.
- Packages are consumed from source through path aliases (`tsconfig.json`, `vitest.config.ts`, esbuild `--alias`). Add a new `@dm/*` package to all three places in every consumer.
- Database changes are **append-only migrations** in `packages/store/src/store.ts` (`MIGRATIONS`); never edit an existing entry.
- Call Windows tools by full path when a same-named tool may exist on PATH (Git for Windows' GNU `tar` breaks on `C:` paths; the code uses `%SystemRoot%\System32	ar.exe`).
- Do not spawn processes with shell strings; pass argument arrays. Links given to yt-dlp go after `--`.
- Engine behaviour is verified against a local HTTP server (ranges, flaky connections, 404, throttling). Add a test there first when changing it.

## Adding a protocol method

1. Add a `case` in `Api.handle` (`apps/core-host/src/api.ts`) with parameter checks.
2. Add a test in `apps/core-host/test`.
3. Document it in [PROTOCOL.md](PROTOCOL.md).
4. Add a call in the UI's view-model.

## WinUI build quirks (found the hard way)

- Set `<EnableMsixTooling>true</EnableMsixTooling>`; otherwise PRI generation fails with a missing Visual Studio task.
- `XamlCompiler.exe` exits with code 1 and **no message** if a `<Style.Resources>` block is present. Put resource overrides on the control (`Button.Resources`).
- Custom controls need a real parameterless constructor (no optional parameters).
- A `Style` `Background` setter beats the theme `ButtonBackground*` resource overrides; set the brush in the style as well.
- Events such as `SelectionChanged` (from `SelectedIndex`) and `Slider.ValueChanged` (range coercion) fire during `InitializeComponent`, before later fields exist. Null-guard handlers.
- A startup crash shows only exit code `0xC000027B`; `App.xaml.cs` writes the real exception to `%LOCALAPPDATA%\DownloadManager\crash.log`.
- Window UI Automation needs `AutomationProperties.Name` on buttons for scripted tests.
- Ambiguity: `DispatcherQueue` exists in both `Microsoft.UI.Dispatching` and `Windows.System`; avoid `using Windows.System;`.

## Trying the UI with a slow server

A throttled range-capable server makes progress visible. Any server that honours `Range` works; point `DM_DATA_DIR` at a scratch folder so your real data is untouched:

```powershell
$env:DM_DATA_DIR = "$env:TEMP\dm-scratch"
.\bin\x64\Debug\net9.0-windows10.0.19041.0\win-x64\DownloadManager.exe
```

## Packaging (not done)

Needed for a shippable build: bundle `node.exe` and `host.mjs` under `core\`, build the WinUI app self-contained (already configured), create an installer (MSIX or Inno Setup/WiX), code-sign, and register the native host from the installer instead of the script. For macOS: a SwiftUI app with the same protocol, signing and notarization.
