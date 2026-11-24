using AvaloniaLanguageServer.Services;
using Workspace = AvaloniaLanguageServer.Models.Workspace;

namespace AvaloniaLanguageServer.Handlers;

/// <summary>Element tree for the Outline view, breadcrumbs and Go to Symbol (Ctrl+Shift+O).</summary>
public sealed class DocumentSymbolHandler : DocumentSymbolHandlerBase {
    readonly Workspace _workspace;
    readonly TextDocumentSelector _documentSelector;

    public DocumentSymbolHandler(Workspace workspace, TextDocumentSelector documentSelector) {
        _workspace = workspace;
        _documentSelector = documentSelector;
    }

    protected override DocumentSymbolRegistrationOptions CreateRegistrationOptions(DocumentSymbolCapability capability, ClientCapabilities clientCapabilities) =>
        new() { DocumentSelector = _documentSelector, Label = "AXAML" };

    public override Task<SymbolInformationOrDocumentSymbolContainer?> Handle(DocumentSymbolParams request, CancellationToken cancellationToken) {
        var text = _workspace.BufferService.GetText(request.TextDocument.Uri);
        if (text == null) {
            return Task.FromResult<SymbolInformationOrDocumentSymbolContainer?>(null);
        }

        var doc = new XamlDocument(text);
        var children = new Dictionary<XamlElement, List<DocumentSymbol>>();
        var roots = new List<DocumentSymbol>();
        // children before parents: build bottom-up so each symbol gets its finished child list
        foreach (var el in Enumerable.Reverse(doc.Elements)) {
            var kids = children.TryGetValue(el, out var list) ? Enumerable.Reverse(list).ToList() : new List<DocumentSymbol>();
            var symbol = ToSymbol(doc, el, kids);
            if (el.Parent == null) {
                roots.Insert(0, symbol);
            } else {
                if (!children.TryGetValue(el.Parent, out var siblings)) {
                    children[el.Parent] = siblings = new List<DocumentSymbol>();
                }

                siblings.Add(symbol);
            }
        }

        var container = new SymbolInformationOrDocumentSymbolContainer(roots.Select(r => new SymbolInformationOrDocumentSymbol(r)));
        return Task.FromResult<SymbolInformationOrDocumentSymbolContainer?>(container);
    }

    static DocumentSymbol ToSymbol(XamlDocument doc, XamlElement el, List<DocumentSymbol> children) {
        string? Attr(string name, string? ns = null) =>
            el.Attributes.FirstOrDefault(a => a.LocalName == name && (ns == null ? a.Prefix == "" : a.NamespaceUri == ns))?.Value;

        var key = Attr("Key", XamlDocument.XamlNamespace);
        var name = Attr("Name", XamlDocument.XamlNamespace) ?? Attr("Name");
        // what identifies the element best: a name or key, a style's selector, a setter's property, a binding or text
        var detail = el.LocalName switch {
            "Style" => Attr("Selector"),
            "ControlTheme" => Attr("TargetType"),
            "Setter" => Attr("Property") is { } p ? $"{p} = {Attr("Value")}" : null,
            _ => null,
        } ?? Attr("Content") ?? Attr("Text") ?? Attr("Header") ?? Attr("Title");

        var label = (el.Prefix.Length > 0 ? el.Prefix + ":" : "") + el.LocalName;
        if (name != null) {
            label += " " + name;
        } else if (key != null) {
            label += $" ({key})";
        }

        var start = doc.PositionOf(el.Start);
        var end = doc.PositionOf(Math.Max(el.End, el.Start));
        return new DocumentSymbol {
            Name = label,
            Detail = detail,
            Kind = el.IsPropertyElement ? SymbolKind.Property : key != null ? SymbolKind.Constant : el.LocalName is "Style" or "ControlTheme" or "Setter" ? SymbolKind.Struct : SymbolKind.Class,
            Range = new OmniSharp.Extensions.LanguageServer.Protocol.Models.Range(start, end),
            SelectionRange = el.NameRange,
            Children = children.Count > 0 ? new Container<DocumentSymbol>(children) : null,
        };
    }
}
