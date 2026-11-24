import * as assert from "assert";
import { findElementByPath } from "../../xaml/inspect";
import { themeWrapperDepth } from "../../xaml/designTransforms";

const ns = `xmlns="https://github.com/avaloniaui" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"`;

function tagAt(xaml: string, offset: number): string {
    return xaml.substring(offset, xaml.indexOf(">", offset) + 1);
}

suite("select mode: logical tree path to XAML element", () => {
    const window = `<Window ${ns} x:Class="App.MainWindow">
    <Window.Styles><Style Selector="Button" /></Window.Styles>
    <StackPanel>
        <TextBlock Text="a" />
        <Button Content="first" />
        <Border>
            <Border.Child>
                <Button Content="second" />
            </Border.Child>
        </Border>
    </StackPanel>
</Window>`;

    test("Window root: the window is the first step", () => {
        const r = findElementByPath(window, [
            { type: "MainWindow", index: 0 },
            { type: "StackPanel", index: 0 },
            { type: "Button", index: 0 },
            { type: "AccessText", index: 0 },
        ]);
        assert.ok(r);
        assert.strictEqual(tagAt(window, r.element.start), `<Button Content="first" />`);
        assert.strictEqual(r.pathIndex, 2, "template parts and generated text are not in the file");
    });

    test("through property elements (Border.Child)", () => {
        const r = findElementByPath(window, [
            { type: "MainWindow", index: 0 },
            { type: "StackPanel", index: 0 },
            { type: "Border", index: 0 },
            { type: "Button", index: 0 },
        ]);
        assert.strictEqual(tagAt(window, r!.element.start), `<Button Content="second" />`);
    });

    test("UserControl root: placed in a designer window; theme wrappers are skipped", () => {
        const view = `<UserControl ${ns}><Grid><TextBlock Text="x" /><TextBlock Text="y" /></Grid></UserControl>`;
        const path = [
            { type: "Window", index: 0 },
            { type: "MyView", index: 0 },
            { type: "ThemeVariantScope", index: 0 },
            { type: "Border", index: 0 },
            { type: "Border", index: 0 },
            { type: "Border", index: 0 },
            { type: "Grid", index: 0 },
            { type: "TextBlock", index: 1 },
        ];
        const r = findElementByPath(view, path, 4);
        assert.strictEqual(tagAt(view, r!.element.start), `<TextBlock Text="y" />`);
        assert.strictEqual(r!.pathIndex, 7);
        const plain = findElementByPath(view, [path[0], path[1], path[6], path[7]], 0);
        assert.strictEqual(tagAt(view, plain!.element.start), `<TextBlock Text="y" />`);
    });

    test("Styles: the Design.PreviewWith content is shown", () => {
        const styles = `<Styles ${ns}><Design.PreviewWith><Border><Button /></Border></Design.PreviewWith><Style Selector="Button" /></Styles>`;
        const r = findElementByPath(
            styles,
            [
                { type: "Window", index: 0 },
                { type: "ThemeVariantScope", index: 0 },
                { type: "Border", index: 0 },
                { type: "Button", index: 0 },
            ],
            1
        );
        assert.strictEqual(tagAt(styles, r!.element.start), `<Button />`);
    });

    test("a control that is not in the file selects its closest ancestor that is", () => {
        const r = findElementByPath(window, [
            { type: "MainWindow", index: 0 },
            { type: "StackPanel", index: 0 },
            { type: "ListBoxItem", index: 3 },
        ]);
        assert.strictEqual(tagAt(window, r!.element.start), "<StackPanel>");
    });
});

suite("select mode: theme wrapper depth", () => {
    test("Window: the theme is an attribute, nothing is wrapped", () => {
        assert.strictEqual(themeWrapperDepth(`<Window ${ns}><Grid /></Window>`, "Dark"), 0);
    });
    test("UserControl without a background: scope and three background borders", () => {
        assert.strictEqual(themeWrapperDepth(`<UserControl ${ns}><Grid /></UserControl>`, "Dark"), 4);
    });
    test("UserControl with a background: only the scope", () => {
        assert.strictEqual(themeWrapperDepth(`<UserControl ${ns} Background="Red"><Grid /></UserControl>`, "Light"), 1);
    });
    test("app theme: nothing is wrapped", () => {
        assert.strictEqual(themeWrapperDepth(`<UserControl ${ns}><Grid /></UserControl>`, "Default"), 0);
    });
});
