using Avalonia.Ide.CompletionEngine;
using AvaloniaLanguageServer.Services;
using AvaloniaLanguageServer.Models;
using OmniSharp.Extensions.LanguageServer.Protocol.Server;

namespace AvaloniaLanguageServer.Handlers;

public class CompletionHandler : CompletionHandlerBase {
    public override Task<CompletionItem> Handle(CompletionItem request, CancellationToken cancellationToken) {
        if (request.InsertText == null || !NeedResolve()) {
            return Task.FromResult(request);
        }

        // keep TextEdit/FilterText etc. from the original item
        var ci = request with {
            Command = Command.Create("axamlLive.InsertProperty", new { repositionCaret = RepositionCaret() })
        };

        return Task.FromResult(ci);

        bool NeedResolve() => request.InsertText!.EndsWith(".") || request.InsertText!.EndsWith("\"");
        bool RepositionCaret() => request.InsertText!.EndsWith("\"\"");
    }

    public override async Task<CompletionList> Handle(CompletionParams request, CancellationToken cancellationToken) {
        string? text = _workspace.BufferService.GetTextTillPosition(request.TextDocument.Uri, request.Position);
        if (text == null) {
            return new CompletionList();
        }

        var metadata = await InitializeCompletionEngineAsync(request.TextDocument.Uri);

        var style = StyleCompletion.Complete(text, _workspace.BufferService.GetText(request.TextDocument.Uri) ?? text, metadata,
            () => OtherAxamlFiles(request.TextDocument.Uri));
        if (style != null) {
            var styleRange = new OmniSharp.Extensions.LanguageServer.Protocol.Models.Range(OffsetToPosition(text, style.Start), request.Position);
            return new CompletionList(style.Items.Select(i => i with {
                FilterText = i.Label,
                TextEdit = new TextEditOrInsertReplaceEdit(new TextEdit { Range = styleRange, NewText = i.Label }),
            }), isIncomplete: false);
        }

        if (metadata == null) {
            return new CompletionList(new[] {
                new CompletionItem {
                    Label = "Build the project",
                    Documentation = new StringOrMarkupContent("Build the project to enable code completion"),
                    Kind = CompletionItemKind.Event,
                    Command = Command.Create("axamlLive.createPreviewerAssets", new { triggerCodeComplete = true }),
                    InsertText = " "
                }
            });
        }

        var set = _completionEngine.GetCompletions(metadata!, text, text.Length);

        // The engine reports where the completed token starts (e.g. at "/" for "</Grid>" or at "vm:" for "<vm:Foo").
        // Without an explicit range VS Code only replaces the current word, which produced "<//Grid>" (#166).
        var range = set == null ? null : new OmniSharp.Extensions.LanguageServer.Protocol.Models.Range(OffsetToPosition(text, set.StartPosition), request.Position);

        var completions = set?.Completions
            .Where(p => !p.DisplayText.Contains('`'))
            .Select(p => new CompletionItem {
                Label = p.DisplayText,
                Detail = p.Description,
                InsertText = p.InsertText,
                FilterText = p.InsertText,
                TextEdit = range == null ? null : new TextEditOrInsertReplaceEdit(new TextEdit { Range = range, NewText = p.InsertText }),
                Kind = GetCompletionItemKind(p.Kind),
            });


        if (completions == null) {
            return new CompletionList(true);
        }

        return new CompletionList(completions, isIncomplete: false);
    }

    protected override CompletionRegistrationOptions CreateRegistrationOptions
        (CompletionCapability capability, ClientCapabilities clientCapabilities) {
        return new() {
            DocumentSelector = _documentSelector,
            TriggerCharacters = new Container<string>(_triggerChars),
            AllCommitCharacters = new Container<string>("\n"),
            ResolveProvider = true
        };
    }

    async Task<Metadata?> InitializeCompletionEngineAsync(DocumentUri uri) {
        // the workspace is shared by all documents: re-target when the document is from another project
        if (_workspace.ProjectInfo == null || !_workspace.IsCurrentProject(uri)) {
            await _workspace.InitializeAsync(uri, _getServer()?.Client.ClientSettings.RootPath);
        } else {
            _workspace.RefreshMetadataIfNeeded();
        }

        return _workspace.CompletionMetadata;
    }

    public CompletionHandler(Workspace workspace, TextDocumentSelector documentSelector, Func<ILanguageServer?> getServer) {
        _workspace = workspace;
        _documentSelector = documentSelector;
        _getServer = getServer;

        _completionEngine = new CompletionEngine();
    }

    readonly Dictionary<string, (DateTime Stamp, string Text)> _axamlCache = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>The other .axaml files of the workspace (open editors first), for style classes defined there.</summary>
    IEnumerable<(string Name, string Text)> OtherAxamlFiles(DocumentUri current) {
        var root = _getServer()?.Client.ClientSettings.RootPath ?? _workspace.ProjectInfo?.ProjectDirectory;
        if (root == null || !Directory.Exists(root)) {
            yield break;
        }

        var currentPath = Utilities.Utils.FromUri(current);
        IEnumerable<string> files;
        try {
            files = Directory.EnumerateFiles(root, "*.axaml", SearchOption.AllDirectories)
                .Where(f => !f.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}") && !f.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}"))
                .Take(500).ToList();
        } catch (Exception) {
            yield break;
        }

        foreach (var file in files) {
            var uri = DocumentUri.FromFileSystemPath(file);
            if (uri == current || string.Equals(Path.GetFullPath(file), Path.GetFullPath(currentPath), StringComparison.OrdinalIgnoreCase)) {
                continue;
            }

            var open = _workspace.BufferService.GetText(uri);
            if (open != null) {
                yield return (Path.GetFileName(file), open);
                continue;
            }

            string? text = null;
            try {
                var stamp = File.GetLastWriteTimeUtc(file);
                if (!_axamlCache.TryGetValue(file, out var cached) || cached.Stamp != stamp) {
                    cached = (stamp, File.ReadAllText(file));
                    _axamlCache[file] = cached;
                }

                text = cached.Text;
            } catch (IOException) {
                // being written: skipped this time
            }

            if (text != null) {
                yield return (Path.GetFileName(file), text);
            }
        }
    }

    static Position OffsetToPosition(string text, int offset) {
        offset = Math.Clamp(offset, 0, text.Length);
        int line = 0, lineStart = 0;
        for (int i = 0; i < offset; i++) {
            if (text[i] == (char)10) {
                line++;
                lineStart = i + 1;
            }
        }
        return new Position(line, offset - lineStart);
    }

    static CompletionItemKind GetCompletionItemKind(CompletionKind completionKind) {
        string name = Enum.GetName(completionKind) ?? string.Empty;

        var result = name switch {
            _ when name.Contains("Property") || name.Contains("AttachedProperty") => CompletionItemKind.Property,
            _ when name.Contains("Event") => CompletionItemKind.Event,
            _ when name.Contains("Namespace") || name.Contains("VS_XMLNS") => CompletionItemKind.Module,
            _ when name.Contains("MarkupExtension") => CompletionItemKind.Class,
            _ => GetRest(name)
        };

        return result;

        CompletionItemKind GetRest(string enumName) {
            bool success = Enum.TryParse(enumName, out CompletionItemKind kind);
            return success ? kind : CompletionItemKind.Text;
        }
    }

    readonly Workspace _workspace;
    readonly TextDocumentSelector _documentSelector;
    readonly Func<ILanguageServer?> _getServer;

    readonly CompletionEngine _completionEngine;

    readonly string[] _triggerChars = { "\'", "\"", " ", "<", ".", "[", "(", "#", "|", "/", "{" };
}
