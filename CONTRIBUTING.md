# Contributing

Thanks for helping with AXAML Live. This page explains how to build, run and test the extension.

## Requirements

1. .NET SDK 10.0 or newer: https://dotnet.microsoft.com/download (it also builds the net8.0 and netstandard parts)
2. Node.js 22 or newer, with npm
3. Visual Studio Code
4. On Windows, Git Bash to run the build script

## Set up

1. Clone the repository. There are no submodules: the completion engine and the solution parser are part of the
   repository, see `src/AvaloniaVS/VENDORED.md` and `src/SolutionParser/VENDORED.md`.
2. Run `bash build.sh` from the repository root. It installs the npm packages, compiles the extension and builds the
   language server and the solution parser in Release mode.

## Run and debug

Open the repository in VS Code and press F5. A new VS Code window starts with the extension; open an Avalonia project
there.

## Checks

```bash
cd src/AxamlLive
npm run lint
npm run test:unit
```

GitHub Actions runs the same checks on Windows and Linux for every push and pull request
(`.github/workflows/ci.yml`) and uploads the VSIX as a build artifact.

## Package

```bash
bash build.sh
cd src/AxamlLive
npx @vscode/vsce package
```

Or run the **Package Extension** task in VS Code. Releases are built by `.github/workflows/release.yml` when a
version tag (for example `v0.1.0`) is pushed; see the README.

## How to contribute

1. Open an issue, or comment on an existing one.
2. Create a branch and keep commits small. Commit titles use conventional commits, for example
   `fix: preview stays empty after a rebuild` or `feat: add a background setting`.
3. Open a pull request with a short description of the change and how you tested it.

## End-to-end tests

`src/AxamlLive/src/test/e2e` drives a real, visible VS Code window against an Avalonia project:
show preview (auto build), live edit, XAML error reporting, external `dotnet build` while previewing, Build/Restart
commands, code completion (also after a rebuild), switching files and closing the preview.

```bash
cd src/AxamlLive
npm run compile
dotnet new avalonia.mvvm -o /tmp/E2EApp
node out/test/e2e/runE2E.js /tmp/E2EApp "<path to Code executable>"
```

Optional environment variables: `E2E_AXAML` (file to preview, default `MainWindow.axaml`), `E2E_BUILD_TARGET`
(project for the external build, e.g. the Desktop head of an xplat solution), `E2E_PAUSE_MS`,
`E2E_SCREENSHOT_DIR` (Windows: desktop screenshot per checkpoint), `E2E_GREP` (run matching tests only).

### README screenshot

`docs/images/screenshot.png` is taken with `E2E_SUITE=screenshot`: it opens one file next to its preview at 100%
zoom, without side bars, and saves a desktop capture to `E2E_SCREENSHOT_DIR` (Windows). Crop it to the editor and the
preview without scaling, so it stays sharp.

```bash
E2E_SUITE=screenshot E2E_AXAML=DashboardView.axaml E2E_SCREENSHOT_DIR=C:/temp/shot node out/test/e2e/runE2E.js <project> "<path to Code.exe>"
```

### Remote (WSL)

The same tests run with the extension host on Linux and the UI on Windows (Remote - WSL extension required):

```bash
# in WSL: a copy of the built extension and a test project
mkdir -p ~/avalonia-ext && (cd /mnt/c/<repo>/src/AxamlLive && tar --exclude=./src --exclude=./.vscode-test -cf - . | tar -xf - -C ~/avalonia-ext)
dotnet new avalonia.mvvm -o ~/avalonia-e2e/WslApp -f net10.0
```

```powershell
# on Windows
$env:E2E_REMOTE = "wsl+Ubuntu-22.04"; $env:E2E_REMOTE_EXTENSION = "/home/<user>/avalonia-ext"
node out/test/e2e/runE2E.js /home/<user>/avalonia-e2e/WslApp "<path to Code.exe>"
```

Environment variables don't reach the remote test host; put settings in `~/avalonia-ext/out/test/e2e/e2e.config.json`,
e.g. `{ "E2E_PAUSE_MS": 2500, "E2E_SCREENSHOT_DIR": "C:\\temp\\shots" }` (screenshots via `powershell.exe` interop).
Test output is in the WSL server log: `~/.vscode-server/data/logs/<date>/exthost1/remoteexthost.log`.
