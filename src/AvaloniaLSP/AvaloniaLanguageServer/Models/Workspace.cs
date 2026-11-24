using System.Collections.Concurrent;
using System.Text.Json;
using Avalonia.Ide.CompletionEngine;
using Avalonia.Ide.CompletionEngine.AssemblyMetadata;
using Avalonia.Ide.CompletionEngine.DnlibMetadataProvider;
using AvaloniaLanguageServer.Services;
using AvaloniaLanguageServer.Utilities;
using Compilation = Microsoft.CodeAnalysis.Compilation;
using VersionStamp = Microsoft.CodeAnalysis.VersionStamp;

namespace AvaloniaLanguageServer.Models;

/// <summary>What a request needs for one document: its project, completion metadata and C# compilation.</summary>
public sealed record DocumentContext(ProjectInfo? Project, Metadata? Metadata, Compilation? Compilation);

/// <summary>
/// Projects of the open AXAML documents. Metadata is kept per project, so documents from several projects can be open
/// at the same time: a request for one document never changes what another request sees.
/// </summary>
public class Workspace {
    public BufferService BufferService { get; } = new();
    public RoslynProjects Roslyn { get; } = new();

    /// <summary>Raised when completion metadata of a project changed (build or live compilation): diagnostics are recomputed.</summary>
    public event Action? MetadataChanged;

    /// <summary>The project of the last document a request was made for, used as a fallback root folder.</summary>
    public ProjectInfo? LastProject { get; private set; }

    sealed record Built(DateTime Stamp, Metadata Metadata);
    sealed record Live(DateTime Time, Metadata Metadata);

    readonly ConcurrentDictionary<string, ProjectInfo> _projects = new(StringComparer.OrdinalIgnoreCase);
    readonly ConcurrentDictionary<string, Built> _built = new(StringComparer.OrdinalIgnoreCase);
    readonly ConcurrentDictionary<string, Live> _live = new(StringComparer.OrdinalIgnoreCase);
    /// <summary>
    /// The project version (Roslyn's, changes with the project's or a referenced project's sources) live metadata was
    /// last computed for, also when the code did not compile: each version is compiled once.
    /// </summary>
    readonly ConcurrentDictionary<string, VersionStamp> _liveAttempted = new(StringComparer.OrdinalIgnoreCase);
    readonly SemaphoreSlim _liveLock = new(1, 1);
    readonly object _dataLock = new();
    readonly object _builtLock = new();
    readonly MetadataReader _metadataReader = new(new DnlibMetadataProvider());

    string? _dataFile;
    DateTime _dataStamp;
    SolutionData? _data;

    public Workspace() {
        Roslyn.Changed += () => {
            foreach (var project in _liveAttempted.Keys) {
                RefreshLiveAsync(project).FireAndForget();
            }
        };
    }

    /// <param name="compile">false when the request may not need the C# compilation (it can take seconds the first time)</param>
    public async Task<DocumentContext> ContextAsync(DocumentUri uri, string? rootPath, bool compile = true) {
        var project = await ProjectOfAsync(uri);
        if (project == null) {
            return new DocumentContext(null, null, null);
        }

        LastProject = project;
        var built = BuiltMetadata(project, rootPath);
        // cheap check on the loaded snapshot; loading and compiling happen in the background
        var loaded = Roslyn.LoadedProject(project.ProjectPath);
        if (loaded == null
            || !_liveAttempted.TryGetValue(project.ProjectPath, out var attempted)
            || attempted != await loaded.GetDependentVersionAsync()) {
            RefreshLiveAsync(project.ProjectPath).FireAndForget();
        }

        Metadata? metadata = built?.Metadata;
        if (_live.TryGetValue(project.ProjectPath, out var live) && (built == null || live.Time > built.Stamp)) {
            // whichever is newer: the build (complete, includes XAML-generated code) or the live compilation of sources
            metadata = live.Metadata;
        }

        var compilation = compile ? await Roslyn.GetCompilationAsync(project.ProjectPath) : null;
        return new DocumentContext(project, metadata, compilation);
    }

    async Task<ProjectInfo?> ProjectOfAsync(DocumentUri uri) {
        var directory = Path.GetDirectoryName(Utils.FromUri(uri));
        if (directory == null) {
            return null;
        }

        if (_projects.TryGetValue(directory, out var cached) && File.Exists(cached.ProjectPath)) {
            return cached;
        }

        var project = await ProjectInfo.GetProjectInfoAsync(uri);
        if (project != null) {
            _projects[directory] = project;
        }

        return project;
    }

