using AvaloniaLanguageServer.Models;
using AvaloniaLanguageServer.Services;
using Range = OmniSharp.Extensions.LanguageServer.Protocol.Models.Range;

namespace AvaloniaLanguageServer.Handlers;

/// <summary>Quick fixes for unknown types, properties and binding paths: "Change to 'X'" using the suggestions of the diagnostic.</summary>
public sealed class CodeActionHandler : CodeActionHandlerBase
{
    readonly Workspace _workspace;
    readonly DocumentSelector _documentSelector;

    public CodeActionHandler(Workspace workspace, DocumentSelector documentSelector)
    {
        _workspace = workspace;
        _documentSelector = documentSelector;
    }

    protected override CodeActionRegistrationOptions CreateRegistrationOptions(CodeActionCapability capability, ClientCapabilities clientCapabilities) =>
        new() { DocumentSelector = _documentSelector, CodeActionKinds = new Container<CodeActionKind>(CodeActionKind.QuickFix), ResolveProvider = false };

    public override Task<CommandOrCodeActionContainer?> Handle(CodeActionParams request, CancellationToken cancellationToken)
    {
        var uri = request.TextDocument.Uri;
        var text = _workspace.BufferService.GetText(uri);
        var actions = new List<CommandOrCodeAction>();
        if (text == null)
            return Task.FromResult<CommandOrCodeActionContainer?>(new CommandOrCodeActionContainer(actions));
        var doc = new XamlDocument(text);

        foreach (var d in request.Context.Diagnostics.Where(d => d.Source == XamlAnalyzer.Source && d.Data != null))
        {
            var suggestions = d.Data!["suggestions"]?.ToObject<string[]>() ?? Array.Empty<string>();
            var old = SubText(doc, d.Range);
            foreach (var s in suggestions)
            {
                var edits = new List<TextEdit> { new() { Range = d.Range, NewText = s } };
                // renaming an element type: also rename the matching end tag
                if (d.Code?.String == "AVLS0002")
                {
                    var close = FindEndTag(doc, d.Range, old);
                    if (close != null)
                        edits.Add(new TextEdit { Range = close, NewText = s });
                }
                actions.Add(new CodeAction
                {
                    Title = $"Change to '{s}'",
                    Kind = CodeActionKind.QuickFix,
                    Diagnostics = new Container<Diagnostic>(d),
                    IsPreferred = s == suggestions[0],
                    Edit = new WorkspaceEdit { Changes = new Dictionary<DocumentUri, IEnumerable<TextEdit>> { [uri] = edits } },
                });
            }
        }
        return Task.FromResult<CommandOrCodeActionContainer?>(new CommandOrCodeActionContainer(actions));
    }

    public override Task<CodeAction> Handle(CodeAction request, CancellationToken cancellationToken) => Task.FromResult(request);

    static string SubText(XamlDocument doc, Range r)
    {
        int start = doc.OffsetOf(r.Start.Line, r.Start.Character);
        int end = doc.OffsetOf(r.End.Line, r.End.Character);
        return doc.Text.Substring(start, Math.Max(0, end - start));
    }

    /// <summary>Range of the name in the matching `&lt;/[prefix:]Name>` (same nesting level), if the element is not self-closing.</summary>
    static Range? FindEndTag(XamlDocument doc, Range nameRange, string name)
    {
        int nameStart = doc.OffsetOf(nameRange.Start.Line, nameRange.Start.Character);
        int lt = doc.Text.LastIndexOf('<', nameStart);
        if (lt < 0)
            return null;
        var qualified = doc.Text.Substring(lt + 1, nameStart - lt - 1) + name; // includes the prefix
        int gt = doc.Text.IndexOf('>', nameStart);
        if (gt < 0 || doc.Text[gt - 1] == '/')
            return null;
        int depth = 0;
        for (int i = gt + 1; i < doc.Text.Length; i++)
        {
            if (doc.Text[i] != '<')
                continue;
            if (string.CompareOrdinal(doc.Text, i + 1, qualified, 0, qualified.Length) == 0 && !char.IsLetterOrDigit(doc.Text[i + 1 + qualified.Length]))
            {
                int end = doc.Text.IndexOf('>', i);
                if (end > 0 && doc.Text[end - 1] != '/')
                    depth++;
            }
            else if (doc.Text.AsSpan(i).StartsWith("</" + qualified) && !char.IsLetterOrDigit(doc.Text[i + 2 + qualified.Length]))
            {
                if (depth == 0)
                    return doc.RangeOf(i + 2 + qualified.Length - name.Length, name.Length);
                depth--;
            }
        }
        return null;
    }
}
