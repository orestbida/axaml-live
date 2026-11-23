import * as assert from "assert";
import { findStyleMatches } from "../../xaml/styleMatcher";

const xaml = `<UserControl xmlns="https://github.com/avaloniaui" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <UserControl.Styles>
    <Style Selector="Button.primary">
      <Setter Property="Background" Value="Blue"/>
      <Style Selector="^:pointerover">
        <Setter Property="Background" Value="Navy"/>
      </Style>
    </Style>
    <Style Selector="StackPanel > TextBlock"/>
    <Style Selector="Border TextBlock#title, Grid"/>
    <Style Selector="TextBox[IsReadOnly=True]"/>
    <Style Selector="Button /template/ ContentPresenter"/>
  </UserControl.Styles>
  <StackPanel>
    <Button Classes="primary big" Content="A"/>
    <Button Content="B"/>
    <TextBlock Text="direct child"/>
    <Border>
      <TextBlock x:Name="title" Text="t"/>
      <TextBlock Text="no"/>
    </Border>
    <TextBox IsReadOnly="True"/>
    <TextBox/>
  </StackPanel>
  <Grid/>
</UserControl>`;

function selectorsFor(text: string): string[] {
    const offset = xaml.indexOf(text);
    assert.ok(offset >= 0, `missing ${text}`);
    return findStyleMatches(xaml).find((m) => m.offset === offset)?.selectors ?? [];
}

suite("style matcher", () => {
    test("type + class, nested ^ selectors", () => {
        assert.deepStrictEqual(selectorsFor(`<Button Classes="primary big"`), [
            "Button.primary",
            "Button.primary:pointerover",
            "Button /template/ ContentPresenter",
        ]);
    });

    test("class must be present", () => {
        assert.deepStrictEqual(selectorsFor(`<Button Content="B"`), ["Button /template/ ContentPresenter"]);
    });

    test("child combinator", () => {
        assert.deepStrictEqual(selectorsFor(`<TextBlock Text="direct child"`), ["StackPanel > TextBlock"]);
        assert.deepStrictEqual(selectorsFor(`<TextBlock Text="no"`), []);
    });

    test("descendant + name, selector lists", () => {
        assert.deepStrictEqual(selectorsFor(`<TextBlock x:Name="title"`), ["Border TextBlock#title"]);
        assert.deepStrictEqual(selectorsFor(`<Grid/>`), ["Grid"]);
    });

    test("property selectors compare attribute values", () => {
        assert.deepStrictEqual(selectorsFor(`<TextBox IsReadOnly="True"/>`), ["TextBox[IsReadOnly=True]"]);
        assert.deepStrictEqual(selectorsFor(`<TextBox/>`), []);
    });

    test("Style and Setter elements themselves are not decorated", () => {
        const styleOffset = xaml.indexOf(`<Style Selector="Button.primary">`);
        assert.ok(!findStyleMatches(xaml).some((m) => m.offset === styleOffset));
    });

    test("broken XAML yields no matches instead of throwing", () => {
        assert.deepStrictEqual(findStyleMatches(`<A><Style Selector="A"`), []);
    });
});
