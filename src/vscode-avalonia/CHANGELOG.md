# Change Log

All notable changes to the "vscode-avalonia" extension will be documented in this file.

## [0.2.0] - 23 November 2026

Previewer:

- Frames are rendered by the extension (canvas) instead of the designer's HTML page: works remotely without port forwarding.
- Sharp zoom (the designer renders at zoom × screen scale), Fit All / Fit Width.
- Theme switch (app theme / Light / Dark) and form factors (desktop, laptop, phones, tablets) with rotation; applied to the
  XAML sent to the previewer only.
- Mouse, wheel and keyboard input with a toggle; FPS limit; auto-open; previewer host from launch.json.
- Native runtimes come from an immutable per-platform cache: builds never hit locked native DLLs.

Language features:

- Diagnostics without building (unknown types, properties, events, compiled binding paths) with quick fixes.
- Hover with documentation; go to definition (x:Class, x:DataType, types, binding members, event handlers, resources).
- The language server compiles projects in memory (Roslyn): source-generated members are known without building.
- Show Code-behind (F7) / Show ViewModel (Shift+F7), Run / Debug project, install/update templates.
- XAML formatter (attribute and markup extension wrapping, quote style, blank lines); quote style for completions.
- 🎨 badges for elements matched by Styles in the same file.

The language server now targets .NET 10 (Roslyn 5).

## [0.1.0] - 23 November 2026

