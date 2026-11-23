using System.Text.RegularExpressions;
using Workspace = AvaloniaLanguageServer.Models.Workspace;
using AvaloniaLanguageServer.Services;
using Microsoft.CodeAnalysis;
using OmniSharp.Extensions.LanguageServer.Protocol.Server;

namespace AvaloniaLanguageServer.Handlers;

/// <summary>Hover for element types, properties/events, binding path members, x:Class/x:DataType and resources.</summary>
public sealed class HoverHandler : HoverHandlerBase
{
    readonly Workspace _workspace;
    readonly DocumentSelector _documentSelector;
    readonly Func<ILanguageServer?> _getServer;

    public HoverHandler(Workspace workspace, DocumentSelector documentSelector, Func<ILanguageServer?> getServer)
    {
        _workspace = workspace;
        _documentSelector = documentSelector;
        _getServer = getServer;
    }

    protected override HoverRegistrationOptions CreateRegistrationOptions(HoverCapability capability, ClientCapabilities clientCapabilities) =>
        new() { DocumentSelector = _documentSelector };

    public override async Task<Hover?> Handle(HoverParams request, CancellationToken cancellationToken)
    {
        var text = _workspace.BufferService.GetText(request.TextDocument.Uri);
        if (text == null)
            return null;
        if (_workspace.ProjectInfo == null || !_workspace.IsCurrentProject(request.TextDocument.Uri))
            await _workspace.InitializeAsync(request.TextDocument.Uri, _getServer()?.Client.ClientSettings.RootPath);
        var compilation = await _workspace.GetCompilationAsync();
        var analyzer = new XamlAnalyzer(new XamlDocument(text), _workspace.CompletionMetadata, compilation);
        var symbol = analyzer.SymbolAt(request.Position);
        if (symbol == null)
            return null;

        string? markdown = symbol switch
        {
            ElementTypeSymbol e => Code($"class {e.Type.FullName}") + Docs(compilation?.GetTypeByMetadataName(e.Type.FullName)),
            TypeReferenceSymbol t => Code($"class {t.FullName}") + Docs(compilation?.GetTypeByMetadataName(t.FullName)),
            PropertySymbol p => PropertyHover(p, compilation),
            BindingMemberSymbol b => Code(b.Member.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat)) + Docs(b.Member),
            EventHandlerSymbol h => Code($"void {h.ClassFullName}.{h.Method}(object? sender, ...)") + "\n\nEvent handler in the code-behind.",
            ResourceKeySymbol r => $"Resource `{r.Key}`",
            _ => null,
        };
        return markdown == null ? null : new Hover
        {
            Range = symbol.Range,
            Contents = new MarkedStringsOrMarkupContent(new MarkupContent { Kind = MarkupKind.Markdown, Value = markdown }),
        };
    }

    static string PropertyHover(PropertySymbol p, Compilation? compilation)
    {
        var owner = compilation?.GetTypeByMetadataName(p.Owner.FullName);
        ISymbol? member = null;
        for (var t = owner; t != null && member == null; t = t.BaseType)
            member = t.GetMembers(p.Name).FirstOrDefault(m => m is IPropertySymbol or IEventSymbol) ?? t.GetMembers(p.Name + "Property").FirstOrDefault();
        string kind = p.Event != null ? "event" : p.Attached ? "attached property" : "property";
        string type = member switch
        {
            IPropertySymbol ps => ps.Type.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat),
            IEventSymbol es => es.Type.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat),
            _ => p.Property?.Type?.Name ?? p.Event?.Type?.Name ?? "",
        };
        return Code($"{type} {p.Owner.Name}.{p.Name}".Trim()) + $"\n\n*{kind}* of `{p.Owner.FullName}`" + Docs(member);
    }

    static string Code(string s) => $"```csharp\n{s}\n```";

    static string Docs(ISymbol? symbol)
    {
        var xml = symbol?.GetDocumentationCommentXml();
        if (string.IsNullOrWhiteSpace(xml))
            return "";
        var m = Regex.Match(xml, @"<summary>([\s\S]*?)</summary>");
        if (!m.Success)
            return "";
        var summary = Regex.Replace(m.Groups[1].Value, @"<(?:see|seealso)\s+(?:cref|langword)=""(?:\w:)?([^""]+)""\s*/>", "`$1`");
        summary = Regex.Replace(summary, @"<[^>]+>", "");
        summary = Regex.Replace(summary, @"\s+", " ").Trim();
        return summary.Length > 0 ? "\n\n" + summary : "";
    }
}
