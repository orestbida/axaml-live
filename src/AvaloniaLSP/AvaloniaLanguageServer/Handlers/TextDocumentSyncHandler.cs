using AvaloniaLanguageServer.Models;
using AvaloniaLanguageServer.Services;
using MediatR;
using OmniSharp.Extensions.LanguageServer.Protocol.Server.Capabilities;

namespace AvaloniaLanguageServer.Handlers;

public class TextDocumentSyncHandler : TextDocumentSyncHandlerBase {
    private readonly ILogger<TextDocumentSyncHandler> _logger;
    private readonly TextDocumentSelector _documentSelector;
    private readonly Workspace _workspace;
    private readonly DiagnosticsService _diagnostics;

    public override Task<Unit> Handle(DidOpenTextDocumentParams request, CancellationToken cancellationToken) {
        var uri = request.TextDocument.Uri;
        _workspace.BufferService.Add(uri, request.TextDocument.Text);
        _diagnostics.Schedule(uri, 0);
        _logger.LogInformation("Opened {Uri}", uri);
        return Unit.Task;
    }

    public override Task<Unit> Handle(DidChangeTextDocumentParams request, CancellationToken cancellationToken) {
        var uri = request.TextDocument.Uri;
        foreach (var change in request.ContentChanges) {
            if (change.Range != null) {
                _workspace.BufferService.ApplyIncrementalChange(uri, change.Range, change.Text);
            } else {
                _workspace.BufferService.ApplyFullChange(uri, change.Text);
            }
        }
        _diagnostics.Schedule(uri);
        return Unit.Task;
    }

    public override Task<Unit> Handle(DidSaveTextDocumentParams request, CancellationToken cancellationToken) => Unit.Task;

    public override Task<Unit> Handle(DidCloseTextDocumentParams request, CancellationToken cancellationToken) {
        var uri = request.TextDocument.Uri;
        _workspace.BufferService.Remove(uri);
        _diagnostics.Clear(uri);
        _logger.LogInformation("Closed {Uri}", uri);
        return Unit.Task;
    }

    protected override TextDocumentSyncRegistrationOptions CreateRegistrationOptions(TextSynchronizationCapability capability,
        ClientCapabilities clientCapabilities) {
        return new TextDocumentSyncRegistrationOptions {
            DocumentSelector = _documentSelector,
            Change = TextDocumentSyncKind.Incremental,
            Save = new SaveOptions { IncludeText = false }
        };
    }

    public override TextDocumentAttributes GetTextDocumentAttributes(DocumentUri uri) {
        return new TextDocumentAttributes(uri, uri.Scheme!, "axaml");
    }

    public TextDocumentSyncHandler(
        ILogger<TextDocumentSyncHandler> logger,
        TextDocumentSelector documentSelector,
        Workspace workspace,
        DiagnosticsService diagnostics) {
        _diagnostics = diagnostics;
        _logger = logger;
        _documentSelector = documentSelector;
        _workspace = workspace;
    }
}
