
using System.Text.Json;
using Avalonia.Ide.CompletionEngine;
using Avalonia.Ide.CompletionEngine.AssemblyMetadata;
using Avalonia.Ide.CompletionEngine.DnlibMetadataProvider;
using AvaloniaLanguageServer.Services;
using AvaloniaLanguageServer.Utilities;


namespace AvaloniaLanguageServer.Models;

public class Workspace
{
    public ProjectInfo? ProjectInfo { get; private set; }
    public BufferService BufferService { get; } = new();
    public RoslynProjects Roslyn { get; } = new();

    /// <summary>Raised when completion metadata changed (build or live compilation): diagnostics are recomputed.</summary>
    public event Action? MetadataChanged;

    Metadata? _builtMetadata;
    Metadata? _liveMetadata;
    int _liveVersion = -1;
    DateTime _liveTime;
    string? _liveProject;
    readonly SemaphoreSlim _liveLock = new(1, 1);

    public Workspace()
    {
        Roslyn.Changed += () => RefreshLiveAsync().FireAndForget();
    }

    /// <summary>
    /// Metadata from an in-memory compilation of the current project (sources + generators, no build needed),
    /// falling back to the built assembly.
    /// </summary>
    public Metadata? CompletionMetadata
    {
        get
        {
            var live = _liveProject == ProjectInfo?.ProjectPath ? _liveMetadata : null;
            if (live == null)
                return _builtMetadata;
            if (_builtMetadata == null)
                return live;
            // whichever is newer: the build (complete, includes XAML-generated code) or the live compilation of sources
            return _metadataStamp > _liveTime ? _builtMetadata : live;
        }
    }

    public Task<Microsoft.CodeAnalysis.Compilation?> GetCompilationAsync() =>
        ProjectInfo == null ? Task.FromResult<Microsoft.CodeAnalysis.Compilation?>(null) : Roslyn.GetCompilationAsync(ProjectInfo.ProjectPath);

    public async Task RefreshLiveAsync()
    {
        var project = ProjectInfo?.ProjectPath;
        if (project == null)
            return;
        await _liveLock.WaitAsync();
        try
        {
            if (project == _liveProject && Roslyn.Version == _liveVersion && _liveMetadata != null)
                return;
            var version = Roslyn.Version;
            var paths = await Roslyn.EmitForMetadataAsync(project);
            if (paths == null)
                return;
            var metadata = MetadataConverter.ConvertMetadata(new DnlibMetadataProvider().GetMetadata(paths));
            _liveMetadata = metadata;
            _liveProject = project;
            _liveVersion = version;
            _liveTime = DateTime.UtcNow;
            Log.Logger.Information("Live completion metadata for {Project} (version {Version})", project, version);
        }
        catch (Exception e)
        {
            Log.Logger.Warning(e, "Live metadata failed for {Project}", project);
            return;
        }
        finally
        {
            _liveLock.Release();
        }
        MetadataChanged?.Invoke();
    }

    string? _rootPath;
    string? _metadataAssembly;
    DateTime _metadataStamp;
    string? _dataFile;
    DateTime _dataStamp;
    SolutionData? _data;

    /// <summary>True when the document belongs to the project the current metadata was loaded for.</summary>
    public bool IsCurrentProject(DocumentUri uri)
    {
        if (ProjectInfo == null)
            return false;
        var path = Utilities.Utils.FromUri(uri);
        return path.StartsWith(ProjectInfo.ProjectDirectory + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    }

    public async Task InitializeAsync(DocumentUri uri, string? RootPath)
    {
        try
        {
            _rootPath = RootPath;
            var previous = ProjectInfo?.ProjectPath;
            ProjectInfo = await ProjectInfo.GetProjectInfoAsync(uri);
            RefreshMetadataIfNeeded();
            if (ProjectInfo?.ProjectPath != previous || _liveMetadata == null)
                RefreshLiveAsync().FireAndForget();
        }
        catch (Exception e)
        {
            throw new Exception($"Failed to initialize workspace: {uri}", e);
        }
    }

    /// <summary>
    /// Reloads completion metadata when the target assembly was rebuilt (#29, #179),
    /// so new view model properties etc. show up without restarting VS Code.
    /// </summary>
    public void RefreshMetadataIfNeeded(bool force = false)
    {
        var assembly = GetTargetAssembly(_rootPath);
        if (assembly == null || !File.Exists(assembly))
        {
            _builtMetadata = null;
            _metadataAssembly = null;
            return;
        }

        var stamp = File.GetLastWriteTimeUtc(assembly);
        if (!force && _builtMetadata != null && assembly == _metadataAssembly && stamp == _metadataStamp)
            return;

        try
        {
            _builtMetadata = _metadataReader.GetForTargetAssembly(assembly);
            _metadataAssembly = assembly;
            _metadataStamp = stamp;
            Log.Logger.Information("Completion metadata loaded for {Assembly}", assembly);
            MetadataChanged?.Invoke();
        }
        catch (Exception e)
        {
            // the assembly can be mid-write during a build; retry on next request
            Log.Logger.Warning(e, "Failed to load completion metadata for {Assembly}", assembly);
        }
    }

    string? GetTargetAssembly(string? rootPath)
    {
        var dataFile = GetSolutionDataFile(rootPath);
        if (dataFile == null || !File.Exists(dataFile))
            return null;

        try
        {
            var stamp = File.GetLastWriteTimeUtc(dataFile);
            if (dataFile != _dataFile || stamp != _dataStamp)
            {
                _data = JsonSerializer.Deserialize<SolutionData>(File.ReadAllText(dataFile));
                _dataFile = dataFile;
                _dataStamp = stamp;
            }

            // first candidate that has been built
            return _data?.GetCompletionTargets(ProjectInfo?.ProjectPath)
                .Select(p => p.TargetPath)
                .FirstOrDefault(File.Exists);
        }
        catch (Exception e)
        {
            Log.Logger.Warning(e, "Failed to read solution data {File}", dataFile);
            return null;
        }
    }

    static string? GetSolutionDataFile(string? rootPath)
    {
        // provided by the VS Code extension, workspace specific
        var fromClient = Environment.GetEnvironmentVariable("AVALONIA_SOLUTION_DATA");
        if (!string.IsNullOrEmpty(fromClient))
            return fromClient;

        if (rootPath == null)
            return null;

        // legacy location written by SolutionParser: %TEMP%/<solution file name or folder name>.json
        // GetFileName (not GetFileNameWithoutExtension) to match the parser for names with dots (#171)
        var slnFile = SolutionName(rootPath) ?? Path.GetFileName(rootPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        return Path.Combine(Path.GetTempPath(), $"{slnFile}.json");
    }

    static string? SolutionName(string rootPath)
    {
        return Directory.EnumerateFiles(rootPath, "*.sln", SearchOption.TopDirectoryOnly)
            .Concat(Directory.EnumerateFiles(rootPath, "*.slnx", SearchOption.TopDirectoryOnly))
            .Select(Path.GetFileName)
            .FirstOrDefault();
    }

    readonly MetadataReader _metadataReader = new(new DnlibMetadataProvider());
}
