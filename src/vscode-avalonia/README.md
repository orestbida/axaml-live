# Avalonia for Visual Studio Code (Community)

A community-maintained, MIT-licensed fork of the archived [AvaloniaVSCode](https://github.com/AvaloniaUI/AvaloniaVSCode) extension:
live XAML previewer and AXAML language features for [Avalonia](https://github.com/AvaloniaUI/Avalonia/) 11 and 12.
No account, no telemetry, no C# Dev Kit requirement.

> If the official "Avalonia for VSCode" extension (`AvaloniaTeam.vscode-avalonia`) is installed, disable it in the workspace — both contribute the same commands.

## Getting started

Create a project from VS Code (**Avalonia: Create a new Avalonia Project**) or from the command line:

    dotnet new install Avalonia.Templates
    dotnet new avalonia.mvvm -o MyApp

Open the folder, open an `.axaml` file and click **Show preview** in the editor toolbar (or enable
`avalonia.previewer.autoOpen`). If the project was never built, it is built automatically.

## Previewer

- **Live**: edits are shown while you type, no need to save.
- **Interactive**: mouse, wheel and keyboard go to the previewed UI (toggle with 🖱).
- **Sharp zoom**: −/+, Ctrl+Wheel, Fit All, Fit Width. The designer renders at the zoomed resolution instead of scaling an image.
- **Theme**: preview in the app theme, Light or Dark.
- **Form factors**: desktop, laptop, phones and tablets, with rotation (⟲). Applied to the preview only, the file is not changed.
- **Builds just work**: the previewer runs from a copy of the build output (native libraries from an immutable cache), so
  `dotnet build` is never blocked by locked files. After any build (toolbar **Build**, terminal, C# Dev Kit) the preview reloads by itself.
- **Errors**: XAML errors are shown under the preview and in the Problems view.
- **Remote**: frames go through the extension host, so SSH, WSL and Codespaces work without port forwarding.
- **FPS limit** for animations (`avalonia.previewer.fpsLimit`).
- One preview follows the active AXAML editor. XAML in libraries (e.g. `avalonia.xplat`) is hosted by the executable
  project that references it; choose another host with **Avalonia: Select previewer host project** (or click the project
  name in the preview toolbar), the `avalonia.previewer.hostProject` setting, or from `.vscode/launch.json`
  (`avalonia.previewer.syncWithLaunchConfig`).

| Setting | Default | |
|---|---|---|
| `avalonia.previewer.autoOpen` | `false` | open the preview when an .axaml file is opened |
| `avalonia.previewer.defaultZoom` | `1` | factor, `"fitAll"` or `"fitWidth"` |
| `avalonia.previewer.defaultThemeVariant` | `Default` | `Default`, `Light`, `Dark` |
| `avalonia.previewer.defaultFormFactor` | `default` | device preset (`phone`, `tablet`, …) |
| `avalonia.previewer.defaultFormFactorRotated` | `false` | |
| `avalonia.previewer.enableInput` | `true` | forward mouse/keyboard to the preview |
| `avalonia.previewer.fpsLimit` | `30` | 0 = unlimited |
| `avalonia.previewer.maxRenderScale` | `3` | maximum render scale when zoomed in |
| `avalonia.previewer.updateDelay` | `300` | ms before unsaved edits are sent |
| `avalonia.previewer.buildIfNeeded` | `true` | build automatically when there is no build output |
| `avalonia.previewer.hostProject` | `""` | executable project that hosts the previewer |
| `avalonia.previewer.syncWithLaunchConfig` | `false` | host = project started by launch.json |

## Editing AXAML

- **Completion** for elements, properties, markup extensions, resources, `x:` directives.
- **Diagnostics without building**: unknown types, properties/events and compiled binding paths (`x:DataType`), with
  **quick fixes** ("Change to 'Button'").
- **Hover**: type and property signatures with their documentation.
- **Go to definition**: `x:Class`, `x:DataType`, types, binding path members, event handlers, resource keys.
- **Source-generated members** (e.g. CommunityToolkit `[ObservableProperty]`) are known as soon as the C# file is saved:
  the language server compiles the project in memory (Roslyn), no build needed.
- **Show Code-behind** (F7) and **Show ViewModel** (Shift+F7).
- **Format Document** with attribute wrapping (`alignWithFirst` / `indent`), markup extension argument wrapping, blank
  line collapsing and quote style (`avalonia.formatting.*`, `avalonia.editor.attributeQuoteStyle`).
- **🎨 badges** after elements matched by a `Style` declared in the same file; hover lists the selectors
  (`avalonia.showStyleAdornments`).
- `.axaml.cs` files nested under their `.axaml` in the Explorer (when file nesting is enabled).

## Commands

**Show preview**, **Restart previewer**, **Build project and reload preview**, **Run / Debug Project**,
**Show Code-behind**, **Show ViewModel**, **New Avalonia Item…** (Explorer folder menu), **Create a new Avalonia Project**,
**Install / Update Avalonia Project Templates**, **Select solution**, **Select previewer host project**.

## Requirements

- .NET 8 or newer for the previewer and project discovery (the tools run on the newest installed runtime and respect `global.json`).
- .NET 10 runtime for the language server (completion, diagnostics, hover, go to definition).
- The C# extension (`ms-dotnettools.csharp`) for **Run / Debug** with the debugger; without it the project is started in a terminal.

Tested with Avalonia 11.3 and 12.2, C# and F#, on Windows and on Ubuntu (WSL, remote).

## Troubleshooting

Open **Output → Avalonia Client** (or the **≡** button in the preview).
