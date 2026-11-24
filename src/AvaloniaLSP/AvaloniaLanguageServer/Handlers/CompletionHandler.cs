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

        var ctx = await _workspace.ContextAsync(request.TextDocument.Uri, _getServer()?.Client.ClientSettings.RootPath, compile: false);
        cancellationToken.ThrowIfCancellationRequested();
        var metadata = ctx.Metadata;
        var fullText = _workspace.BufferService.GetText(request.TextDocument.Uri) ?? text;
        var fullDoc = new XamlDocument(fullText);
        // "text" joins lines with "\n"; offsets into the document (CRLF files) come from the position
        int cursor = fullDoc.OffsetOf(request.Position.Line, request.Position.Character);

        var style = StyleCompletion.Complete(text, fullText, cursor, metadata,
            () => AxamlFiles.All(RootPath, _workspace.BufferService, request.TextDocument.Uri));
        if (style != null) {
            return Replacing(style.Items, text, style.Start, request.Position);
        }

        var bindingPath = BindingPath.Match(text.Length > 2000 ? text[^2000..] : text);
        if (bindingPath.Success) {
            var compilation = ctx.Project == null ? null : await _workspace.Roslyn.GetCompilationAsync(ctx.Project.ProjectPath);
            var prefix = bindingPath.Groups["path"].Value;
            var members = new XamlAnalyzer(fullDoc, metadata, compilation).BindingMembersAt(cursor, prefix);
            if (members != null) {
                var items = members.Select(m => new CompletionItem {
                    Label = m.Name,
                    Kind = CompletionItemKind.Property,
                    Detail = (m as Microsoft.CodeAnalysis.IPropertySymbol)?.Type.ToDisplayString(Microsoft.CodeAnalysis.SymbolDisplayFormat.MinimallyQualifiedFormat),
                    SortText = "0" + m.Name,
                }).ToList();
                // at the start of the path the engine adds Mode, Converter, ElementName, $parent...
                if (prefix.Length == 0 && metadata != null && _completionEngine.GetCompletions(metadata, text, text.Length) is { } keywords) {
                    items.AddRange(keywords.Completions
                        .Where(k => !items.Any(i => i.Label == k.DisplayText) && !string.IsNullOrWhiteSpace(k.DisplayText) && !k.DisplayText.Contains('`'))
                        .Select(k => new CompletionItem { Label = k.DisplayText, Detail = k.Description, Kind = GetCompletionItemKind(k.Kind), SortText = "1" + k.DisplayText }));
                }
                return Replacing(items, text, text.Length - bindingPath.Groups["w"].Value.Length, request.Position);
            }
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
            .Where(p => !string.IsNullOrWhiteSpace(p.DisplayText) && !p.DisplayText.Contains('`'))
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

    public CompletionHandler(Workspace workspace, TextDocumentSelector documentSelector, Func<ILanguageServer?> getServer) {
        _workspace = workspace;
        _documentSelector = documentSelector;
        _getServer = getServer;

        _completionEngine = new CompletionEngine();
    }

    /// <summary>The path typed so far in {Binding ...}, {CompiledBinding ...} or Path=, and the member being typed.</summary>
    static readonly System.Text.RegularExpressions.Regex BindingPath = new(
        @"\{\s*(?:Binding|CompiledBinding|x:Bind)\s+(?:Path\s*=\s*)?(?<path>(?:[A-Za-z_]\w*\.)*)(?<w>[A-Za-z_]\w*)?$",
        System.Text.RegularExpressions.RegexOptions.Compiled);

    /// <summary>Items that replace the text from <paramref name="start"/> (an offset into the text before the cursor).</summary>
    static CompletionList Replacing(IEnumerable<CompletionItem> items, string text, int start, Position cursor) {
        var range = new OmniSharp.Extensions.LanguageServer.Protocol.Models.Range(OffsetToPosition(text, start), cursor);
        return new CompletionList(items.Select(i => i with {
            FilterText = i.Label,
            TextEdit = new TextEditOrInsertReplaceEdit(new TextEdit { Range = range, NewText = i.InsertText ?? i.Label }),
        }), isIncomplete: false);
    }

    string? RootPath => _getServer()?.Client.ClientSettings.RootPath ?? _workspace.LastProject?.ProjectDirectory;

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
