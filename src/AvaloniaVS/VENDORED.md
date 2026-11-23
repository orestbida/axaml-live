# Vendored: AvaloniaVS completion engine

Source: https://github.com/AvaloniaUI/AvaloniaVS at commit `972f10f638f3a8b1eb3de73cbbed28613967953a`
(previously a git submodule). MIT license, see `license.md`.

Only the parts used by the language server are kept:

- `CompletionEngine/Avalonia.Ide.CompletionEngine`
- `CompletionEngine/Avalonia.Ide.CompletionEngine.DnlibMetadataProvider`
- `Props/`, `Directory.Build.props` (imported by the projects above)

Local changes:

- `System.Text.Json` only for netstandard2.0, version 8.0.5 (the 4.6.0 pin was for Visual Studio and pulled a
  vulnerable `System.Text.Encodings.Web`).

- `AssemblyMetadata/DepsJsonAssemblyListLoader.cs`: the NuGet packages folder was built from the literal
  string `USERPROFILE`/`HOME` instead of the environment variable's value, so assemblies that are not copied to
  the output folder (class libraries) were never found. `NUGET_PACKAGES` is now checked first.

- Reformatted to the repository code style (opening braces on the same line, see `.editorconfig`).
