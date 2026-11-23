using AvaloniaLanguageServer.Models;
using AvaloniaLanguageServer.Utilities;
using MediatR;
using OmniSharp.Extensions.LanguageServer.Protocol.Workspace;

namespace AvaloniaLanguageServer.Handlers;

/// <summary>C# / project file changes on disk: keeps the in-memory Roslyn compilation current (no build needed).</summary>
public sealed class WatchedFilesHandler : DidChangeWatchedFilesHandlerBase {
    readonly Workspace _workspace;

    public WatchedFilesHandler(Workspace workspace) => _workspace = workspace;

    protected override DidChangeWatchedFilesRegistrationOptions CreateRegistrationOptions(DidChangeWatchedFilesCapability capability, ClientCapabilities clientCapabilities) =>
        new() {
            Watchers = new Container<OmniSharp.Extensions.LanguageServer.Protocol.Models.FileSystemWatcher>(
                new OmniSharp.Extensions.LanguageServer.Protocol.Models.FileSystemWatcher { GlobPattern = "**/*.{cs,csproj,props}" }),
        };

    public override async Task<Unit> Handle(DidChangeWatchedFilesParams request, CancellationToken cancellationToken) {
        foreach (var change in request.Changes) {
            var path = Utils.FromUri(change.Uri);
            if (path.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}") || path.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}")) {
                continue;
            }

            await _workspace.Roslyn.FileChangedAsync(path, change.Type == FileChangeType.Deleted);
        }
        return Unit.Value;
    }
}
