import * as assert from "assert";
import { findElementAcrossViews, findElementByPath } from "../../xaml/inspect";
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

suite("select mode: views inside the previewed view", () => {
    const main = {
        file: "/app/MainWindow.axaml",
        text: `<Window ${ns} xmlns:v="using:App" x:Class="App.MainWindow">
    <StackPanel>
        <v:Card />
        <ContentControl Content="{Binding Page}" />
    </StackPanel>
</Window>`,
    };
    const card = {
        file: "/app/Card.axaml",
        text: `<UserControl ${ns} xmlns:v="using:App" x:Class="App.Card">
    <StackPanel>
        <TextBlock Text="title" />
        <Button x:Name="Save" Content="Save" />
        <v:Badge />
    </StackPanel>
</UserControl>`,
    };
    const badge = {
        file: "/app/Badge.axaml",
        text: `<UserControl ${ns} x:Class="App.Badge"><Border><TextBlock x:Name="Count" /></Border></UserControl>`,
    };
    const views = new Map([
        ["App.Card", card],
        ["App.Badge", badge],
    ]);
    const resolve = (t: string) => views.get(t);
    const step = (type: string, index = 0, fullType?: string) => ({ type, index, fullType });

    test("a view used by its type: the element inside its own file", () => {
        const r = findElementAcrossViews(
            main,
            [step("MainWindow", 0, "App.MainWindow"), step("StackPanel"), step("Card", 0, "App.Card"), step("StackPanel"), step("Button")],
            0,
            resolve
        );
        assert.strictEqual(r?.file, card.file);
        assert.strictEqual(tagAt(card.text, r!.element.start), `<Button x:Name="Save" Content="Save" />`);
        assert.strictEqual(r!.pathIndex, 4);
    });

    test("a view created by a data template (not in the file): continues in its file", () => {
        const r = findElementAcrossViews(
            main,
            [
                step("MainWindow"),
                step("StackPanel"),
                step("ContentControl"),
                step("Card", 0, "App.Card"),
                step("StackPanel"),
                step("TextBlock"),
            ],
            0,
            resolve
        );
        assert.strictEqual(r?.file, card.file);
        assert.strictEqual(tagAt(card.text, r!.element.start), `<TextBlock Text="title" />`);
    });

    test("a view inside a view inside the previewed view", () => {
        const r = findElementAcrossViews(
            main,
            [
                step("MainWindow"),
                step("StackPanel"),
                step("Card", 0, "App.Card"),
                step("StackPanel"),
                step("Badge", 0, "App.Badge"),
                step("Border"),
                step("TextBlock"),
            ],
            0,
            resolve
        );
        assert.strictEqual(r?.file, badge.file);
        assert.strictEqual(tagAt(badge.text, r!.element.start), `<TextBlock x:Name="Count" />`);
        assert.strictEqual(r!.pathIndex, 6);
    });

    test("the view's own element when nothing inside it matches", () => {
        const r = findElementAcrossViews(
            main,
            [step("MainWindow"), step("StackPanel"), step("Card", 0, "App.Card"), step("Grid")],
            0,
            resolve
        );
        assert.strictEqual(r?.file, card.file);
        assert.ok(tagAt(card.text, r!.element.start).startsWith("<UserControl"));
        assert.strictEqual(r!.pathIndex, 2);
    });

    test("a view without an .axaml in the workspace: the element that uses it", () => {
        const r = findElementAcrossViews(
            main,
            [step("MainWindow"), step("StackPanel"), step("Card", 0, "App.Card"), step("StackPanel"), step("Button")],
            0,
            () => undefined
        );
        assert.strictEqual(r?.file, main.file);
        assert.strictEqual(tagAt(main.text, r!.element.start), "<v:Card />");
    });
});
