using System.Text.RegularExpressions;
using AvaloniaLanguageServer.Services;
using Microsoft.CodeAnalysis;
using OmniSharp.Extensions.LanguageServer.Protocol.Server;
using Workspace = AvaloniaLanguageServer.Models.Workspace;

namespace AvaloniaLanguageServer.Handlers;

/// <summary>Hover for element types, properties/events, binding path members, x:Class/x:DataType and resources.</summary>
public sealed class HoverHandler : HoverHandlerBase {
    readonly Workspace _workspace;
    readonly TextDocumentSelector _documentSelector;
    readonly Func<ILanguageServer?> _getServer;

    public HoverHandler(Workspace workspace, TextDocumentSelector documentSelector, Func<ILanguageServer?> getServer) {
        _workspace = workspace;
        _documentSelector = documentSelector;
        _getServer = getServer;
    }

    protected override HoverRegistrationOptions CreateRegistrationOptions(HoverCapability capability, ClientCapabilities clientCapabilities) =>
        new() { DocumentSelector = _documentSelector };

    public override async Task<Hover?> Handle(HoverParams request, CancellationToken cancellationToken) {
        var text = _workspace.BufferService.GetText(request.TextDocument.Uri);
        if (text == null) {
            return null;
        }

        var ctx = await _workspace.ContextAsync(request.TextDocument.Uri, _getServer()?.Client.ClientSettings.RootPath);
        var compilation = ctx.Compilation;
        var analyzer = new XamlAnalyzer(new XamlDocument(text), ctx.Metadata, compilation);
        var symbol = analyzer.SymbolAt(request.Position);
        if (symbol == null) {
            return null;
        }

        string? markdown = symbol switch {
            ElementTypeSymbol e => Code($"class {e.Type.FullName}") + Docs(compilation?.GetTypeByMetadataName(e.Type.FullName)),
            TypeReferenceSymbol t => Code($"class {t.FullName}") + Docs(compilation?.GetTypeByMetadataName(t.FullName)),
            PropertySymbol p => PropertyHover(p, compilation),
            BindingMemberSymbol b => Code(b.Member.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat)) + Docs(b.Member),
            EventHandlerSymbol h => Code($"void {h.ClassFullName}.{h.Method}(object? sender, ...)") + "\n\nEvent handler in the code-behind.",
            ResourceKeySymbol r => ResourceHover(r.Key, text, request.TextDocument.Uri),
            _ => null,
        };
        return markdown == null ? null : new Hover {
            Range = symbol.Range,
            Contents = new MarkedStringsOrMarkupContent(new MarkupContent { Kind = MarkupKind.Markdown, Value = markdown }),
        };
    }

    static string PropertyHover(PropertySymbol p, Compilation? compilation) {
        var owner = compilation?.GetTypeByMetadataName(p.Owner.FullName);
        ISymbol? member = null;
        for (var t = owner; t != null && member == null; t = t.BaseType) {
            member = t.GetMembers(p.Name).FirstOrDefault(m => m is IPropertySymbol or IEventSymbol) ?? t.GetMembers(p.Name + "Property").FirstOrDefault();
        }

        string kind = p.Event != null ? "event" : p.Attached ? "attached property" : "property";
        string type = member switch {
            IPropertySymbol ps => ps.Type.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat),
            IEventSymbol es => es.Type.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat),
            _ => p.Property?.Type?.Name ?? p.Event?.Type?.Name ?? "",
        };
        return Code($"{type} {p.Owner.Name}.{p.Name}".Trim()) + $"\n\n*{kind}* of `{p.Owner.FullName}`" + Docs(member);
    }

    /// <summary>The element that defines a resource key: this file, the workspace's other .axaml files, or a theme.</summary>
    string ResourceHover(string key, string text, DocumentUri uri) {
        var here = ResourceKeys.In(text).FirstOrDefault(d => d.Key == key);
        if (here != null) {
            return Code(here.Source, "xml") + "\n\nResource in this file";
        }

        var root = _getServer()?.Client.ClientSettings.RootPath ?? _workspace.LastProject?.ProjectDirectory;
        foreach (var file in AxamlFiles.All(root, _workspace.BufferService, uri)) {
            var d = ResourceKeys.In(file.Text).FirstOrDefault(d => d.Key == key);
            if (d != null) {
                return Code(d.Source, "xml") + $"\n\nResource in {file.Name}";
            }
        }

        var theme = ResourceKeys.Theme.FirstOrDefault(t => t.Key == key);
        return theme.Key != null ? $"Resource `{key}` of the {theme.Theme} theme" : $"Resource `{key}`";
    }

    static string Code(string s, string language = "csharp") => $"```{language}\n{s}\n```";

    static string Docs(ISymbol? symbol) {
        var xml = symbol?.GetDocumentationCommentXml();
        if (string.IsNullOrWhiteSpace(xml)) {
            return "";
        }

        var m = Regex.Match(xml, @"<summary>([\s\S]*?)</summary>");
        if (!m.Success) {
            return "";
        }

        var summary = Regex.Replace(m.Groups[1].Value, @"<(?:see|seealso)\s+(?:cref|langword)=""(?:\w:)?([^""]+)""\s*/>", "`$1`");
        summary = Regex.Replace(summary, @"<[^>]+>", "");
        summary = Regex.Replace(summary, @"\s+", " ").Trim();
        return summary.Length > 0 ? "\n\n" + summary : "";
    }
}
