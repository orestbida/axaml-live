using System.Collections.Concurrent;
using Range = OmniSharp.Extensions.LanguageServer.Protocol.Models.Range;

namespace AvaloniaLanguageServer.Services;

public class BufferService {
    private readonly ConcurrentDictionary<DocumentUri, Buffer> _buffers = new();

    public void Add(DocumentUri key, string text) {
        _buffers[key] = new Buffer(text);
    }

    public string? GetText(DocumentUri key) => _buffers.TryGetValue(key, out var b) ? b.GetText() : null;

    public IReadOnlyCollection<DocumentUri> Uris => _buffers.Keys.ToArray();

    public void Remove(DocumentUri key) {
        _buffers.TryRemove(key, out _);
    }

    public string? GetTextTillPosition(DocumentUri key, Position position) {
        return _buffers.TryGetValue(key, out var b) ? b.GetTextTillLine(position) : null;
    }

    public void ApplyFullChange(DocumentUri key, string text) {
        _buffers[key] = new Buffer(text);
    }

    public void ApplyIncrementalChange(DocumentUri key, Range range, string text) {
        if (!_buffers.TryGetValue(key, out var buffer)) {
            Log.Logger.Warning("Change for a document that is not open: {Uri}", key);
            return;
        }

        var newText = Splice(buffer.GetText(), range, text);
        _buffers.TryUpdate(key, new Buffer(newText), buffer);
    }

    /// <summary>Offset of a position, clamped to its line and to the text (a position past the end is the end).</summary>
    public static int OffsetOf(string text, Position position) {
        var index = 0;
        for (var i = 0; i < position.Line; ++i) {
            var next = text.IndexOf('\n', index);
            if (next < 0) {
                return text.Length;
            }
            index = next + 1;
        }

        var lineEnd = text.IndexOf('\n', index);
        if (lineEnd < 0) {
            lineEnd = text.Length;
        } else if (lineEnd > index && text[lineEnd - 1] == '\r') {
            lineEnd--;
        }
        return Math.Min(index + Math.Max(position.Character, 0), lineEnd);
    }

    private static string Splice(string buffer, Range range, string text) {
        var start = OffsetOf(buffer, range.Start);
        var end = Math.Max(start, OffsetOf(buffer, range.End));
        return buffer[..start] + text + buffer[end..];
    }
}
