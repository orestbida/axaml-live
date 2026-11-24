using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.MSBuild;
using Microsoft.CodeAnalysis.Text;

namespace AvaloniaLanguageServer.Services;

/// <summary>
/// In-memory C# compilation of the projects that own the edited AXAML files (Roslyn MSBuildWorkspace).
/// Source generators run as part of the compilation, so generated members (e.g. CommunityToolkit [ObservableProperty])
/// are known without building. Used for completion metadata, binding validation, hover and go to definition.
/// </summary>
public sealed class RoslynProjects : IDisposable {
    MSBuildWorkspace? _workspace;
    Solution? _solution;
    readonly SemaphoreSlim _lock = new(1, 1);
    readonly ConcurrentDictionary<string, ProjectId> _loaded = new(StringComparer.OrdinalIgnoreCase);
    readonly ConcurrentDictionary<ProjectId, (int Version, Compilation Compilation)> _compilations = new();
    int _version;
    bool _reloadNeeded;

    /// <summary>Raised (debounced) after C# sources of a loaded project changed.</summary>
    public event Action? Changed;
    CancellationTokenSource? _debounce;

    public int Version => _version;

    public async Task<Project?> GetProjectAsync(string projectPath, CancellationToken ct = default) {
        if (!projectPath.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase)) {
            return null; // Roslyn C# only (F# projects use the built assembly)
        }

        await _lock.WaitAsync(ct);
        try {
            if (_reloadNeeded) {
                _reloadNeeded = false;
                _workspace?.Dispose();
                _workspace = null;
                _solution = null;
                _loaded.Clear();
                _compilations.Clear();
            }
            if (_workspace == null) {
                _workspace = MSBuildWorkspace.Create(new Dictionary<string, string> { ["DesignTimeBuild"] = "true" });
                _workspace.RegisterWorkspaceFailedHandler(e => Log.Logger.Warning("Roslyn workspace: {Message}", e.Diagnostic.Message));
            }
            if (!_loaded.TryGetValue(projectPath, out var id)) {
                var sw = System.Diagnostics.Stopwatch.StartNew();
                var project = await _workspace.OpenProjectAsync(projectPath, cancellationToken: ct);
                _solution = _workspace.CurrentSolution;
                foreach (var p in _solution.Projects.Where(p => p.FilePath != null)) {
                    _loaded[p.FilePath!] = p.Id;
                }

                id = project.Id;
                Log.Logger.Information("Roslyn: loaded {Project} in {Ms} ms", projectPath, sw.ElapsedMilliseconds);
            }
            return _solution?.GetProject(id);
        } catch (Exception e) {
            Log.Logger.Warning(e, "Roslyn: failed to load {Project}", projectPath);
            return null;
        } finally {
            _lock.Release();
        }
    }

    /// <summary>Compilation (with source generators) of a project, cached per change version.</summary>
    public async Task<Compilation?> GetCompilationAsync(string projectPath, CancellationToken ct = default) {
        var project = await GetProjectAsync(projectPath, ct);
        if (project == null) {
            return null;
        }

        if (_compilations.TryGetValue(project.Id, out var cached) && cached.Version == _version) {
            return cached.Compilation;
        }

        var compilation = await project.GetCompilationAsync(ct);
        var generated = (await project.GetSourceGeneratedDocumentsAsync(ct)).Count();
        Log.Logger.Debug("Roslyn: compiled {Project} v{Version}: {Trees} trees, {Generated} generated, {Analyzers} analyzer references",
            project.Name, _version, compilation?.SyntaxTrees.Count(), generated, project.AnalyzerReferences.Count);
        if (compilation != null) {
            _compilations[project.Id] = (_version, compilation);
        }

        return compilation;
    }

    /// <summary>A C# file was created, changed or deleted on disk.</summary>
    public async Task FileChangedAsync(string path, bool deleted) {
        if (_solution == null) {
            return;
        }

        await _lock.WaitAsync();
        try {
            if (path.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase) || path.EndsWith(".props", StringComparison.OrdinalIgnoreCase)) {
                _reloadNeeded = true;
            } else {
                var ids = _solution.GetDocumentIdsWithFilePath(path);
                if (ids.Length == 0) {
                    // VS Code lowercases the drive letter; Roslyn keeps the path as MSBuild reported it
                    ids = _solution.Projects.SelectMany(p => p.Documents)
                        .Where(d => string.Equals(d.FilePath, path, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
                        .Select(d => d.Id).ToImmutableArray();
                }
                Log.Logger.Debug("Roslyn: {Path} changed ({Count} documents)", path, ids.Length);
                if (ids.Length > 0 && !deleted && File.Exists(path)) {
                    var text = SourceText.From(await File.ReadAllTextAsync(path), Encoding.UTF8);
                    foreach (var id in ids) {
                        // .axaml files are additional documents (AvaloniaXaml items), not C# documents
                        if (_solution.ContainsDocument(id)) {
                            _solution = _solution.WithDocumentText(id, text);
                        } else if (_solution.ContainsAdditionalDocument(id)) {
                            _solution = _solution.WithAdditionalDocumentText(id, text);
                        }
                    }
                } else if (ids.Length > 0 || (!deleted && _loaded.Keys.Any(p => path.StartsWith(Path.GetDirectoryName(p)! + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)))) {
                    _reloadNeeded = true; // file added to or removed from a project
                } else {
                    return;
                }
            }
            Interlocked.Increment(ref _version);
        } finally {
            _lock.Release();
        }
        RaiseChangedDebounced();
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
    /// Emits the project and its project references to a temp folder and returns the assemblies for completion metadata:
    /// the project first, then its references. Null when the code does not compile (the previous metadata stays).
    /// </summary>
    public async Task<string[]?> EmitForMetadataAsync(string projectPath, CancellationToken ct = default) {
        var project = await GetProjectAsync(projectPath, ct);
        if (project == null) {
            return null;
        }

        var solution = project.Solution;
        var hash = Convert.ToHexString(SHA1.HashData(Encoding.UTF8.GetBytes(projectPath.ToLowerInvariant())))[..12];
        var projectDir = Path.Combine(Path.GetTempPath(), "avalonia-lsp", hash);
        var dir = Path.Combine(projectDir, _version.ToString());
        RemoveOtherVersions(projectDir, dir);
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
            var compilation = await GetCompilationAsync(p.FilePath!, ct) ?? await p.GetCompilationAsync(ct);
            if (compilation == null) {
                return false;
            }

            var file = Path.Combine(dir, (p.AssemblyName ?? p.Name) + ".dll");
            using (var stream = new MemoryStream()) {
                var result = compilation.Emit(stream, cancellationToken: ct);
                if (!result.Success) {
                    var first = result.Diagnostics.FirstOrDefault(d => d.Severity == Microsoft.CodeAnalysis.DiagnosticSeverity.Error);
                    Log.Logger.Information("Roslyn: {Project} does not compile yet ({Error}), keeping previous metadata", p.Name, first?.GetMessage());
                    return false;
                }
                await File.WriteAllBytesAsync(file, stream.ToArray(), ct);
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
    static void RemoveOtherVersions(string projectDir, string keep) {
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
