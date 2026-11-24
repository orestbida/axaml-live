using System.Collections.Concurrent;
using AvaloniaLanguageServer.Models;
using OmniSharp.Extensions.LanguageServer.Protocol.Server;

namespace AvaloniaLanguageServer.Services;

/// <summary>Publishes AXAML diagnostics for open documents (debounced), and again whenever metadata changes.</summary>
public sealed class DiagnosticsService {
    readonly Workspace _workspace;
    readonly Func<ILanguageServer?> _getServer;
    readonly ConcurrentDictionary<DocumentUri, CancellationTokenSource> _pending = new();
    readonly object _gate = new();

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
        lock (_gate) {
            if (_pending.TryGetValue(uri, out var previous)) {
                previous.Cancel();
            }
            _pending[uri] = cts;
        }

        _ = Task.Delay(delayMs, cts.Token).ContinueWith(async t => {
            try {
                if (!t.IsCanceled) {
                    await PublishAsync(uri, cts.Token);
                }
            } catch (Exception e) when (e is not OperationCanceledException) {
                Log.Logger.Warning(e, "Diagnostics failed for {Uri}", uri);
            } finally {
                // the run that owns the token disposes it; a newer run has replaced (and cancelled) it under the same lock
                lock (_gate) {
                    _pending.TryRemove(new KeyValuePair<DocumentUri, CancellationTokenSource>(uri, cts));
                    cts.Dispose();
                }
            }
        }, TaskScheduler.Default).Unwrap();
    }

    public void Clear(DocumentUri uri) {
        lock (_gate) {
            if (_pending.TryRemove(uri, out var cts)) {
                cts.Cancel();
            }
        }

        _getServer()?.TextDocument.PublishDiagnostics(new PublishDiagnosticsParams { Uri = uri, Diagnostics = new Container<Diagnostic>() });
    }

    async Task PublishAsync(DocumentUri uri, CancellationToken ct) {
        var text = _workspace.BufferService.GetText(uri);
        if (text == null) {
            return;
        }

        var ctx = await _workspace.ContextAsync(uri, _getServer()?.Client.ClientSettings.RootPath);
        ct.ThrowIfCancellationRequested();
        var diagnostics = new XamlAnalyzer(new XamlDocument(text), ctx.Metadata, ctx.Compilation).Analyze();
        // checked again under the lock: a newer run (newer text) may have started while this one was analyzing
        lock (_gate) {
            if (ct.IsCancellationRequested) {
                return;
            }
            _getServer()?.TextDocument.PublishDiagnostics(new PublishDiagnosticsParams {
                Uri = uri,
                Diagnostics = new Container<Diagnostic>(diagnostics),
            });
        }
    }
}
