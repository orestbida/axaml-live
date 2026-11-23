using System.Text.RegularExpressions;
using Avalonia.Ide.CompletionEngine;
using Microsoft.CodeAnalysis;
using Metadata = Avalonia.Ide.CompletionEngine.Metadata;
using Range = OmniSharp.Extensions.LanguageServer.Protocol.Models.Range;
using Diagnostic = OmniSharp.Extensions.LanguageServer.Protocol.Models.Diagnostic;
using DiagnosticSeverity = OmniSharp.Extensions.LanguageServer.Protocol.Models.DiagnosticSeverity;

namespace AvaloniaLanguageServer.Services;

/// <summary>What is under the cursor in an AXAML document.</summary>
public abstract record XamlSymbol(Range Range);
public sealed record ElementTypeSymbol(Range Range, MetadataType Type) : XamlSymbol(Range);
public sealed record PropertySymbol(Range Range, MetadataType Owner, string Name, MetadataProperty? Property, MetadataEvent? Event, bool Attached) : XamlSymbol(Range);
public sealed record TypeReferenceSymbol(Range Range, string FullName) : XamlSymbol(Range);
public sealed record BindingMemberSymbol(Range Range, ISymbol Member) : XamlSymbol(Range);
public sealed record EventHandlerSymbol(Range Range, string ClassFullName, string Method) : XamlSymbol(Range);
public sealed record ResourceKeySymbol(Range Range, string Key) : XamlSymbol(Range);

/// <summary>
/// Validates AXAML against completion metadata (types, properties, attached properties, events) and, when a Roslyn
/// compilation is available, compiled binding paths (x:DataType). Deliberately conservative: unknown namespaces,
/// markup extensions and complex binding paths are not reported.
/// </summary>
public sealed class XamlAnalyzer
{
    public const string Source = "Avalonia";
    static readonly Regex BindingRegex = new(@"^\{\s*(?:Binding|CompiledBinding|x:Bind)\s*(?:Path\s*=\s*)?(?<path>[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*(?<rest>[,}])", RegexOptions.Compiled);
    static readonly Regex ResourceRegex = new(@"^\{\s*(?:StaticResource|DynamicResource)\s+(?<key>[^\s,}]+)", RegexOptions.Compiled);

    readonly XamlDocument _doc;
    readonly Metadata? _metadata;
    readonly Compilation? _compilation;

    public XamlAnalyzer(XamlDocument doc, Metadata? metadata, Compilation? compilation)
    {
        _doc = doc;
        _metadata = metadata;
        _compilation = compilation;
    }

    // ---------------------------------------------------------------- diagnostics

    public List<Diagnostic> Analyze()
    {
        var result = new List<Diagnostic>();
        if (_doc.SyntaxError is { } err)
            result.Add(Make(err.Range, err.Message, DiagnosticSeverity.Error, "AVLS0001"));
        if (_metadata == null)
            return result;

        foreach (var el in _doc.Elements)
        {
            if (Skip(el.NamespaceUri))
                continue;

            MetadataType? type;
            if (el.IsPropertyElement)
            {
                var dot = el.LocalName.IndexOf('.');
                var owner = ResolveType(el.NamespaceUri, el.LocalName[..dot]);
                if (owner == null)
                {
                    if (NamespaceKnown(el.NamespaceUri))
                        result.Add(UnknownType(el.NameRange with { End = el.NameRange.Start with { Character = el.NameRange.Start.Character + dot } }, el.LocalName[..dot], el.NamespaceUri));
                    continue;
                }
                var propName = el.LocalName[(dot + 1)..];
                if (FindProperty(owner, propName) == null && FindEvent(owner, propName) == null)
                {
                    var start = el.NameRange.Start with { Character = el.NameRange.Start.Character + dot + 1 };
                    result.Add(UnknownMember(new Range(start, el.NameRange.End), propName, owner));
                }
                continue;
            }

            type = ResolveType(el.NamespaceUri, el.LocalName);
            if (type == null)
            {
                if (NamespaceKnown(el.NamespaceUri))
                    result.Add(UnknownType(el.NameRange, el.LocalName, el.NamespaceUri));
                continue;
            }
            if (type.IsMarkupExtension)
                continue;

            foreach (var a in el.Attributes)
            {
                if (a.Prefix == "xmlns" || (a.Prefix == "" && a.LocalName == "xmlns") || Skip(a.NamespaceUri) || a.NamespaceUri == "http://www.w3.org/XML/1998/namespace")
                    continue;
                // unprefixed attached properties (Grid.Row) resolve their owner in the default namespace,
                // also on prefixed elements (<local:MyControl Grid.Row="1">)
                var attrNs = a.Prefix == "" ? el.Namespaces.GetValueOrDefault("", el.NamespaceUri) : a.NamespaceUri;
                if (a.LocalName.Contains('.'))
                {
                    var dot = a.LocalName.IndexOf('.');
                    var owner = ResolveType(attrNs, a.LocalName[..dot]);
                    if (owner == null)
                    {
                        if (NamespaceKnown(attrNs))
                            result.Add(UnknownType(a.NameRange with { End = a.NameRange.Start with { Character = a.NameRange.Start.Character + dot } }, a.LocalName[..dot], attrNs));
                        continue;
                    }
                    var name = a.LocalName[(dot + 1)..];
                    if (FindProperty(owner, name) == null && FindEvent(owner, name) == null)
                        result.Add(UnknownMember(a.NameRange with { Start = a.NameRange.Start with { Character = a.NameRange.Start.Character + dot + 1 } }, name, owner));
                }
                else if (a.Prefix == "" && FindProperty(type, a.LocalName) == null && FindEvent(type, a.LocalName) == null)
                {
                    result.Add(UnknownMember(a.NameRange, a.LocalName, type));
                }
                else
                {
                    CheckBinding(el, a, result);
                }
            }
        }
        return result;
    }

