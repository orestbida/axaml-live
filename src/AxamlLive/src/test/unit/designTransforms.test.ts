import * as assert from "assert";
import {
    applyDesignDataContext,
    applyDesignSize,
    applyPreviewBackground,
    applyThemeVariant,
    designDataHint,
} from "../../xaml/designTransforms";
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
        assert.match(out, /<UserControl\.Styles>[\s\S]*<\/UserControl\.Styles>\s*<ThemeVariantScope RequestedThemeVariant="Dark">/);
        assert.match(out, /<StackPanel>[\s\S]*<\/StackPanel>\s*(<\/Border>)*\s*<\/ThemeVariantScope>\s*<\/UserControl>/);
    });

    test("UserControl gets the window background of the chosen theme (Simple, Fluent and Fluent 2 brushes)", () => {
        const out = applyThemeVariant(userControlXaml, "Dark");
        const open =
            '<ThemeVariantScope RequestedThemeVariant="Dark"><Border Background="{DynamicResource ThemeBackgroundBrush}">' +
            '<Border Background="{DynamicResource SystemRegionBrush}"><Border Background="{DynamicResource SolidBackgroundFillColorBase}">';
        assert.ok(out.includes(open), out);
        assert.match(out, /<\/StackPanel>\s*<\/Border><\/Border><\/Border><\/ThemeVariantScope>/);
    });

    test("a view with its own background keeps it (no theme background on top)", () => {
        const own = userControlXaml.replace("<UserControl ", '<UserControl Background="#202020" ');
        const out = applyThemeVariant(own, "Dark");
        assert.ok(out.includes('<ThemeVariantScope RequestedThemeVariant="Dark">'));
        assert.ok(!out.includes("SystemRegionBrush"));
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

suite("design transforms: design data context", () => {
    const head = `<UserControl xmlns="https://github.com/avaloniaui" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" xmlns:vm="clr-namespace:App.ViewModels"`;

    test("instantiates the x:DataType of the root on the same line", () => {
        const xaml = `${head} x:DataType="vm:MainViewModel">\n  <TextBlock Text="{Binding Title}"/>\n</UserControl>`;
        const out = applyDesignDataContext(xaml);
        assert.strictEqual(
            out,
            `${head} x:DataType="vm:MainViewModel"><Design.DataContext><vm:MainViewModel/></Design.DataContext>\n  <TextBlock Text="{Binding Title}"/>\n</UserControl>`
        );
        assert.strictEqual(out.split("\n").length, xaml.split("\n").length, "line numbers are kept");
    });

    test("keeps an existing Design.DataContext or DataContext", () => {
        for (const xaml of [
            `${head} x:DataType="vm:A"><Design.DataContext><vm:B/></Design.DataContext></UserControl>`,
            `${head} x:DataType="vm:A" DataContext="{Binding X}"></UserControl>`,
            `${head} x:DataType="vm:A" Design.DataContext="{x:Null}"></UserControl>`,
            `${head} x:DataType="vm:A"><UserControl.DataContext><vm:B/></UserControl.DataContext></UserControl>`,
        ]) {
            assert.strictEqual(applyDesignDataContext(xaml), xaml, xaml);
        }
    });

    test("skips roots without a usable type", () => {
        for (const xaml of [
            `${head}></UserControl>`,
            `${head} x:DataType="vm:A"/>`,
            `${head} x:DataType="{x:Type vm:A}"></UserControl>`,
            `<Styles xmlns="https://github.com/avaloniaui" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" x:DataType="A"></Styles>`,
            `<UserControl xmlns="urn:other" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" x:DataType="A"></UserControl>`,
        ]) {
            assert.strictEqual(applyDesignDataContext(xaml), xaml, xaml);
        }
    });
});

suite("design transforms: design data context by ViewLocator convention", () => {
    const head = `<UserControl xmlns="https://github.com/avaloniaui" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"`;

    test("Views.XView -> ViewModels.XViewModel (the template's ViewLocator, reversed)", () => {
        const xaml = `${head} x:Class="Demo.Views.Grid.FilteringView">\n  <TextBlock/>\n</UserControl>`;
        assert.strictEqual(
            applyDesignDataContext(xaml),
            `${head} x:Class="Demo.Views.Grid.FilteringView" xmlns:designvm="clr-namespace:Demo.ViewModels.Grid"><Design.DataContext><designvm:FilteringViewModel/></Design.DataContext>\n  <TextBlock/>\n</UserControl>`
        );
    });

    test("x:DataType wins; no convention without View in the name or with an existing context", () => {
        const typed = `${head} xmlns:vm="clr-namespace:A" x:Class="Demo.Views.MainView" x:DataType="vm:Other"></UserControl>`;
        assert.ok(applyDesignDataContext(typed).includes("<vm:Other/>"));
        for (const xaml of [
            `${head} x:Class="Demo.MainWindow"></UserControl>`,
            `${head} x:Class="Demo.Views.MainView" DataContext="{Binding}"></UserControl>`,
            `${head} x:Class="Demo.Views.MainView"><Design.DataContext><x:Null/></Design.DataContext></UserControl>`,
        ]) {
            assert.strictEqual(applyDesignDataContext(xaml), xaml, xaml);
        }
    });
});

suite("design data hint", () => {
    test("names a view model without a parameterless constructor", () => {
        assert.strictEqual(
            designDataHint("Unable to find public constructor for type Dash:Dash.ViewModels.SettingsViewModel() Line 2, position 83."),
            "no design data: SettingsViewModel has no parameterless constructor (quick fix on x:DataType: create a design-time view model)"
        );
    });

    test("other failures: the first line of the error", () => {
        assert.strictEqual(designDataHint("Type 'Foo' not found\nmore"), "no design data: Type 'Foo' not found");
    });
});

suite("design transforms: preview background", () => {
    const head = `<UserControl xmlns="https://github.com/avaloniaui" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"`;

    test("theme: unchanged", () => {
        const xaml = `${head}><TextBlock/></UserControl>`;
        assert.strictEqual(applyPreviewBackground(xaml, "theme"), xaml);
        assert.strictEqual(applyPreviewBackground(xaml, ""), xaml);
    });

    test("a color, light or dark on a root without a background", () => {
        assert.strictEqual(
            applyPreviewBackground(`${head}><TextBlock/></UserControl>`, "#1a1a1a"),
            `<UserControl Background="#1a1a1a"${head.substring("<UserControl".length)}><TextBlock/></UserControl>`
        );
        assert.match(applyPreviewBackground(`${head}/>`, "dark"), /Background="#1E1E1E"/);
        assert.match(applyPreviewBackground(`${head}/>`, "light"), /Background="#FFFFFF"/);
        assert.match(applyPreviewBackground(`${head}/>`, "Black"), /Background="Black"/);
    });

    test("keeps the view's own background; skips resources and invalid values", () => {
        for (const xaml of [
            `${head} Background="Red"/>`,
            `${head}><UserControl.Background><SolidColorBrush Color="Red"/></UserControl.Background></UserControl>`,
            `<Styles xmlns="https://github.com/avaloniaui"></Styles>`,
            `<ResourceDictionary xmlns="https://github.com/avaloniaui"></ResourceDictionary>`,
        ]) {
            assert.strictEqual(applyPreviewBackground(xaml, "#000"), xaml, xaml);
        }
        assert.strictEqual(applyPreviewBackground(`${head}/>`, `"><Evil/`), `${head}/>`);
    });
});
