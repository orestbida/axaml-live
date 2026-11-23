# Avalonia for Visual Studio Code (Community)

A community-maintained, MIT-licensed fork of the archived [AvaloniaVSCode](https://github.com/AvaloniaUI/AvaloniaVSCode) extension:
AXAML code completion and a live XAML previewer for [Avalonia](https://github.com/AvaloniaUI/Avalonia/) 11 and 12.

> If the official "Avalonia for VSCode" extension (`AvaloniaTeam.vscode-avalonia`) is installed, disable it in the workspace — both contribute the same commands.

## Getting started

Create a project from VS Code (**Avalonia: Create a new Avalonia Project**) or from the command line:

    dotnet new install Avalonia.Templates
    dotnet new avalonia.mvvm -o MyApp

Open the folder, open an `.axaml` file and click **Show preview** in the editor toolbar.
If the project was never built, it is built automatically.

## Previewer

- **Live**: edits are shown while you type, no need to save.
- **Builds just work**: the previewer runs from a shadow copy of the build output, so `dotnet build` is never blocked by a locked DLL. After any build (toolbar **Build** button, terminal, C# Dev Kit) the preview reloads by itself.
- **Errors**: XAML errors are shown under the preview and in the Problems view.
- **Toolbar**: zoom (−/+, Ctrl+Wheel), **Restart**, **Build**, **Log**.
- One preview follows the active AXAML editor. XAML in libraries (e.g. `avalonia.xplat`) is hosted by the executable project that references it.

Settings:

| Setting | Default | |
|---|---|---|
| `avalonia.previewer.updateDelay` | `300` | ms before unsaved edits are sent to the previewer |
| `avalonia.previewer.buildIfNeeded` | `true` | build automatically when there is no build output |
| `avalonia.previewer.defaultZoom` | `1` | initial zoom |

Commands: **Avalonia: Show preview**, **Restart previewer**, **Build project and reload preview**, **Select solution**, **Create a new Avalonia Project**, **New Avalonia Item…**.

Also works with remote development (SSH, WSL, Codespaces): the previewer port is forwarded automatically, and with
projects that enable `PublishAot` or trimming.

## New items

Right-click a folder in the Explorer → **New Avalonia Item…** (Window, UserControl, TemplatedControl, Styles,
ResourceDictionary). The namespace follows the project and folder; F# files are added to the `.fsproj`.
Requires the Avalonia templates: `dotnet new install Avalonia.Templates`.

## Code completion

Powered by the same completion engine as Avalonia for Visual Studio. The project must be built once; afterwards
completion is refreshed automatically after every build (new types and properties show up without restarting VS Code).
Works in application and class library projects.

## Requirements

.NET 8 or newer installed (the tools run on the newest installed runtime and respect `global.json`).
Tested with Avalonia 11.3 and 12.2, C# and F#.

## Troubleshooting

Open **Output → Avalonia Client** (or the **Log** button in the preview).
