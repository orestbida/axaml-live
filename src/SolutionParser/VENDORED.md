# Vendored: SolutionParser

Source: https://github.com/AvaloniaUI/SolutionParser at commit `d4b200860bdb2de2fbc4480b2dd1ab46876edc27`
(previously a git submodule). MIT license, see `LICENSE`.

Local changes:

- Targets `net8.0` with `RollForward=LatestMajor`: runs on the newest installed runtime, so MSBuildLocator can load
  any SDK, including the one pinned by `global.json` (fixes "Could not find a matching .NET SDK").
- Accepts any solution file path (`.sln` and `.slnx`); folders are scanned for project files.
- Multi-targeted projects (`TargetFrameworks`) are evaluated for their first .NET framework.
- Project references are resolved relative to the project folder (were resolved relative to the project file).
- Logs the selected MSBuild instance to stderr.
