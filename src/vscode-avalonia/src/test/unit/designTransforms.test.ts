import * as assert from "assert";
import { applyDesignSize, applyThemeVariant } from "../../xaml/designTransforms";
import { formFactors, resolveFormFactor } from "../../xaml/formFactors";

const windowXaml = `<Window xmlns="https://github.com/avaloniaui"
        xmlns:d="http://schemas.microsoft.com/expression/blend/2008"
        xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
        mc:Ignorable="d" d:DesignWidth="800" d:DesignHeight="450"
        Title="App">
    <TextBlock Text="Hi"/>
</Window>`;

const userControlXaml = `<UserControl xmlns="https://github.com/avaloniaui" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
    <UserControl.Styles>
        <Style Selector="TextBlock"/>
    </UserControl.Styles>
    <StackPanel>
        <TextBlock Text="Hi"/>
    </StackPanel>
</UserControl>`;

const stylesXaml = `<Styles xmlns="https://github.com/avaloniaui">
    <Design.PreviewWith>
        <Border Padding="20"><Button Content="x"/></Border>
    </Design.PreviewWith>
    <Style Selector="Button"/>
</Styles>`;

suite("design transforms: theme variant", () => {
	test("Default leaves the XAML untouched", () => {
		assert.strictEqual(applyThemeVariant(windowXaml, "Default"), windowXaml);
	});

	test("Window root gets RequestedThemeVariant", () => {
		const out = applyThemeVariant(windowXaml, "Dark");
		assert.match(out, /<Window RequestedThemeVariant="Dark"/);
		assert.strictEqual(out.match(/RequestedThemeVariant/g)!.length, 1);
	});

	test("an existing RequestedThemeVariant on the root is replaced", () => {
		const out = applyThemeVariant(windowXaml.replace('Title="App"', 'Title="App" RequestedThemeVariant="Light"'), "Dark");
		assert.strictEqual(out.match(/RequestedThemeVariant="Dark"/g)!.length, 1);
		assert.ok(!out.includes('RequestedThemeVariant="Light"'));
	});

	test("UserControl content is wrapped in a ThemeVariantScope, property elements stay direct children", () => {
		const out = applyThemeVariant(userControlXaml, "Dark");
		assert.match(out, /<UserControl\.Styles>[\s\S]*<\/UserControl\.Styles>\s*<ThemeVariantScope RequestedThemeVariant="Dark">\s*<StackPanel>/);
		assert.match(out, /<\/StackPanel>\s*<\/ThemeVariantScope>\s*<\/UserControl>/);
	});

	test("Styles: Design.PreviewWith content is wrapped", () => {
		const out = applyThemeVariant(stylesXaml, "Light");
		assert.match(out, /<Design\.PreviewWith>\s*<ThemeVariantScope RequestedThemeVariant="Light">\s*<Border/);
		assert.match(out, /<\/Border>\s*<\/ThemeVariantScope>\s*<\/Design\.PreviewWith>/);
	});

	test("unparsable XAML is returned unchanged", () => {
		assert.strictEqual(applyThemeVariant("<Window", "Dark"), "<Window");
	});
});

suite("design transforms: design size", () => {
	test("existing d:DesignWidth/d:DesignHeight are rewritten (they win over Design.Width)", () => {
		const out = applyDesignSize(windowXaml, 390, 844);
		assert.match(out, /d:DesignWidth="390"/);
		assert.match(out, /d:DesignHeight="844"/);
		assert.ok(!out.includes("Design.Width"));
	});

	test("Design.Width/Height are added when the root has no design size", () => {
		const out = applyDesignSize(userControlXaml, 768, 1024);
		assert.match(out, /^<UserControl Design\.Width="768" Design\.Height="1024" /);
	});

	test("only the root element is changed", () => {
		const xaml = `<UserControl xmlns="https://github.com/avaloniaui"><Border d:DesignWidth="5"/></UserControl>`;
		const out = applyDesignSize(xaml, 100, 200);
		assert.ok(out.includes('<Border d:DesignWidth="5"/>'));
	});
});

suite("form factors", () => {
	test("presets have sizes and a default without size", () => {
		assert.ok(formFactors.find((f) => f.id === "default" && !f.width));
		const phone = formFactors.find((f) => f.id === "phone");
		assert.ok(phone && phone.width! < phone.height!);
	});

	test("rotation swaps width and height", () => {
		const phone = resolveFormFactor("phone", false)!;
		const rotated = resolveFormFactor("phone", true)!;
		assert.strictEqual(rotated.width, phone.height);
		assert.strictEqual(rotated.height, phone.width);
	});

	test("default form factor resolves to no size", () => {
		assert.strictEqual(resolveFormFactor("default", true), undefined);
	});
});
