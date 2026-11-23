using System.Xml;
using Range = OmniSharp.Extensions.LanguageServer.Protocol.Models.Range;

namespace AvaloniaLanguageServer.Services;

/// <summary>Element of an AXAML document with exact positions (0-based LSP coordinates).</summary>
public sealed class XamlElement {
    public required string Prefix { get; init; }
    public required string LocalName { get; init; }
    public required string NamespaceUri { get; init; }
    public required Range NameRange { get; init; } // local name only (without prefix)
    public XamlElement? Parent { get; init; }
    public List<XamlAttribute> Attributes { get; } = new();
    public required Dictionary<string, string> Namespaces { get; init; } // prefix -> uri in scope ("" = default)
    public bool IsPropertyElement => LocalName.Contains('.');
}

public sealed class XamlAttribute {
    public required string Prefix { get; init; }
    public required string LocalName { get; init; }
    public required string NamespaceUri { get; init; }
    public required string Value { get; init; }
    public required Range NameRange { get; init; } // local name only
    public required Range ValueRange { get; init; } // inside the quotes
    public required int ValueOffset { get; init; } // offset of the value in the document
}

/// <summary>
/// Parses AXAML with XmlReader keeping line info. Syntax errors are reported, not thrown;
/// elements read before the error are still available (useful while typing).
/// </summary>
public sealed class XamlDocument {
    public const string XamlNamespace = "http://schemas.microsoft.com/winfx/2006/xaml";
    public const string MarkupCompatibility = "http://schemas.openxmlformats.org/markup-compatibility/2006";

    public string Text { get; }
    public List<XamlElement> Elements { get; } = new();
    public (string Message, Range Range)? SyntaxError { get; private set; }
    public HashSet<string> IgnorableNamespaces { get; } = new();

    readonly int[] _lineStarts;

    public XamlDocument(string text) {
        Text = text;
        var starts = new List<int> { 0 };
        for (int i = 0; i < text.Length; i++) {
            if (text[i] == '\n') {
                starts.Add(i + 1);
            }
        }

        _lineStarts = starts.ToArray();
        Parse();
    }

    public int OffsetOf(int line, int character) =>
        line < _lineStarts.Length ? Math.Min(_lineStarts[line] + character, Text.Length) : Text.Length;

    public Position PositionOf(int offset) {
        offset = Math.Clamp(offset, 0, Text.Length);
        int line = Array.BinarySearch(_lineStarts, offset);
        if (line < 0) {
            line = ~line - 1;
        }

        return new Position(line, offset - _lineStarts[line]);
    }

    public Range RangeOf(int offset, int length) => new(PositionOf(offset), PositionOf(offset + length));

    public static bool Contains(Range range, Position pos) =>
        (pos.Line > range.Start.Line || (pos.Line == range.Start.Line && pos.Character >= range.Start.Character)) &&
        (pos.Line < range.End.Line || (pos.Line == range.End.Line && pos.Character <= range.End.Character));

    void Parse() {
        var settings = new XmlReaderSettings { DtdProcessing = DtdProcessing.Ignore, IgnoreComments = true, IgnoreWhitespace = true };
        var stack = new Stack<XamlElement>();
        using var reader = XmlReader.Create(new StringReader(Text), settings);
        var info = (IXmlLineInfo)reader;
        try {
            while (reader.Read()) {
                if (reader.NodeType == XmlNodeType.EndElement) {
                    if (stack.Count > 0) {
                        stack.Pop();
                    }

                    continue;
                }
                if (reader.NodeType != XmlNodeType.Element) {
                    continue;
                }

                // XmlReader: LinePosition of an element is the first character of its (prefixed) name, 1-based
                int nameOffset = OffsetOf(info.LineNumber - 1, info.LinePosition - 1);
                var localOffset = nameOffset + (reader.Prefix.Length > 0 ? reader.Prefix.Length + 1 : 0);
                var parent = stack.Count > 0 ? stack.Peek() : null;
                var ns = parent != null ? new Dictionary<string, string>(parent.Namespaces) : new Dictionary<string, string>();

                var element = new XamlElement {
                    Prefix = reader.Prefix,
                    LocalName = reader.LocalName,
                    NamespaceUri = reader.NamespaceURI,
                    NameRange = RangeOf(localOffset, reader.LocalName.Length),
                    Parent = parent,
                    Namespaces = ns,
                };

                bool empty = reader.IsEmptyElement;
                if (reader.MoveToFirstAttribute()) {
                    do {
                        int attrOffset = OffsetOf(info.LineNumber - 1, info.LinePosition - 1);
                        int localAttr = attrOffset + (reader.Prefix.Length > 0 ? reader.Prefix.Length + 1 : 0);
                        int eq = Text.IndexOf('=', attrOffset + reader.Name.Length);
                        int quote = eq < 0 ? -1 : Text.IndexOfAny(new[] { '"', '\'' }, eq);
                        int valueStart = quote + 1;
                        int valueEnd = quote < 0 ? valueStart : Text.IndexOf(Text[quote], valueStart);
                        if (valueEnd < 0) {
                            valueEnd = valueStart;
                        }

                        if (reader.Prefix == "xmlns") {
                            ns[reader.LocalName] = reader.Value;
                        } else if (reader.Name == "xmlns") {
                            ns[""] = reader.Value;
                        }

                        element.Attributes.Add(new XamlAttribute {
                            Prefix = reader.Prefix,
                            LocalName = reader.LocalName,
                            NamespaceUri = reader.NamespaceURI,
                            Value = reader.Value,
                            NameRange = RangeOf(localAttr, reader.LocalName.Length),
                            ValueRange = RangeOf(valueStart, valueEnd - valueStart),
                            ValueOffset = valueStart,
                        });
                    } while (reader.MoveToNextAttribute());
                    reader.MoveToElement();
                }

                foreach (var a in element.Attributes.Where(a => a.NamespaceUri == MarkupCompatibility && a.LocalName == "Ignorable")) {
                    foreach (var prefix in a.Value.Split(' ', StringSplitOptions.RemoveEmptyEntries)) {
                        if (ns.TryGetValue(prefix, out var uri)) {
                            IgnorableNamespaces.Add(uri);
                        }
                    }
                }

                Elements.Add(element);
                if (!empty) {
                    stack.Push(element);
                }
            }
        } catch (XmlException e) {
            var pos = new Position(Math.Max(0, e.LineNumber - 1), Math.Max(0, e.LinePosition - 1));
            SyntaxError = (e.Message, new Range(pos, pos));
        }
    }

    /// <summary>Resolves "prefix:Name" (also "{x:Type prefix:Name}") against the namespaces in scope of an element.</summary>
    public static (string Uri, string Name)? ResolveQualified(string value, XamlElement scope) {
        value = value.Trim();
        if (value.StartsWith('{')) {
            var m = System.Text.RegularExpressions.Regex.Match(value, @"^\{\s*x:Type\s+([^\s}]+)\s*\}$");
            if (!m.Success) {
                return null;
            }

            value = m.Groups[1].Value;
        }
        var colon = value.IndexOf(':');
        var prefix = colon < 0 ? "" : value[..colon];
        var name = colon < 0 ? value : value[(colon + 1)..];
        return scope.Namespaces.TryGetValue(prefix, out var uri) ? (uri, name) : null;
    }
}
