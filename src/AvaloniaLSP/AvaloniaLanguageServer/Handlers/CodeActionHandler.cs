using AvaloniaLanguageServer.Models;
using AvaloniaLanguageServer.Services;
using Range = OmniSharp.Extensions.LanguageServer.Protocol.Models.Range;

namespace AvaloniaLanguageServer.Handlers;

/// <summary>Quick fixes for unknown types, properties and binding paths: "Change to 'X'" using the suggestions of the diagnostic.</summary>
public sealed class CodeActionHandler : CodeActionHandlerBase {
    readonly Workspace _workspace;
    readonly TextDocumentSelector _documentSelector;

    public CodeActionHandler(Workspace workspace, TextDocumentSelector documentSelector) {
        _workspace = workspace;
        _documentSelector = documentSelector;
    }

    protected override CodeActionRegistrationOptions CreateRegistrationOptions(CodeActionCapability capability, ClientCapabilities clientCapabilities) =>
        new() { DocumentSelector = _documentSelector, CodeActionKinds = new Container<CodeActionKind>(CodeActionKind.QuickFix), ResolveProvider = false };

    public override async Task<CommandOrCodeActionContainer?> Handle(CodeActionParams request, CancellationToken cancellationToken) {
        var uri = request.TextDocument.Uri;
        var text = _workspace.BufferService.GetText(uri);
        var actions = new List<CommandOrCodeAction>();
        if (text == null) {
            return new CommandOrCodeActionContainer(actions);
        }

        var doc = new XamlDocument(text);
        if (await DesignViewModelActionAsync(doc, uri, request.Range) is { } design) {
            actions.Add(design);
        }

        foreach (var d in request.Context.Diagnostics.Where(d => d.Source == XamlAnalyzer.Source && d.Data != null)) {
            var suggestions = d.Data!["suggestions"]?.ToObject<string[]>() ?? Array.Empty<string>();
            var old = SubText(doc, d.Range);
            foreach (var s in suggestions) {
                var edits = new List<TextEdit> { new() { Range = d.Range, NewText = s } };
                // renaming an element type: also rename the matching end tag
                if (d.Code?.String == "AVLS0002") {
                    var close = FindEndTag(doc, d.Range, old);
                    if (close != null) {
                        edits.Add(new TextEdit { Range = close, NewText = s });
                    }
                }
                actions.Add(new CodeAction {
                    Title = $"Change to '{s}'",
                    Kind = CodeActionKind.QuickFix,
                    Diagnostics = new Container<Diagnostic>(d),
                    IsPreferred = s == suggestions[0],
                    Edit = new WorkspaceEdit { Changes = new Dictionary<DocumentUri, IEnumerable<TextEdit>> { [uri] = edits } },
                });
            }
        }
        return new CommandOrCodeActionContainer(actions);
    }

