using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.MSBuild;
using Microsoft.CodeAnalysis.Text;

namespace AvaloniaLanguageServer.Services;

/// <summary>
/// In-memory C# compilation of the projects that own the edited AXAML files (Roslyn MSBuildWorkspace).
/// Source generators run as part of the compilation, so generated members (e.g. CommunityToolkit [ObservableProperty])
/// are known without building. Used for completion metadata, binding validation, hover and go to definition.
///
/// One immutable <see cref="Solution"/> is the only state: the projects as read from disk, plus the file changes
/// applied since. Readers take the current snapshot and keep it; a change makes a new snapshot. Compilations are
/// Roslyn's own, cached per snapshot (unchanged projects reuse theirs), so a compilation always matches its sources.
/// A project that is not in the snapshot yet is loaded with all earlier ones in a new workspace, read from disk: the
/// disk already has every change, so nothing has to be carried over.
/// </summary>
public sealed class RoslynProjects : IDisposable {
    MSBuildWorkspace? _workspace;
    volatile Solution? _solution;
    readonly SemaphoreSlim _lock = new(1, 1);
    /// <summary>Every project asked for so far: a reload loads all of them.</summary>
    readonly HashSet<string> _requested = new(StringComparer.OrdinalIgnoreCase);
    volatile bool _reloadNeeded;
    int _emitCount;

    /// <summary>
    /// Failed loads and when to try again, growing with each failure. Kept per project that has never loaded (it does
    /// not hold up the others), and under <see cref="Snapshot"/> when a reload of loaded projects failed (MSBuild's
    /// build host sometimes fails to start for a moment): then the last good snapshot stays in use meanwhile.
    /// </summary>
    readonly ConcurrentDictionary<string, (DateTime RetryAt, int Failures)> _waiting = new(StringComparer.OrdinalIgnoreCase);
    const string Snapshot = "";

    /// <summary>Wait before the next load after this many failures in a row: 3 s, doubling, at most 60 s.</summary>
    public static TimeSpan RetryDelay(int failures) =>
        TimeSpan.FromSeconds(Math.Min(60, 3 * Math.Pow(2, Math.Max(0, failures - 1))));

    bool Waiting(string key) => _waiting.TryGetValue(key, out var w) && DateTime.UtcNow < w.RetryAt;

    TimeSpan Failed(string key) {
        var failures = (_waiting.TryGetValue(key, out var w) ? w.Failures : 0) + 1;
        var delay = RetryDelay(failures);
        _waiting[key] = (DateTime.UtcNow + delay, failures);
        return delay;
    }

    /// <summary>Raised (debounced) after source files of a loaded project changed.</summary>
    public event Action? Changed;
    CancellationTokenSource? _debounce;

    /// <summary>The project in the current snapshot, without loading anything (null when not loaded or out of date).</summary>
    public Project? LoadedProject(string projectPath) {
        projectPath = Path.GetFullPath(projectPath);
        var solution = _solution;
        return solution == null || (_reloadNeeded && !Waiting(Snapshot)) ? null : Find(solution, projectPath);
    }

    /// <summary>The project in the current snapshot, loading it first when needed. Null for non-C# projects.</summary>
    public async Task<Project?> GetProjectAsync(string projectPath) {
        projectPath = Path.GetFullPath(projectPath);
        if (!projectPath.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase)) {
            return null; // Roslyn C# only (F# projects use the built assembly)
        }

        // fast path: loaded, nothing to do
        if (LoadedProject(projectPath) is { } loaded) {
            return loaded;
        }

