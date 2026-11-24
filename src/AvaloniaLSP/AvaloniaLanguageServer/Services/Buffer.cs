namespace AvaloniaLanguageServer.Services;

public sealed class Buffer {

    /// <summary>The text before the position, lines joined with "\n" (offsets must map back to positions).</summary>
    public string GetTextTillLine(Position position) {
        var end = BufferService.OffsetOf(_text, position);
        return _text[..end].Replace("\r\n", "\n");
    }

    public string GetText() => _text;

    public Buffer(string text) {
        _text = text;
    }

    readonly string _text;
}
