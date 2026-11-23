# Contribution Guide

Welcome to Avalonia Extension for VS Code! We appreciate your interest in contributing. This guide will help you get started with contributing to our project. Please read it carefully.

## System Requirements

1. dotnet 9.0, you can download it from [here](https://dotnet.microsoft.com/en-us/download)
2. NodeJS, npm 
   You can get NodeJS and npm using NVM (Node Version Manager) by running the following command:
   
    `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash`

   See: https://github.com/nvm-sh/nvm for the latest version of this command.

3. Install yarn
   yarn can be installed with the following command:
    
    `npm install -g yarn`

4. Latest Visual Studio Code

## Set up

1. Fork and clone the repository (no submodules: the completion engine and the solution parser are vendored,
   see `src/AvaloniaVS/VENDORED.md` and `src/SolutionParser/VENDORED.md`)

2. Run `build.sh` (on Windows from Git Bash)

## How to contribute

1. Create a new issue or use the existing to contribute (assign it yourself)
2. Create a new branch for the issue
3. Send the PR with description

## Run and Debug

Hit `F5` this will a new vscode window with the dev extension running. Open an avalonia project to use it.

## Package Extension

Make sure you run the `build.sh` before packaging and you have `vsce` installed. If you do not, run the following command: 

```bash
npm install -g @vscode/vsce
```

1. Open command palette (shift + cmd + p)
2. Select `Task: Run Task`
3. Select `Package Extension`

## End-to-end tests

`src/vscode-avalonia/src/test/e2e` drives a real, visible VS Code window against an Avalonia project:
show preview (auto build), live edit, XAML error reporting, external `dotnet build` while previewing, Build/Restart
commands, code completion (also after a rebuild), switching files and closing the preview.

```bash
cd src/vscode-avalonia
yarn compile
dotnet new avalonia.mvvm -o /tmp/E2EApp
node out/test/e2e/runE2E.js /tmp/E2EApp "<path to Code executable>"
```

Optional environment variables: `E2E_AXAML` (file to preview, default `MainWindow.axaml`), `E2E_BUILD_TARGET`
(project for the external build, e.g. the Desktop head of an xplat solution), `E2E_PAUSE_MS`,
`E2E_SCREENSHOT_DIR` (Windows: desktop screenshot per checkpoint).
