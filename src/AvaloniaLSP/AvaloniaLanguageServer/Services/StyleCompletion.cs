using System.Text.RegularExpressions;
using Avalonia.Ide.CompletionEngine;

namespace AvaloniaLanguageServer.Services;

/// <summary>
/// Completion the vendored engine does not offer: style classes (Selector ".name", Classes="..."), element names
/// (Selector "#name") and control types after "/template/" in a selector.
/// </summary>
public static class StyleCompletion {
    public sealed record Result(int Start, List<CompletionItem> Items);

    const string AvaloniaNamespace = "https://github.com/avaloniaui";
    static readonly Regex OpenValue = new(@"(?<![\w:.])(?<name>[A-Za-z_][\w:.]*)\s*=\s*(?<q>[""'])(?<value>[^""'<>]*)$", RegexOptions.Compiled);
    static readonly Regex SelectorValue = new(@"\bSelector\s*=\s*(?<q>[""'])(?<value>[^""']*)\k<q>", RegexOptions.Compiled);
    static readonly Regex ClassesValue = new(@"\bClasses\s*=\s*(?<q>[""'])(?<value>[^""'{]*)\k<q>", RegexOptions.Compiled);
    static readonly Regex ClassesAttached = new(@"\bClasses\.(?<name>[A-Za-z_][\w-]*)\s*=", RegexOptions.Compiled);
    static readonly Regex ClassInSelector = new(@"\.(?<name>[A-Za-z_][\w-]*)", RegexOptions.Compiled);
    static readonly Regex ElementName = new(@"\b(?:x:)?Name\s*=\s*(?<q>[""'])(?<value>[A-Za-z_]\w*)\k<q>", RegexOptions.Compiled);

    /// <summary>Classes that the built-in themes style (not visible in this project's files).</summary>
    static readonly (string Name, string Where)[] ThemeClasses = { ("accent", "Fluent theme: accent Button") };

    /// <summary>
    /// Returns completions when the cursor is in one of the handled places, otherwise null (the engine handles it).
    /// <paramref name="otherFiles"/> are the other .axaml files of the project, for classes defined there.
    /// </summary>
    public static Result? Complete(string textToCursor, string fullText, Metadata? metadata, Func<IEnumerable<(string Name, string Text)>> otherFiles) {
        var tail = textToCursor.Length > 4000 ? textToCursor[^4000..] : textToCursor;
        var open = OpenValue.Match(tail);
        if (!open.Success) {
            return null;
        }

        var attribute = open.Groups["name"].Value;
        var value = open.Groups["value"].Value;
        int cursor = textToCursor.Length;
        // the word being typed is not a suggestion: leave it out of the text that classes are read from
        var typedWord = Regex.Match(value, @"[\w-]*$").Value;
        if (typedWord.Length > 0 && fullText.Length >= cursor) {
            fullText = fullText.Remove(cursor - typedWord.Length, typedWord.Length);
        }

        if (attribute == "Selector") {
            var cls = Regex.Match(value, @"(?<!\d)\.(?<w>[A-Za-z_][\w-]*)?$");
            if (cls.Success) {
                var typed = cls.Groups["w"].Value;
                return new Result(cursor - typed.Length, ClassItems(fullText, otherFiles, exclude: Array.Empty<string>()));
            }

            var name = Regex.Match(value, @"#(?<w>[\w-]*)$");
            if (name.Success) {
                var typed = name.Groups["w"].Value;
                var names = ElementName.Matches(fullText).Select(m => m.Groups["value"].Value).Distinct()
                    .Select(n => new CompletionItem { Label = n, Kind = CompletionItemKind.Variable, Detail = "element name" }).ToList();
                return new Result(cursor - typed.Length, names);
            }

            var template = Regex.Match(value, @"/template/\s*(?<w>\w*)$");
            if (template.Success && metadata != null && metadata.Namespaces.TryGetValue(AvaloniaNamespace, out var types)) {
                var typed = template.Groups["w"].Value;
                var items = types.Values
                    // template parts are visuals (they have IsVisible); no abstract or generic types
                    .Where(t => t.IsAvaloniaObjectType && !t.IsAbstract && !t.IsMarkupExtension && !t.IsGeneric && !t.Name.Contains('`')
                        && t.Properties.Any(p => p.Name == "IsVisible"))
                    .Select(t => new CompletionItem { Label = t.Name, Kind = CompletionItemKind.Class, Detail = t.FullName })
                    .ToList();
                return new Result(cursor - typed.Length, items);
            }
            return null;
        }

        if (attribute == "Classes" && !value.Contains('{')) {
            var typed = Regex.Match(value, @"[\w-]*$").Value;
            var existing = value.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            return new Result(cursor - typed.Length, ClassItems(fullText, otherFiles, existing));
        }
        return null;
    }

    static List<CompletionItem> ClassItems(string fullText, Func<IEnumerable<(string Name, string Text)>> otherFiles, string[] exclude) {
        var found = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var name in ClassesIn(fullText)) {
            found.TryAdd(name, "style class in this file");
        }

        foreach (var (file, text) in otherFiles()) {
            foreach (var name in ClassesIn(text)) {
                found.TryAdd(name, $"style class in {file}");
            }
        }

        foreach (var (name, where) in ThemeClasses) {
            found.TryAdd(name, where);
        }

        return found
            .Where(kv => !exclude.Contains(kv.Key))
            .OrderBy(kv => kv.Value.EndsWith("this file") ? 0 : 1).ThenBy(kv => kv.Key)
            .Select((kv, i) => new CompletionItem {
                Label = kv.Key,
                Kind = CompletionItemKind.EnumMember,
                Detail = kv.Value,
                SortText = i.ToString("D4"),
            })
            .ToList();
    }

    /// <summary>Style class names used in selectors, Classes="..." and Classes.name="..." of an AXAML text.</summary>
    public static IEnumerable<string> ClassesIn(string text) {
        foreach (Match s in SelectorValue.Matches(text)) {
            // :nth-child(2n+1) arguments contain no classes
            var selector = Regex.Replace(s.Groups["value"].Value, @":nth-(?:last-)?child\([^)]*\)", "");
            foreach (Match c in ClassInSelector.Matches(selector)) {
                yield return c.Groups["name"].Value;
            }
        }

        foreach (Match m in ClassesValue.Matches(text)) {
            foreach (var name in m.Groups["value"].Value.Split(' ', StringSplitOptions.RemoveEmptyEntries)) {
                if (Regex.IsMatch(name, @"^[A-Za-z_][\w-]*$")) {
                    yield return name;
                }
            }
        }

        foreach (Match m in ClassesAttached.Matches(text)) {
            yield return m.Groups["name"].Value;
        }
    }
}
