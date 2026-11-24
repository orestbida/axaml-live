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

    public static IEnumerable<File> All(string? root, BufferService buffers, DocumentUri? except = null) {
        if (root == null || !Directory.Exists(root)) {
            yield break;
        }

        var exceptPath = except is null ? null : Path.GetFullPath(Utils.FromUri(except));
        List<string> paths;
        try {
            var sep = Path.DirectorySeparatorChar;
            paths = Directory.EnumerateFiles(root, "*.axaml", SearchOption.AllDirectories)
                .Where(f => !f.Contains($"{sep}bin{sep}") && !f.Contains($"{sep}obj{sep}") && !f.Contains($"{sep}node_modules{sep}"))
                .Take(MaxFiles).ToList();
        } catch (Exception) {
            yield break;
        }

        foreach (var path in paths) {
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