        await _lock.WaitAsync();
        try {
            _requested.Add(projectPath);
            var needed = _solution == null || _reloadNeeded || Find(_solution, projectPath) == null;
            if (needed && !Waiting(projectPath) && !Waiting(Snapshot)) {
                await LoadAsync();
            }
            return _solution == null ? null : Find(_solution, projectPath);
        } finally {
            _lock.Release();
        }
    }

    /// <summary>Compilation (with source generators) of the project's current snapshot.</summary>
    public async Task<Compilation?> GetCompilationAsync(string projectPath) {
        var project = await GetProjectAsync(projectPath);
        return project == null ? null : await project.GetCompilationAsync();
    }

    /// <summary>
    /// Loads every requested project in a new workspace (under the lock). A project that has never loaded and fails is
    /// left out (the others load) and tried again after its wait. When a project that was loaded fails, the previous
    /// snapshot stays in use until a reload works.
    /// </summary>
    async Task LoadAsync() {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var workspace = MSBuildWorkspace.Create(new Dictionary<string, string> { ["DesignTimeBuild"] = "true" });
        workspace.RegisterWorkspaceFailedHandler(e => Log.Logger.Warning("Roslyn workspace: {Message}", e.Diagnostic.Message));
        foreach (var path in _requested.ToArray()) {
            if (Waiting(path) || Find(workspace.CurrentSolution, path) != null) {
                continue; // in its wait after failing, or already loaded as a reference of another project
            }
            try {
                await workspace.OpenProjectAsync(path);
                _waiting.TryRemove(path, out _);
            } catch (Exception e) {
                if (_solution != null && Find(_solution, path) != null) {
                    workspace.Dispose();
                    var delay = Failed(Snapshot);
                    Log.Logger.Warning(e, "Roslyn: failed to reload {Project}, keeping the previous snapshot, trying again in {Delay} s", path, delay.TotalSeconds);
                    return;
                }
                var wait = Failed(path);
                Log.Logger.Warning(e, "Roslyn: failed to load {Project}, trying again in {Delay} s", path, wait.TotalSeconds);
            }
        }

        _waiting.TryRemove(Snapshot, out _);
        var old = _workspace;
        _workspace = workspace;
        _solution = workspace.CurrentSolution;
        _reloadNeeded = false;
        old?.Dispose();
        Log.Logger.Information("Roslyn: loaded {Count} project(s) in {Ms} ms", _solution.ProjectIds.Count, sw.ElapsedMilliseconds);
    }

    static Project? Find(Solution solution, string projectPath) =>
        solution.Projects.FirstOrDefault(p => string.Equals(p.FilePath, projectPath, StringComparison.OrdinalIgnoreCase));

    /// <summary>A source, project or .axaml file was created, changed or deleted on disk.</summary>
    public async Task FileChangedAsync(string path, bool deleted) {
        path = Path.GetFullPath(path);
        if (_solution == null) {
            return;
        }

        await _lock.WaitAsync();
        try {
            var solution = _solution;
            if (path.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase) || path.EndsWith(".props", StringComparison.OrdinalIgnoreCase)) {
                _reloadNeeded = true;
                _waiting.Clear(); // a changed project file may load now
            } else {
                var ids = DocumentIds(solution, path);
                Log.Logger.Debug("Roslyn: {Path} changed ({Count} documents)", path, ids.Length);
                if (ids.Length > 0 && !deleted && File.Exists(path)) {
                    var text = SourceText.From(await File.ReadAllTextAsync(path), Encoding.UTF8);
                    if (await OnlyNonGeneratorChangesAsync(solution, ids, text)) {
                        return;
                    }
                    _solution = WithText(solution, ids, text);
                } else if (ids.Length > 0 || (!deleted && IsInProjectFolder(solution, path))) {
                    _reloadNeeded = true; // file added to or removed from a project
                } else {
                    return;
                }
            }
        } finally {
            _lock.Release();
        }
        RaiseChangedDebounced();
    }

    /// <summary>
    /// .axaml files are additional documents (AvaloniaXaml items): the source generator only reads x:Class and the named
    /// elements from them. Other edits change no compilation, so the snapshot (and every cache keyed on its version)
    /// stays as it is.
    /// </summary>
    static async Task<bool> OnlyNonGeneratorChangesAsync(Solution solution, ImmutableArray<DocumentId> ids, SourceText text) {
        var input = GeneratorInput(text.ToString());
        foreach (var id in ids) {
            var additional = solution.GetAdditionalDocument(id);
            if (additional == null || GeneratorInput((await additional.GetTextAsync()).ToString()) != input) {
                return false;
            }
        }
        return true;
    }

    static bool IsInProjectFolder(Solution solution, string path) =>
        solution.Projects.Any(p => p.FilePath != null
            && path.StartsWith(Path.GetDirectoryName(p.FilePath)! + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase));

    static Solution WithText(Solution solution, IEnumerable<DocumentId> ids, SourceText text) {
        foreach (var id in ids) {
            if (solution.ContainsDocument(id)) {
                solution = solution.WithDocumentText(id, text);
            } else if (solution.ContainsAdditionalDocument(id)) {
                solution = solution.WithAdditionalDocumentText(id, text);
            }
        }
        return solution;
    }

    static ImmutableArray<DocumentId> DocumentIds(Solution solution, string path) {
        var ids = solution.GetDocumentIdsWithFilePath(path);
        if (ids.Length > 0) {
            return ids;
        }
        // VS Code lowercases the drive letter; Roslyn keeps the path as MSBuild reported it
        var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        return solution.Projects
            .SelectMany(p => p.Documents.Concat<Microsoft.CodeAnalysis.TextDocument>(p.AdditionalDocuments))
            .Where(d => string.Equals(d.FilePath, path, comparison))
            .Select(d => d.Id).ToImmutableArray();
    }

    static readonly Regex Comment = new(@"<!--.*?-->", RegexOptions.Compiled | RegexOptions.Singleline);
    // attribute values may contain '>' (e.g. StringFormat='>{0}'): quoted values are skipped as a whole
    static readonly Regex StartTag = new(@"<([A-Za-z_][\w:.]*)((?:[^>""']|""[^""]*""|'[^']*')*)>", RegexOptions.Compiled);
    static readonly Regex GeneratorAttribute = new(
        @"(?<![\w:.])(x:Class|x:Name|Name|x:FieldModifier|x:DataType|xmlns(?::[\w.]+)?)\s*=\s*(""[^""]*""|'[^']*')",
        RegexOptions.Compiled);

    /// <summary>
    /// What Avalonia's name generator reads from an .axaml file: x:Class, the namespace declarations, and the element
    /// type and modifiers of each named element (it generates a typed field per x:Name). Comments are not read. Equal for
    /// two texts: their compilations are equal.
    /// </summary>
    public static string GeneratorInput(string xaml) {
        var sb = new StringBuilder();
        foreach (Match tag in StartTag.Matches(Comment.Replace(xaml, ""))) {
            var attributes = GeneratorAttribute.Matches(tag.Groups[2].Value);
            if (attributes.Count == 0) {
                continue;
            }
            sb.Append(tag.Groups[1].Value);
            foreach (Match a in attributes) {
                sb.Append(' ').Append(a.Value);
            }
            sb.Append('\n');
        }
        return sb.ToString();
    }

    void RaiseChangedDebounced() {
        _debounce?.Cancel();
        var cts = _debounce = new CancellationTokenSource();
        _ = Task.Delay(500, cts.Token).ContinueWith(t => {
            if (!t.IsCanceled) {
                Changed?.Invoke();
            }
        }, TaskScheduler.Default);
    }

    /// <summary>
    /// Emits the project snapshot and its project references to a temp folder and returns the assemblies for completion
    /// metadata: the project first, then its references. Null when the code does not compile (the previous metadata
    /// stays).
    /// </summary>
    public async Task<string[]?> EmitForMetadataAsync(Project project) {
        var solution = project.Solution;
        var hash = Convert.ToHexString(SHA1.HashData(Encoding.UTF8.GetBytes((project.FilePath ?? project.Name).ToLowerInvariant())))[..12];
        var projectDir = Path.Combine(Path.GetTempPath(), "avalonia-lsp", hash);
        var dir = Path.Combine(projectDir, $"{Environment.ProcessId}-{Interlocked.Increment(ref _emitCount)}");
        RemoveOtherEmits(projectDir, dir);
        Directory.CreateDirectory(dir);

        var outputs = new List<string>();
        var references = new List<string>();
        var visited = new HashSet<ProjectId>();

        async Task<bool> Emit(Project p) {
            if (!visited.Add(p.Id)) {
                return true;
            }

            foreach (var r in p.ProjectReferences) {
                var referenced = solution.GetProject(r.ProjectId);
                if (referenced != null && !await Emit(referenced)) {
                    return false;
                }
            }
            var compilation = await p.GetCompilationAsync();
            if (compilation == null) {
                return false;
            }

            var file = Path.Combine(dir, (p.AssemblyName ?? p.Name) + ".dll");
            using (var stream = new MemoryStream()) {
                var result = compilation.Emit(stream);
                if (!result.Success) {
                    var first = result.Diagnostics.FirstOrDefault(d => d.Severity == Microsoft.CodeAnalysis.DiagnosticSeverity.Error);
                    Log.Logger.Information("Roslyn: {Project} does not compile yet ({Error}), keeping previous metadata", p.Name, first?.GetMessage());
                    return false;
                }
                await File.WriteAllBytesAsync(file, stream.ToArray());
            }
            outputs.Add(file);
            references.AddRange(compilation.References.OfType<PortableExecutableReference>().Select(r => r.FilePath).OfType<string>());
            return true;
        }

        if (!await Emit(project)) {
            return null;
        }

        var main = outputs.Last(); // the requested project is emitted last (after its references)
        return new[] { main }
            .Concat(outputs.Where(o => o != main))
            .Concat(references.Distinct(StringComparer.OrdinalIgnoreCase).Where(File.Exists))
            .ToArray();
    }

    /// <summary>Earlier emits of the project. One still in use (or another server's) cannot be deleted and is tried next time.</summary>
    static void RemoveOtherEmits(string projectDir, string keep) {
        if (!Directory.Exists(projectDir)) {
            return;
        }

        foreach (var old in Directory.EnumerateDirectories(projectDir)) {
            if (string.Equals(old, keep, StringComparison.OrdinalIgnoreCase)) {
                continue;
            }

            try {
                Directory.Delete(old, recursive: true);
            } catch (Exception) {
                // in use
            }
        }
    }

    public void Dispose() => _workspace?.Dispose();
}
