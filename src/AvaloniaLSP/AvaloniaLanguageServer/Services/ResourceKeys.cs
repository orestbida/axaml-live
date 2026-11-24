using System.Text.RegularExpressions;

namespace AvaloniaLanguageServer.Services;

/// <summary>Resource keys (x:Key) of AXAML texts and well-known theme resource keys.</summary>
public static class ResourceKeys {
    public sealed record Definition(string Key, string Type, int Offset, int Length, string Source);

    // the element whose start tag contains x:Key="..." (attributes may come in any order)
    static readonly Regex KeyedElement = new(@"<(?<type>[A-Za-z_][\w:.]*)(?<attrs>[^<>]*?)\bx:Key\s*=\s*(?<q>[""'])(?<key>[^""']+)\k<q>", RegexOptions.Compiled);

    public static IEnumerable<Definition> In(string text) {
        foreach (Match m in KeyedElement.Matches(text)) {
            var tagEnd = text.IndexOf('>', m.Index);
            var source = tagEnd < 0 ? m.Value : text[m.Index..(tagEnd + 1)];
            yield return new Definition(m.Groups["key"].Value, m.Groups["type"].Value, m.Groups["key"].Index, m.Groups["key"].Length,
                Regex.Replace(source, @"\s+", " "));
        }
    }

    /// <summary>Commonly used resources of the Fluent and Simple themes (not visible in the project's files).</summary>
    public static readonly (string Key, string Theme)[] Theme = {
        ("SystemAccentColor", "Fluent"), ("SystemAccentColorLight1", "Fluent"), ("SystemAccentColorLight2", "Fluent"),
        ("SystemAccentColorLight3", "Fluent"), ("SystemAccentColorDark1", "Fluent"), ("SystemAccentColorDark2", "Fluent"),
        ("SystemAccentColorDark3", "Fluent"), ("SystemRegionBrush", "Fluent"), ("SystemRegionColor", "Fluent"),
        ("SystemControlHighlightAccentBrush", "Fluent"), ("SystemControlForegroundBaseHighBrush", "Fluent"),
        ("SystemControlForegroundBaseMediumBrush", "Fluent"), ("SystemControlForegroundBaseLowBrush", "Fluent"),
        ("SystemControlBackgroundAltHighBrush", "Fluent"), ("SystemControlBackgroundBaseLowBrush", "Fluent"),
        ("SystemControlBackgroundChromeMediumBrush", "Fluent"), ("SystemControlBackgroundChromeMediumLowBrush", "Fluent"),
        ("TextControlForeground", "Fluent"), ("TextControlBackground", "Fluent"), ("TextControlBorderBrush", "Fluent"),
        ("ButtonBackground", "Fluent"), ("ButtonForeground", "Fluent"), ("ButtonBorderBrush", "Fluent"),
        ("ControlCornerRadius", "Fluent"), ("OverlayCornerRadius", "Fluent"), ("ContentControlThemeFontFamily", "Fluent"),
        ("ControlContentThemeFontSize", "Fluent"), ("SolidBackgroundFillColorBase", "Fluent 2"),
        ("TextFillColorPrimaryBrush", "Fluent 2"), ("TextFillColorSecondaryBrush", "Fluent 2"),
        ("CardBackgroundFillColorDefaultBrush", "Fluent 2"), ("CardStrokeColorDefaultBrush", "Fluent 2"),
        ("AccentFillColorDefaultBrush", "Fluent 2"),
        ("ThemeBackgroundBrush", "Simple"), ("ThemeForegroundBrush", "Simple"), ("ThemeAccentBrush", "Simple"),
        ("ThemeBorderMidBrush", "Simple"), ("ThemeControlMidBrush", "Simple"), ("ThemeControlHighBrush", "Simple"),
        ("HighlightBrush", "Simple"), ("ErrorBrush", "Simple"), ("FontSizeSmall", "Simple"), ("FontSizeNormal", "Simple"),
        ("FontSizeLarge", "Simple"),
    };
}
