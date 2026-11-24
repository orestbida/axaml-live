using System.Collections.Concurrent;
using AvaloniaLanguageServer.Utilities;

namespace AvaloniaLanguageServer.Services;

/// <summary>
/// The .axaml files of the workspace (the open editor's text when a file is open), for things that are defined in
/// one file and used in another: style classes and resource keys. Files are read again only when they change.
/// </summary>
public static class AxamlFiles {
    public sealed record File(string Path, string Name, string Text);

    const int MaxFiles = 500;
    static readonly ConcurrentDictionary<string, (DateTime Stamp, string Text)> Cache = new(StringComparer.OrdinalIgnoreCase);
    static readonly ConcurrentDictionary<string, (DateTime Time, IReadOnlyList<string> Paths)> ListCache = new(StringComparer.OrdinalIgnoreCase);
    static readonly TimeSpan ListLifetime = TimeSpan.FromSeconds(5);
    static readonly HashSet<string> SkippedFolders = new(StringComparer.OrdinalIgnoreCase) { "bin", "obj", "node_modules", "packages" };

    public static IEnumerable<File> All(string? root, BufferService buffers, DocumentUri? except = null) {
        if (root == null || !Directory.Exists(root)) {
            yield break;
        }

        var exceptPath = except is null ? null : Path.GetFullPath(Utils.FromUri(except));
        foreach (var path in Paths(root)) {
            var uri = DocumentUri.FromFileSystemPath(path);
            if ((except is not null && uri.Equals(except)) || string.Equals(Path.GetFullPath(path), exceptPath, StringComparison.OrdinalIgnoreCase)) {
                continue;
            }

            var text = buffers.GetText(uri) ?? Read(path);
            if (text != null) {
                yield return new File(path, System.IO.Path.GetFileName(path), text);
            }
        }
    }

    /// <summary>
    /// The .axaml files under the root, without build output and tool folders (they are never entered). The list is
    /// reused for a few seconds: completion asks for it on many keystrokes.
    /// </summary>
    static IReadOnlyList<string> Paths(string root) {
        if (ListCache.TryGetValue(root, out var cached) && DateTime.UtcNow - cached.Time < ListLifetime) {
            return cached.Paths;
        }

        var paths = new List<string>();
        var pending = new Stack<string>();
        pending.Push(root);
        while (pending.Count > 0 && paths.Count < MaxFiles) {
            var dir = pending.Pop();
            try {
                paths.AddRange(Directory.EnumerateFiles(dir, "*.axaml").Take(MaxFiles - paths.Count));
                foreach (var sub in Directory.EnumerateDirectories(dir)) {
                    var name = System.IO.Path.GetFileName(sub);
                    if (!SkippedFolders.Contains(name) && !name.StartsWith('.')) {
                        pending.Push(sub);
                    }
                }
            } catch (Exception) {
                // no access, or removed meanwhile: skipped
            }
        }

        ListCache[root] = (DateTime.UtcNow, paths);
        return paths;
    }

    static string? Read(string path) {
        try {
            var stamp = System.IO.File.GetLastWriteTimeUtc(path);
            if (!Cache.TryGetValue(path, out var cached) || cached.Stamp != stamp) {
                cached = (stamp, System.IO.File.ReadAllText(path));
                Cache[path] = cached;
            }

            return cached.Text;
        } catch (IOException) {
            return null; // being written: skipped this time
        } catch (UnauthorizedAccessException) {
            return null;
        }
    }
}