    void CheckBinding(XamlElement el, XamlAttribute a, List<Diagnostic> result)
    {
        if (_compilation == null)
            return;
        var m = BindingRegex.Match(a.Value);
        if (!m.Success || HasBindingSource(a.Value))
            return;
        var dataType = DataTypeOf(el);
        if (dataType == null)
            return;
        var current = _compilation.GetTypeByMetadataName(dataType);
        if (current == null)
            return;

        var path = m.Groups["path"];
        int offset = a.ValueOffset + path.Index;
        foreach (var segment in path.Value.Split('.'))
        {
            var range = _doc.RangeOf(offset, segment.Length);
            var member = FindMember(current, segment);
            if (member == null)
            {
                var names = AllMembers(current).Where(s => s is IPropertySymbol or IMethodSymbol { MethodKind: MethodKind.Ordinary } or IFieldSymbol { IsImplicitlyDeclared: false })
                    .Select(s => s.Name).Distinct();
                result.Add(Make(range, $"Property '{segment}' not found on '{current.Name}'", DiagnosticSeverity.Warning, "AVLS0101", Suggest(segment, names)));
                return;
            }
            current = member switch
            {
                IPropertySymbol p => p.Type as INamedTypeSymbol,
                IFieldSymbol f => f.Type as INamedTypeSymbol,
                _ => null,
            };
            if (current == null)
                return;
            offset += segment.Length + 1;
        }
    }

    static bool HasBindingSource(string value) =>
        Regex.IsMatch(value, @"\b(ElementName|RelativeSource|Source|DataType)\s*=") || value.Contains('$') || value.Contains('#');

    // ---------------------------------------------------------------- symbol at position

    public XamlSymbol? SymbolAt(Position pos)
    {
        foreach (var el in _doc.Elements)
        {
            if (XamlDocument.Contains(el.NameRange, pos) && !el.IsPropertyElement)
            {
                var t = ResolveType(el.NamespaceUri, el.LocalName);
                return t != null ? new ElementTypeSymbol(el.NameRange, t) : null;
            }
            foreach (var a in el.Attributes)
            {
                if (XamlDocument.Contains(a.NameRange, pos))
                    return AttributeSymbol(el, a);
                if (XamlDocument.Contains(a.ValueRange, pos))
                    return ValueSymbol(el, a, pos);
            }
        }
        return null;
    }

    XamlSymbol? AttributeSymbol(XamlElement el, XamlAttribute a)
    {
        var ns = a.Prefix == "" ? el.Namespaces.GetValueOrDefault("", el.NamespaceUri) : a.NamespaceUri;
        MetadataType? owner;
        string name;
        bool attached = a.LocalName.Contains('.');
        if (attached)
        {
            var dot = a.LocalName.IndexOf('.');
            owner = ResolveType(ns, a.LocalName[..dot]);
            name = a.LocalName[(dot + 1)..];
        }
        else
        {
            owner = ResolveType(el.NamespaceUri, el.LocalName);
            name = a.LocalName;
        }
        if (owner == null)
            return null;
        var prop = FindProperty(owner, name);
        var ev = prop == null ? FindEvent(owner, name) : null;
        return prop != null || ev != null ? new PropertySymbol(a.NameRange, owner, name, prop, ev, attached) : null;
    }