    /// <summary>
    /// On the root's x:DataType, when its view model has no public parameterless constructor (so the previewer cannot
    /// create it): create a design-time subclass that has one, and use it as Design.DataContext. The extension
    /// writes the file and builds (command axamlLive.createDesignViewModel).
    /// </summary>
    async Task<CodeAction?> DesignViewModelActionAsync(XamlDocument doc, DocumentUri uri, Range range) {
        var root = doc.Elements.FirstOrDefault();
        var dataType = root?.Attributes.FirstOrDefault(a => a.NamespaceUri == XamlDocument.XamlNamespace && a.LocalName == "DataType");
        if (root == null || dataType == null || range.Start.Line > dataType.ValueRange.End.Line || range.End.Line < dataType.NameRange.Start.Line) {
            return null;
        }

        bool hasDesignContext = root.Attributes.Any(a => a.LocalName == "DataContext" && a.Prefix == "Design")
            || doc.Elements.Any(e => e.Parent == root && e.LocalName == "Design.DataContext");
        var colon = dataType.Value.IndexOf(':');
        if (hasDesignContext || colon <= 0) {
            return null;
        }

        var prefix = dataType.Value[..colon];
        var compilation = await _workspace.GetCompilationAsync();
        var symbol = new XamlAnalyzer(doc, _workspace.CompletionMetadata, compilation).SymbolAt(dataType.ValueRange.Start);
        var type = symbol is TypeReferenceSymbol t ? compilation?.GetTypeByMetadataName(t.FullName) : null;
        if (type == null || type.IsAbstract || type.IsSealed || type.IsStatic || type.IsGenericType || type.ContainingType != null) {
            return null;
        }

        bool hasParameterless = type.InstanceConstructors.Any(c => c.Parameters.Length == 0 && c.DeclaredAccessibility == Microsoft.CodeAnalysis.Accessibility.Public);
        var ctor = type.InstanceConstructors
            .Where(c => c.DeclaredAccessibility is Microsoft.CodeAnalysis.Accessibility.Public or Microsoft.CodeAnalysis.Accessibility.Protected)
            .OrderBy(c => c.Parameters.Length).FirstOrDefault();
        var source = type.Locations.FirstOrDefault(l => l.IsInSource && File.Exists(l.SourceTree?.FilePath))?.SourceTree?.FilePath;
        if (hasParameterless || ctor == null || source == null) {
            return null;
        }

        var ns = type.ContainingNamespace.IsGlobalNamespace ? null : type.ContainingNamespace.ToDisplayString();
        var name = "Design" + type.Name;
        var file = Path.Combine(Path.GetDirectoryName(source)!, name + ".cs");
        var args = string.Join(", ", ctor.Parameters.Select(_ => "default!"));
        var view = Path.GetFileName(Utilities.Utils.FromUri(uri));
        var content =
            (ns != null ? $"namespace {ns};\n\n" : "") +
            $"/// <summary>Sample data for the XAML previewer (Design.DataContext of {view}); not used by the app.</summary>\n" +
            $"public class {name} : {type.Name} {{\n" +
            $"    public {name}() : base({args}) {{\n" +
            "        // set sample values here\n" +
            "    }\n" +
            "}\n";

        // after the root start tag, indented like the first child
        int tagEnd = doc.Text.IndexOf('>', doc.OffsetOf(dataType.ValueRange.End.Line, dataType.ValueRange.End.Character)) + 1;
        var after = doc.Text[tagEnd..];
        var indent = System.Text.RegularExpressions.Regex.Match(after, @"^\s*?\n([ \t]*)\S").Groups[1].Value;
        if (indent.Length == 0) {
            indent = "    ";
        }

        var newline = doc.Text.Contains("\r\n") ? "\r\n" : "\n";
        var insertion = $"{newline}{indent}<Design.DataContext>{newline}{indent}    <{prefix}:{name} />{newline}{indent}</Design.DataContext>";
        var at = doc.PositionOf(tagEnd);
        return new CodeAction {
            Title = $"Create a design-time view model ({name}) for the previewer",
            Kind = CodeActionKind.QuickFix,
            Command = Command.Create("axamlLive.createDesignViewModel", new {
                file,
                content,
                uri = uri.ToString(),
                line = at.Line,
                character = at.Character,
                text = insertion,
            }),
        };
    }

    public override Task<CodeAction> Handle(CodeAction request, CancellationToken cancellationToken) => Task.FromResult(request);

    static string SubText(XamlDocument doc, Range r) {
        int start = doc.OffsetOf(r.Start.Line, r.Start.Character);
        int end = doc.OffsetOf(r.End.Line, r.End.Character);
        return doc.Text.Substring(start, Math.Max(0, end - start));
    }

    /// <summary>Range of the name in the matching `&lt;/[prefix:]Name>` (same nesting level), if the element is not self-closing.</summary>
    static Range? FindEndTag(XamlDocument doc, Range nameRange, string name) {
        int nameStart = doc.OffsetOf(nameRange.Start.Line, nameRange.Start.Character);
        int lt = doc.Text.LastIndexOf('<', nameStart);
        if (lt < 0) {
            return null;
        }

        var qualified = doc.Text.Substring(lt + 1, nameStart - lt - 1) + name; // includes the prefix
        int gt = doc.Text.IndexOf('>', nameStart);
        if (gt < 0 || doc.Text[gt - 1] == '/') {
            return null;
        }

        int depth = 0;
        for (int i = gt + 1; i < doc.Text.Length; i++) {
            if (doc.Text[i] != '<') {
                continue;
            }

            if (string.CompareOrdinal(doc.Text, i + 1, qualified, 0, qualified.Length) == 0 && !char.IsLetterOrDigit(doc.Text[i + 1 + qualified.Length])) {
                int end = doc.Text.IndexOf('>', i);
                if (end > 0 && doc.Text[end - 1] != '/') {
                    depth++;
                }
            } else if (doc.Text.AsSpan(i).StartsWith("</" + qualified) && !char.IsLetterOrDigit(doc.Text[i + 2 + qualified.Length])) {
                if (depth == 0) {
                    return doc.RangeOf(i + 2 + qualified.Length - name.Length, name.Length);
                }

                depth--;
            }
        }
        return null;
    }
}
