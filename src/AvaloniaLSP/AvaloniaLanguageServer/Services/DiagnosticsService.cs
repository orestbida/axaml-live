using System.Collections.Concurrent;
using AvaloniaLanguageServer.Models;
using OmniSharp.Extensions.LanguageServer.Protocol.Server;

namespace AvaloniaLanguageServer.Services;

/// <summary>Publishes AXAML diagnostics for open documents (debounced), and again whenever metadata changes.</summary>
public sealed class DiagnosticsService {
    readonly Workspace _workspace;
    readonly Func<ILanguageServer?> _getServer;
    readonly ConcurrentDictionary<DocumentUri, CancellationTokenSource> _pending = new();

    public DiagnosticsService(Workspace workspace, Func<ILanguageServer?> getServer) {
        _workspace = workspace;
        _getServer = getServer;
        _workspace.MetadataChanged += () => {
            foreach (var uri in _workspace.BufferService.Uris) {
                Schedule(uri, 0);
            }
        };
    }

    public void Schedule(DocumentUri uri, int delayMs = 300) {
        var cts = new CancellationTokenSource();
        if (_pending.TryGetValue(uri, out var previous)) {
            previous.Cancel();
        }

        _pending[uri] = cts;
        _ = Task.Delay(delayMs, cts.Token).ContinueWith(async t => {
            if (t.IsCanceled) {
                return;
            }

            try {
                await PublishAsync(uri, cts.Token);
            } catch (Exception e) when (e is not OperationCanceledException) {
                Log.Logger.Warning(e, "Diagnostics failed for {Uri}", uri);
            }
        }, TaskScheduler.Default);
    }

    public void Clear(DocumentUri uri) {
        if (_pending.TryRemove(uri, out var cts)) {
            cts.Cancel();
        }

        _getServer()?.TextDocument.PublishDiagnostics(new PublishDiagnosticsParams { Uri = uri, Diagnostics = new Container<Diagnostic>() });
    }

    async Task PublishAsync(DocumentUri uri, CancellationToken ct) {
        var text = _workspace.BufferService.GetText(uri);
        if (text == null) {
            return;
        }

        if (_workspace.ProjectInfo == null || !_workspace.IsCurrentProject(uri)) {
            await _workspace.InitializeAsync(uri, _getServer()?.Client.ClientSettings.RootPath);
        }

        var compilation = await _workspace.GetCompilationAsync();
        ct.ThrowIfCancellationRequested();
        var diagnostics = new XamlAnalyzer(new XamlDocument(text), _workspace.CompletionMetadata, compilation).Analyze();
        _getServer()?.TextDocument.PublishDiagnostics(new PublishDiagnosticsParams {
            Uri = uri,
            Diagnostics = new Container<Diagnostic>(diagnostics),
        });
    }
}
