using AvaloniaLanguageServer.Services;
using OmniSharp.Extensions.LanguageServer.Protocol.Server;
using Workspace = AvaloniaLanguageServer.Models.Workspace;

namespace AvaloniaLanguageServer.Handlers;

/// <summary>Inlay hints with the type of compiled binding paths: {Binding Name} : string.</summary>
public sealed class InlayHintHandler : InlayHintsHandlerBase {
    readonly Workspace _workspace;
    readonly TextDocumentSelector _documentSelector;
    readonly Func<ILanguageServer?> _getServer;

    public InlayHintHandler(Workspace workspace, TextDocumentSelector documentSelector, Func<ILanguageServer?> getServer) {
        _workspace = workspace;
        _documentSelector = documentSelector;
        _getServer = getServer;
    }

    protected override InlayHintRegistrationOptions CreateRegistrationOptions(InlayHintClientCapabilities capability, ClientCapabilities clientCapabilities) =>
        new() { DocumentSelector = _documentSelector, ResolveProvider = false };

    public override async Task<InlayHintContainer?> Handle(InlayHintParams request, CancellationToken cancellationToken) {
        var text = _workspace.BufferService.GetText(request.TextDocument.Uri);
        if (text == null) {
            return null;
        }

        if (_workspace.ProjectInfo == null || !_workspace.IsCurrentProject(request.TextDocument.Uri)) {
            await _workspace.InitializeAsync(request.TextDocument.Uri, _getServer()?.Client.ClientSettings.RootPath);
        }

        var compilation = await _workspace.GetCompilationAsync();
        var analyzer = new XamlAnalyzer(new XamlDocument(text), _workspace.CompletionMetadata, compilation);
        var hints = analyzer.BindingTypeHints()
            .Where(h => h.Position.Line >= request.Range.Start.Line && h.Position.Line <= request.Range.End.Line)
            .Select(h => new InlayHint {
                Position = h.Position,
                Label = new StringOrInlayHintLabelParts(h.Label),
                Kind = InlayHintKind.Type,
                PaddingLeft = true,
            });
        return new InlayHintContainer(hints);
    }

    public override Task<InlayHint> Handle(InlayHint request, CancellationToken cancellationToken) => Task.FromResult(request);
}