    /// <summary>
    /// Metadata from an in-memory compilation of the project (sources and generators, no build needed). Runs once per
    /// change of the C# sources, also when the code does not compile, so a broken project is not compiled again and again.
    /// </summary>
    async Task RefreshLiveAsync(string project) {
        bool changed = false;
        await _liveLock.WaitAsync();
        try {
            // one snapshot: its version and its compilation belong together
            var snapshot = await Roslyn.GetProjectAsync(project);
            if (snapshot == null) {
                return;
            }
            var version = await snapshot.GetDependentVersionAsync();
            if (_liveAttempted.TryGetValue(project, out var attempted) && attempted == version) {
                return;
            }

            _liveAttempted[project] = version;
            var paths = await Roslyn.EmitForMetadataAsync(snapshot);
            if (paths == null) {
                return;
            }

            var metadata = MetadataConverter.ConvertMetadata(new DnlibMetadataProvider().GetMetadata(paths));
            _live[project] = new Live(DateTime.UtcNow, metadata);
            changed = true;
            Log.Logger.Information("Live completion metadata for {Project} ({Version})", project, version);
        } catch (Exception e) {
            Log.Logger.Warning(e, "Live metadata failed for {Project}", project);
        } finally {
            _liveLock.Release();
        }

        if (changed) {
            MetadataChanged?.Invoke();
        }
    }

    /// <summary>
    /// Metadata of the built assembly, reloaded when it was rebuilt (#29, #179), so new view model properties etc. show
    /// up without restarting VS Code.
    /// </summary>
    Built? BuiltMetadata(ProjectInfo project, string? rootPath) {
        var assembly = TargetAssembly(project, rootPath);
        if (assembly == null || !File.Exists(assembly)) {
            return null;
        }

        var stamp = File.GetLastWriteTimeUtc(assembly);
        var cached = _built.GetValueOrDefault(assembly);
        if (cached != null && cached.Stamp == stamp) {
            return cached;
        }

        Built? loaded = null;
        // one load per build: requests that arrive meanwhile wait for it instead of loading (and reporting) it again
        lock (_builtLock) {
            cached = _built.GetValueOrDefault(assembly);
            if (cached != null && cached.Stamp == stamp) {
                return cached;
            }

            try {
                var metadata = _metadataReader.GetForTargetAssembly(assembly);
                if (metadata == null) {
                    return cached;
                }

                loaded = new Built(stamp, metadata);
                _built[assembly] = loaded;
                Log.Logger.Information("Completion metadata loaded for {Assembly}", assembly);
            } catch (Exception e) {
                // the assembly can be mid-write during a build; retry on next request
                Log.Logger.Warning(e, "Failed to load completion metadata for {Assembly}", assembly);
                return cached;
            }
        }

        MetadataChanged?.Invoke();
        return loaded;
    }

    string? TargetAssembly(ProjectInfo project, string? rootPath) {
        var dataFile = SolutionDataFile(rootPath);
        if (dataFile == null || !File.Exists(dataFile)) {
            return null;
        }

        try {
            SolutionData? data;
            lock (_dataLock) {
                var stamp = File.GetLastWriteTimeUtc(dataFile);
                if (dataFile != _dataFile || stamp != _dataStamp) {
                    _data = JsonSerializer.Deserialize<SolutionData>(File.ReadAllText(dataFile));
                    _dataFile = dataFile;
                    _dataStamp = stamp;
                }
                data = _data;
            }

            // first candidate that has been built
            return data?.GetCompletionTargets(project.ProjectPath)
                .Select(p => p.TargetPath)
                .FirstOrDefault(File.Exists);
        } catch (Exception e) {
            Log.Logger.Warning(e, "Failed to read solution data {File}", dataFile);
            return null;
        }
    }

    static string? SolutionDataFile(string? rootPath) {
        // provided by the VS Code extension, workspace specific
        var fromClient = Environment.GetEnvironmentVariable("AVALONIA_SOLUTION_DATA");
        if (!string.IsNullOrEmpty(fromClient)) {
            return fromClient;
        }

        if (rootPath == null) {
            return null;
        }

        // legacy location written by SolutionParser: %TEMP%/<solution file name or folder name>.json
        // GetFileName (not GetFileNameWithoutExtension) to match the parser for names with dots (#171)
        var slnFile = SolutionName(rootPath) ?? Path.GetFileName(rootPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        return Path.Combine(Path.GetTempPath(), $"{slnFile}.json");
    }

    static string? SolutionName(string rootPath) {
        return Directory.EnumerateFiles(rootPath, "*.sln", SearchOption.TopDirectoryOnly)
            .Concat(Directory.EnumerateFiles(rootPath, "*.slnx", SearchOption.TopDirectoryOnly))
            .Select(Path.GetFileName)
            .FirstOrDefault();
    }
}