Community fork of the archived MIT extension. The previewer was rewritten for reliability; issue numbers refer to
[AvaloniaUI/AvaloniaVSCode](https://github.com/AvaloniaUI/AvaloniaVSCode/issues).

New:

- **New Avalonia Item…** in the Explorer folder context menu: Window, UserControl, TemplatedControl, Styles, ResourceDictionary, with the right namespace; F# files are added to the `.fsproj` compile list (#38, #116, #128, #118).
- Preview toolbar: Restart, Build, Log, zoom (−/+, Ctrl+Wheel) (#96, #12, #78).
- `.axaml.cs` / `.axaml.fs` files are nested under their `.axaml` in the Explorer (when file nesting is enabled).
- Choose the project that hosts the previewer: **Avalonia: Select previewer host project** (or click the project name in the
  preview toolbar), remembered per workspace, or the `avalonia.previewer.hostProject` setting (AvaloniaPro #207, #200, #171).
- XAML in a library that no executable references (plugins) can be previewed: the library is built too and added to the
  previewer copy without locking its output (AvaloniaPro #207).
- Settings: `avalonia.previewer.updateDelay`, `avalonia.previewer.buildIfNeeded`, `avalonia.previewer.defaultZoom`.

Previewer:

- Building while the previewer is open no longer fails with "file is locked" (#115, #165). The previewer runs from a shadow copy of the build output.
- The preview reloads automatically after **any** build: the Build button, `dotnet build` in a terminal, C# Dev Kit (#152, #179).
- Live preview of unsaved edits.
- XAML errors are shown in the preview and in the Problems view with the correct line (#112, #79, #164).
- No more blank preview: the frame is loaded only after the previewer reports that its HTTP server is ready.
- Restarting the previewer no longer breaks the connection (one TCP server per session; previously a stale server kept the old port), and TCP messages are framed correctly (#94, #87, #96).
- Moving or resizing the preview tab does not break it (#87); closing it stops the previewer process (AvaloniaPro #188).
- Missing build output is built automatically (#71, #81, #82).
- Projects with `PublishAot` / trimming no longer fail with "Dynamic code generation is not supported on this platform" (#151).
- Remote development, Codespaces and WSL: the previewer port is forwarded to the local UI (#131, #122, #53).
- Tested with Avalonia 12.2 (net10.0) and 11.3 (net9.0), C# and F# projects, an xplat solution and a path with spaces.
- Checked against the AvaloniaPro previewer reports; these work in this extension (each verified with a project):
  build output paths over 260 characters (#208), a `native\<name>.dll` next to the assembly as with `NativeLib=Shared` (#187),
  `Design.PreviewWith` in a TemplatedControl theme (#51), a net9.0 app using 10.x `Microsoft.Extensions.Logging.Abstractions`
  / `System.Diagnostics.DiagnosticSource` (#197, #122), a .NET Framework package with native binaries (#133),
  half-typed values while editing (#65), rebuilds while previewing (#202, #218), dependency upgrades (#172; the copy is fresh
  for each previewer start).

Projects and solutions:

- The language server and solution parser run on the newest installed .NET (8 or later) and honor `global.json`: fixes "Could not find a matching .NET SDK" (#178) and .NET 8-only machines (#153, #157, #159, #120, #77).
- `.slnx` solutions (#162); choosing between multiple solutions, `Avalonia: Select solution` (#101).
- XAML in class libraries is hosted by the executable project that references it (avalonia.xplat, Desktop head preferred) (#155, #32, #10).
- `Exe` output type (#80), multi-targeted projects (#99), paths with different drive letter case on Windows.
- Project references were resolved relative to the project file instead of its folder.
- Processes are started without a shell: paths with spaces work (#41, #43); a missing `dotnet` no longer hangs project creation (#114).

Code completion:

- Closing tags and prefixed names are inserted correctly: `</` gives `</Grid>` instead of `<//Grid>` (#166).
- Class library projects without an executable get completion (#169). The completion engine never looked in the NuGet cache (it used the literal string "USERPROFILE" as the home folder), so assemblies that are not copied to `bin` were missing.
- Completion uses the project of the edited file and reloads when that project is rebuilt; no VS Code restart needed (#29, #179).
- Works for names with dots (#171), `AssemblyName`, `UseArtifactsOutput` and Release builds (#119, #138): the server uses the solution model instead of guessing `bin/Debug`.
- The solution is parsed on startup, so completion works for projects built outside VS Code (#152, #51).

## [0.0.27] - 18 January 2024

Fixes:

- VSCode Extension v0.0.26 still not working [#89](https://github.com/AvaloniaUI/AvaloniaVSCode/issues/89)
- SolutionParser is crashed and previewer is not loaded correctly [#86](https://github.com/AvaloniaUI/AvaloniaVSCode/issues/86)

## [0.0.26] - 03 January 2024

Fixes:

- Can't get past "Build the project first." [#81](https://github.com/AvaloniaUI/AvaloniaVSCode/issues/81)
- Problem with dotnet version dependency [#77](https://github.com/AvaloniaUI/AvaloniaVSCode/issues/77)


## [0.0.25] - 27 November 2023

Fixes: 

- AXAML intellisense in VS Code broken [#66](https://github.com/AvaloniaUI/AvaloniaVSCode/issues/66)
- ALWAYS: Previewer is not available. Build the project first. [#72](https://github.com/AvaloniaUI/AvaloniaVSCode/issues/72)
- [ERROR] dotnet build exited with code 1 [#68](https://github.com/AvaloniaUI/AvaloniaVSCode/issues/68)
- Preview not working, vscode Linux [#58](https://github.com/AvaloniaUI/AvaloniaVSCode/issues/58)
- Previewer not working in Linux. [#61](https://github.com/AvaloniaUI/AvaloniaVSCode/issues/61)

## [0.0.24] - 16 November 2023

Fixed the blocker issue [#65](https://github.com/AvaloniaUI/AvaloniaVSCode/issues/65)

## [0.0.22] - 25 October 2023

## What's Changed
* fixes: Previewer does not work in the v0.0.21 [#63](https://github.com/AvaloniaUI/AvaloniaVSCode/issues/63)

## [0.0.21] - 25 October 2023

## What's Changed
* feat: Add C# snippet for Avalonia AttachedProperty, DirectProperty, S… by @workgroupengineering in https://github.com/AvaloniaUI/AvaloniaVSCode/pull/59
* Fixes warnings by @workgroupengineering in https://github.com/AvaloniaUI/AvaloniaVSCode/pull/60

## New Contributors
* @workgroupengineering made their first contribution in https://github.com/AvaloniaUI/AvaloniaVSCode/pull/59

**Full Changelog**: https://github.com/AvaloniaUI/AvaloniaVSCode/compare/v0.0.20...v0.0.21

## [0.0.20] - 9 October 2023

## What's Changed
* Fix the mouse interaction in previewer by @prashantvc in https://github.com/AvaloniaUI/AvaloniaVSCode/pull/56
* Improve indentation by @prashantvc in https://github.com/AvaloniaUI/AvaloniaVSCode/pull/57


**Full Changelog**: https://github.com/AvaloniaUI/AvaloniaVSCode/compare/v0.0.19...v0.0.20

## [0.0.19] - 13 September 2023
### What's Changed
* Allow users to create a new project from VSCode by @prashantvc in https://github.com/AvaloniaUI/AvaloniaVSCode/pull/47
* Previewer Window Title does not update on tab switch by @prashantvc in https://github.com/AvaloniaUI/AvaloniaVSCode/pull/50


**Full Changelog**: https://github.com/AvaloniaUI/AvaloniaVSCode/compare/v0.0.18...v0.0.19
## [0.0.18] - 08 September 2023
### Fixes

- Extenstion not activating #39
- Extension fails to launch child process if VS Code path has spaces #41


## [0.0.17] - 01 September 2023

### Fixes

- Previewer is blank, it does not get update until focus change. [Issue #8](https://github.com/AvaloniaUI/Avalonia-VSCode-Extension/issues/8)
- Previewer doesn't work when opened from command palette. [Issue #5](https://github.com/AvaloniaUI/Avalonia-VSCode-Extension/issues/5)

## [0.0.13] - 25 August 2023

- Fixes the issue where extension fails to work when on .NET preview releases

## [0.0.11] - 24 August 2023

- Improve the XAML previewer performace
- Support Avalonia xplat solution

### Known issues

1. Previewer may take up to 10 seconds to activate for the first time if you’re using Avalonia `v0.10.*`
2. You must build the project before using the preivewer
3. Previewer may not be visible first time; switch to XAML code tab or save the file

## [0.0.6] - 03 August 2023

- Improved code completion

## [0.0.4] - 25 July 2023

- Code completion will not work for files with `\n` as newline chars [#23](https://github.com/AvaloniaUI/AvaloniaVSCode/issues/23)
- Set higher/lower limit for previewer [#18](https://github.com/AvaloniaUI/AvaloniaVSCode/issues/18)

## [0.0.3] - 19 July 2023

- Fixed the issue where `Show preview` command is available for all `xml` files (issue #15)
- Previewer now shows the preview from the active `axaml` file (issue #19)

### Known issues

- Previewer may take over 5 seconds to render if you're using Avalonia 0.10.*
- Auto complete my crash for large files

## [0.0.2] - 12 July 2023

- Offers previewer zoom in/out functionality
- Previewer now has grid bacground
- Previewer changes backgroud based on VS Code theme

### Known issues

- Previewer will not update when you switch between `axaml` files

## [0.0.1]

- Initial release
- Offers XAML auto-complete
- Offers Basic XMAL Previewer

### Known issues

- Extension works when only Avalonia project in the workspace
- You cannot zoom-in or out previwer panel
- Auto-complete lists duplicate items