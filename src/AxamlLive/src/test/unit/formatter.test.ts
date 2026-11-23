import * as assert from "assert";
import { formatXaml, FormatOptions } from "../../xaml/formatter";

const base: FormatOptions = {
    indentSize: 4,
    useTabs: false,
    attributeWrapping: "alignWithFirst",
    attributeWrapThreshold: 3,
    markupExtensionArgWrapThreshold: 0,
    collapseBlankLines: true,
    quoteStyle: "double",
};
const fmt = (s: string, o: Partial<FormatOptions> = {}) => formatXaml(s, { ...base, ...o });

suite("XAML formatter", () => {
    test("re-indents nested elements", () => {
        const input = `<Window>\n<StackPanel>\n      <TextBlock/>\n  </StackPanel>\n</Window>`;
        assert.strictEqual(fmt(input), `<Window>\n    <StackPanel>\n        <TextBlock />\n    </StackPanel>\n</Window>\n`);
    });

    test("normalizes attribute spacing and keeps short tags on one line", () => {
        assert.strictEqual(fmt(`<Button   Content = "OK"    Width="80"/>`), `<Button Content="OK" Width="80" />\n`);
    });

    test("wraps attributes aligned with the first when over the threshold", () => {
        const out = fmt(`<Window><Button Content="OK" Width="80" Height="30" Margin="4"/></Window>`);
        assert.strictEqual(
            out,
            `<Window>\n    <Button Content="OK"\n            Width="80"\n            Height="30"\n            Margin="4" />\n</Window>\n`
        );
    });

    test("indent wrapping style", () => {
        const out = fmt(`<Button A="1" B="2" C="3" D="4"/>`, { attributeWrapping: "indent" });
        assert.strictEqual(out, `<Button\n    A="1"\n    B="2"\n    C="3"\n    D="4" />\n`);
    });

    test("no wrapping when disabled", () => {
        assert.strictEqual(fmt(`<Button A="1" B="2" C="3" D="4"/>`, { attributeWrapping: "none" }), `<Button A="1" B="2" C="3" D="4" />\n`);
        assert.strictEqual(fmt(`<Button A="1" B="2" C="3" D="4"/>`, { attributeWrapThreshold: 0 }), `<Button A="1" B="2" C="3" D="4" />\n`);
    });

    test("text-only elements stay inline; comments are kept and indented", () => {
        const input = `<StackPanel>\n<!-- a comment -->\n<TextBlock>Hello   world</TextBlock>\n</StackPanel>`;
        assert.strictEqual(fmt(input), `<StackPanel>\n    <!-- a comment -->\n    <TextBlock>Hello   world</TextBlock>\n</StackPanel>\n`);
    });

    test("collapses multiple blank lines into one, keeps one when present", () => {
        const input = `<StackPanel>\n<A/>\n\n\n\n<B/>\n<C/>\n</StackPanel>`;
        assert.strictEqual(fmt(input), `<StackPanel>\n    <A />\n\n    <B />\n    <C />\n</StackPanel>\n`);
        assert.strictEqual(
            fmt(input, { collapseBlankLines: false }),
            `<StackPanel>\n    <A />\n\n\n\n    <B />\n    <C />\n</StackPanel>\n`
        );
    });

    test("trailing whitespace does not break formatting (AvaloniaPro #160)", () => {
        assert.strictEqual(fmt(`<StackPanel>\t\n<A/>   \n</StackPanel>  \t\n`), `<StackPanel>\n    <A />\n</StackPanel>\n`);
    });

    test("tabs", () => {
        assert.strictEqual(fmt(`<A><B/></A>`, { useTabs: true }), `<A>\n\t<B />\n</A>\n`);
    });

    test("quote style single converts attribute quotes when safe", () => {
        assert.strictEqual(fmt(`<A B="1" C="it's"/>`, { quoteStyle: "single" }), `<A B='1' C="it's" />\n`);
    });

    test("markup extension arguments wrap over their threshold", () => {
        const out = fmt(`<TextBlock Text="{Binding Name, Mode=TwoWay, Converter={StaticResource C}, FallbackValue=x}"/>`, {
            markupExtensionArgWrapThreshold: 2,
        });
        // continuation lines align with the first argument: `<TextBlock Text="{Binding ` is 26 characters
        const pad = " ".repeat(`<TextBlock Text="{Binding `.length);
        assert.strictEqual(
            out,
            `<TextBlock Text="{Binding Name,\n${pad}Mode=TwoWay,\n${pad}Converter={StaticResource C},\n${pad}FallbackValue=x}" />\n`
        );
    });

    test("xml declaration, CDATA and xml:space=preserve are kept verbatim", () => {
        const input = `<?xml version="1.0"?>\n<A>\n<B xml:space="preserve">  keep\n   this </B>\n<C><![CDATA[ <raw> ]]></C>\n</A>`;
        assert.strictEqual(
            fmt(input),
            `<?xml version="1.0"?>\n<A>\n    <B xml:space="preserve">  keep\n   this </B>\n    <C><![CDATA[ <raw> ]]></C>\n</A>\n`
        );
    });

    test("mixed content keeps its inner text", () => {
        const input = `<TextBlock>Hello <Run Text="x"/> world</TextBlock>`;
        assert.strictEqual(fmt(input), `<TextBlock>Hello <Run Text="x"/> world</TextBlock>\n`);
    });

    test("malformed XAML is not formatted", () => {
        assert.strictEqual(fmt(`<A><B></A>`), undefined);
        assert.strictEqual(fmt(`<A B="1`), undefined);
    });

    test("formatting is idempotent on a real template", () => {
        const input = `<Window xmlns="https://github.com/avaloniaui"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        x:Class="A.MainWindow" Title="A">
    <Design.DataContext>
        <vm:MainViewModel />
    </Design.DataContext>

    <TextBlock Text="{Binding Greeting}" HorizontalAlignment="Center" VerticalAlignment="Center"/>
</Window>`;
        const once = fmt(input)!;
        assert.strictEqual(fmt(once), once);
    });
});
