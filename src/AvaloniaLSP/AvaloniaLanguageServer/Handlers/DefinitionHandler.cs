using AvaloniaLanguageServer.Services;
using Microsoft.CodeAnalysis;
using OmniSharp.Extensions.LanguageServer.Protocol.Server;
using Location = OmniSharp.Extensions.LanguageServer.Protocol.Models.Location;
using Range = OmniSharp.Extensions.LanguageServer.Protocol.Models.Range;
using Workspace = AvaloniaLanguageServer.Models.Workspace;

namespace AvaloniaLanguageServer.Handlers;

/// <summary>
/// Go to definition from AXAML: x:Class, x:DataType, element types, binding path members (including source-generated
/// members: their generated source is written to a temp file), event handlers and StaticResource/DynamicResource keys.
/// </summary>
public sealed class DefinitionHandler : DefinitionHandlerBase {
    readonly Workspace _workspace;
    readonly TextDocumentSelector _documentSelector;
    readonly Func<ILanguageServer?> _getServer;

    public DefinitionHandler(Workspace workspace, TextDocumentSelector documentSelector, Func<ILanguageServer?> getServer) {
        _workspace = workspace;
        _documentSelector = documentSelector;
        _getServer = getServer;
    }

    protected override DefinitionRegistrationOptions CreateRegistrationOptions(DefinitionCapability capability, ClientCapabilities clientCapabilities) =>
        new() { DocumentSelector = _documentSelector };

    public override async Task<LocationOrLocationLinks?> Handle(DefinitionParams request, CancellationToken cancellationToken) {
        var uri = request.TextDocument.Uri;
        var text = _workspace.BufferService.GetText(uri);
        if (text == null) {
            return new LocationOrLocationLinks();
        }

        if (_workspace.ProjectInfo == null || !_workspace.IsCurrentProject(uri)) {
            await _workspace.InitializeAsync(uri, _getServer()?.Client.ClientSettings.RootPath);
        }

        var compilation = await _workspace.GetCompilationAsync();
        var doc = new XamlDocument(text);
        var analyzer = new XamlAnalyzer(doc, _workspace.CompletionMetadata, compilation);
        var symbol = analyzer.SymbolAt(request.Position);

        IEnumerable<Location> locations = symbol switch {
            TypeReferenceSymbol t => TypeLocations(compilation, t.FullName, Utilities.Utils.FromUri(uri)),
            ElementTypeSymbol e => TypeLocations(compilation, e.Type.FullName, null),
            BindingMemberSymbol b => SymbolLocations(b.Member),
            EventHandlerSymbol h => compilation?.GetTypeByMetadataName(h.ClassFullName)?.GetMembers(h.Method).SelectMany(SymbolLocations) ?? Enumerable.Empty<Location>(),
            ResourceKeySymbol r => analyzer.FindResourceKey(r.Key) is { } range
                ? new[] { new Location { Uri = uri, Range = range } }
                : ResourceInOtherFiles(r.Key, uri),
            _ => Enumerable.Empty<Location>(),
        };
        var list = locations.ToList();
        return new LocationOrLocationLinks(list.Select(l => new LocationOrLocationLink(l)));
    }

    /// <summary>Where a resource key is defined in the workspace's other .axaml files (App.axaml, dictionaries).</summary>
    IEnumerable<Location> ResourceInOtherFiles(string key, DocumentUri current) {
        var root = _getServer()?.Client.ClientSettings.RootPath ?? _workspace.ProjectInfo?.ProjectDirectory;
        foreach (var file in AxamlFiles.All(root, _workspace.BufferService, current)) {
            foreach (var d in ResourceKeys.In(file.Text).Where(d => d.Key == key)) {
                var doc = new XamlDocument(file.Text);
                yield return new Location { Uri = DocumentUri.FromFileSystemPath(file.Path), Range = doc.RangeOf(d.Offset, d.Length) };
            }
        }
    }

    /// <summary>Source locations of a type; without Roslyn (F#) falls back to the code-behind file of the document.</summary>
    static IEnumerable<Location> TypeLocations(Compilation? compilation, string fullName, string? axamlPath) {
        var type = compilation?.GetTypeByMetadataName(fullName);
        if (type != null) {
            return SymbolLocations(type);
        }

        if (axamlPath == null) {
            return Enumerable.Empty<Location>();
        }

        var shortName = fullName.Split('.').Last();
        foreach (var file in new[] { axamlPath + ".cs", axamlPath + ".fs" }.Where(File.Exists)) {
            var lines = File.ReadAllLines(file);
            var line = Array.FindIndex(lines, l => System.Text.RegularExpressions.Regex.IsMatch(l, $@"\b(class|type|record)\s+{shortName}\b"));
            if (line >= 0) {
                return new[] { new Location { Uri = DocumentUri.File(file), Range = new Range(line, 0, line, lines[line].Length) } };
            }
        }
        return Enumerable.Empty<Location>();
    }

    static IEnumerable<Location> SymbolLocations(ISymbol symbol) {
        // partial types: only the user's files when there are any; generated parts (x:Name fields,
        // [ObservableProperty]...) only for members that exist nowhere else
        static bool UserFile(Microsoft.CodeAnalysis.Location l) =>
            File.Exists(l.SourceTree!.FilePath) && !l.SourceTree.FilePath.EndsWith(".g.cs", StringComparison.OrdinalIgnoreCase);
        var inSource = symbol.Locations.Where(l => l.IsInSource).ToList();
        var selected = inSource.Any(UserFile) ? inSource.Where(UserFile) : inSource;
        foreach (var loc in selected) {
            var tree = loc.SourceTree!;
            var path = tree.FilePath;
            if (string.IsNullOrEmpty(path) || !File.Exists(path)) {
                // source generator output: not on disk, write it to a temp file (with a platform-correct path)
                var name = Path.GetFileName(path.Replace('\\', '/').Split('/').Last());
                if (string.IsNullOrEmpty(name)) {
                    name = symbol.Name + ".g.cs";
                }

                var dir = Path.Combine(Path.GetTempPath(), "avalonia-lsp", "generated");
                Directory.CreateDirectory(dir);
                path = Path.Combine(dir, name);
                File.WriteAllText(path, tree.GetText().ToString());
            }
            var span = loc.GetLineSpan();
            yield return new Location {
                Uri = DocumentUri.File(path),
                Range = new Range(span.StartLinePosition.Line, span.StartLinePosition.Character, span.EndLinePosition.Line, span.EndLinePosition.Character),
            };
        }
    }
}