    XamlSymbol? ValueSymbol(XamlElement el, XamlAttribute a, Position pos)
    {
        if (a.NamespaceUri == XamlDocument.XamlNamespace && (a.LocalName == "Class" || a.LocalName == "DataType"))
        {
            var full = a.LocalName == "Class" ? a.Value.Trim() : ResolveTypeFullName(a.Value, el);
            return full != null ? new TypeReferenceSymbol(a.ValueRange, full) : null;
        }

        var resource = ResourceRegex.Match(a.Value);
        if (resource.Success)
            return new ResourceKeySymbol(_doc.RangeOf(a.ValueOffset + resource.Groups["key"].Index, resource.Groups["key"].Length), resource.Groups["key"].Value);

        var binding = BindingRegex.Match(a.Value);
        if (binding.Success && _compilation != null && !HasBindingSource(a.Value))
        {
            var dataType = DataTypeOf(el);
            var current = dataType != null ? _compilation.GetTypeByMetadataName(dataType) : null;
            int offset = a.ValueOffset + binding.Groups["path"].Index;
            foreach (var segment in binding.Groups["path"].Value.Split('.'))
            {
                if (current == null)
                    return null;
                var member = FindMember(current, segment);
                if (member == null)
                    return null;
                var range = _doc.RangeOf(offset, segment.Length);
                if (XamlDocument.Contains(range, pos))
                    return new BindingMemberSymbol(range, member);
                current = (member as IPropertySymbol)?.Type as INamedTypeSymbol ?? (member as IFieldSymbol)?.Type as INamedTypeSymbol;
                offset += segment.Length + 1;
            }
            return null;
        }

        // event handler: Click="OnClick" -> method of x:Class
        var type = ResolveType(el.NamespaceUri, el.LocalName);
        if (type != null && a.Prefix == "" && !a.LocalName.Contains('.') && FindEvent(type, a.LocalName) != null && Regex.IsMatch(a.Value, @"^\w+$"))
        {
            var root = _doc.Elements.FirstOrDefault();
            var xClass = root?.Attributes.FirstOrDefault(x => x.NamespaceUri == XamlDocument.XamlNamespace && x.LocalName == "Class")?.Value;
            if (xClass != null)
                return new EventHandlerSymbol(a.ValueRange, xClass, a.Value);
        }
        return null;
    }

    /// <summary>Offset of x:Key="key" in this document (for resources).</summary>
    public Range? FindResourceKey(string key)
    {
        foreach (var el in _doc.Elements)
            foreach (var a in el.Attributes)
                if (a.NamespaceUri == XamlDocument.XamlNamespace && a.LocalName == "Key" && a.Value == key)
                    return a.ValueRange;
        return null;
    }

    // ---------------------------------------------------------------- helpers

    string? DataTypeOf(XamlElement el)
    {
        for (var e = el; e != null; e = e.Parent)
        {
            var dt = e.Attributes.FirstOrDefault(a => a.NamespaceUri == XamlDocument.XamlNamespace && a.LocalName == "DataType");
            // data templates also take a plain DataType="..." (Avalonia uses it for compiled bindings)
            var isTemplate = !e.IsPropertyElement && e.LocalName.EndsWith("Template", StringComparison.Ordinal);
            if (dt == null && isTemplate)
                dt = e.Attributes.FirstOrDefault(a => a.Prefix == "" && a.LocalName == "DataType");
            if (dt != null)
                return ResolveTypeFullName(dt.Value, e);
            // the data context of a template without a type is unknown (items, content): do not validate
            if (isTemplate && e != el)
                return null;
        }
        return null;
    }

    string? ResolveTypeFullName(string value, XamlElement scope)
    {
        var q = XamlDocument.ResolveQualified(value, scope);
        if (q == null)
            return null;
        var type = ResolveType(q.Value.Uri, q.Value.Name);
        if (type != null && !string.IsNullOrEmpty(type.FullName))
            return type.FullName;
        var m = Regex.Match(q.Value.Uri, @"^(?:using:|clr-namespace:)([^;]+)");
        return m.Success ? $"{m.Groups[1].Value.Trim()}.{q.Value.Name}" : null;
    }

