
using System.Text.Json;
using Avalonia.Ide.CompletionEngine;
using Avalonia.Ide.CompletionEngine.AssemblyMetadata;
using Avalonia.Ide.CompletionEngine.DnlibMetadataProvider;
using AvaloniaLanguageServer.Services;


namespace AvaloniaLanguageServer.Models;

public class Workspace
{
    public ProjectInfo? ProjectInfo { get; private set; }
    public BufferService BufferService { get; } = new();

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
            ProjectInfo = await ProjectInfo.GetProjectInfoAsync(uri);
            RefreshMetadataIfNeeded();
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
            CompletionMetadata = null;
            _metadataAssembly = null;
            return;
        }

        var stamp = File.GetLastWriteTimeUtc(assembly);
        if (!force && CompletionMetadata != null && assembly == _metadataAssembly && stamp == _metadataStamp)
            return;

        try
        {
            CompletionMetadata = _metadataReader.GetForTargetAssembly(assembly);
            _metadataAssembly = assembly;
            _metadataStamp = stamp;
            Log.Logger.Information("Completion metadata loaded for {Assembly}", assembly);
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

    public Metadata? CompletionMetadata { get; private set; }
    readonly MetadataReader _metadataReader = new(new DnlibMetadataProvider());
}