    bool Skip(string ns) => ns == XamlDocument.XamlNamespace || ns == XamlDocument.MarkupCompatibility || _doc.IgnorableNamespaces.Contains(ns);

    bool NamespaceKnown(string ns) => NamespaceTypes(ns) != null;

    Dictionary<string, MetadataType>? NamespaceTypes(string ns)
    {
        if (_metadata == null)
            return null;
        if (_metadata.Namespaces.TryGetValue(ns, out var types))
            return types;
        if (ns.StartsWith("clr-namespace:") && !ns.Contains(";assembly="))
            return _metadata.Namespaces.FirstOrDefault(kv => kv.Key.StartsWith(ns + ";assembly=")).Value;
        return null;
    }

    public MetadataType? ResolveType(string ns, string name) =>
        NamespaceTypes(ns) is { } types && types.TryGetValue(name, out var t) ? t : null;

    static MetadataProperty? FindProperty(MetadataType type, string name) => type.Properties.FirstOrDefault(p => p.Name == name);
    static MetadataEvent? FindEvent(MetadataType type, string name) => type.Events.FirstOrDefault(e => e.Name == name);

    static IEnumerable<ISymbol> AllMembers(INamedTypeSymbol type)
    {
        for (INamedTypeSymbol? t = type; t != null; t = t.BaseType)
            foreach (var m in t.GetMembers())
                yield return m;
        foreach (var i in type.AllInterfaces)
            foreach (var m in i.GetMembers())
                yield return m;
    }

    static ISymbol? FindMember(INamedTypeSymbol type, string name) =>
        AllMembers(type).FirstOrDefault(s => s.Name == name && s is IPropertySymbol or IMethodSymbol or IFieldSymbol { IsImplicitlyDeclared: false });

    Diagnostic UnknownType(Range range, string name, string ns)
    {
        var names = NamespaceTypes(ns)?.Keys ?? Enumerable.Empty<string>();
        return Make(range, $"Type '{name}' not found in namespace '{ns}'", DiagnosticSeverity.Error, "AVLS0002", Suggest(name, names));
    }

    static Diagnostic UnknownMember(Range range, string name, MetadataType owner)
    {
        var names = owner.Properties.Select(p => p.Name).Concat(owner.Events.Select(e => e.Name)).Distinct();
        return Make(range, $"Property or event '{name}' not found on '{owner.Name}'", DiagnosticSeverity.Error, "AVLS0003", Suggest(name, names));
    }

    static Diagnostic Make(Range range, string message, DiagnosticSeverity severity, string code, string[]? suggestions = null) => new()
    {
        Range = range,
        Message = message,
        Severity = severity,
        Source = Source,
        Code = code,
        Data = suggestions is { Length: > 0 } ? Newtonsoft.Json.Linq.JToken.FromObject(new { suggestions }) : null,
    };

    /// <summary>Closest names (edit distance), best first.</summary>
    public static string[] Suggest(string name, IEnumerable<string> candidates)
    {
        int max = Math.Max(2, name.Length / 3);
        return candidates
            .Select(c => (c, d: Distance(name.ToLowerInvariant(), c.ToLowerInvariant())))
            .Where(x => x.d <= max)
            .OrderBy(x => x.d).ThenBy(x => x.c.Length)
            .Take(3).Select(x => x.c).ToArray();
    }

    static int Distance(string a, string b)
    {
        var d = new int[a.Length + 1, b.Length + 1];
        for (int i = 0; i <= a.Length; i++) d[i, 0] = i;
        for (int j = 0; j <= b.Length; j++) d[0, j] = j;
        for (int i = 1; i <= a.Length; i++)
            for (int j = 1; j <= b.Length; j++)
            {
                int cost = a[i - 1] == b[j - 1] ? 0 : 1;
                d[i, j] = Math.Min(Math.Min(d[i - 1, j] + 1, d[i, j - 1] + 1), d[i - 1, j - 1] + cost);
                if (i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1])
                    d[i, j] = Math.Min(d[i, j], d[i - 2, j - 2] + 1); // transposition
            }
        return d[a.Length, b.Length];
    }
}
