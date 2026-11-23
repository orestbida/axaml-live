import * as assert from "assert";
import { codeBehindCandidates, findTypeDeclarationLine, getDataType, getXClass, viewModelNameCandidates } from "../../xaml/navigation";

const view = `<UserControl xmlns="https://github.com/avaloniaui"
             xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
             xmlns:vm="using:My.App.ViewModels"
             xmlns:old="clr-namespace:Legacy.Models;assembly=Legacy"
             x:Class="My.App.Views.SettingsView"
             x:DataType="vm:SettingsViewModel">
    <TextBlock x:DataType="old:Other"/>
</UserControl>`;

suite("navigation: XAML", () => {
	test("x:Class", () => {
		assert.strictEqual(getXClass(view), "My.App.Views.SettingsView");
	});

	test("x:DataType on the root resolves its xmlns (using:)", () => {
		assert.strictEqual(getDataType(view), "My.App.ViewModels.SettingsViewModel");
	});

	test("clr-namespace xmlns and {x:Type} syntax", () => {
		const x = view.replace('x:DataType="vm:SettingsViewModel"', 'x:DataType="{x:Type old:Thing}"');
		assert.strictEqual(getDataType(x), "Legacy.Models.Thing");
	});

	test("falls back to Design.DataContext", () => {
		const x = `<Window xmlns="https://github.com/avaloniaui" xmlns:vm="using:A.B">
    <Design.DataContext>
        <vm:MainViewModel />
    </Design.DataContext>
</Window>`;
		assert.strictEqual(getDataType(x), "A.B.MainViewModel");
	});

	test("no data type", () => {
		assert.strictEqual(getDataType(`<Window xmlns="https://github.com/avaloniaui"/>`), undefined);
	});
});

suite("navigation: naming conventions", () => {
	test("code-behind candidates", () => {
		assert.deepStrictEqual(codeBehindCandidates("/p/Views/Main.axaml"), ["/p/Views/Main.axaml.cs", "/p/Views/Main.axaml.fs"]);
	});

	test("view model names for views, windows and pages", () => {
		assert.deepStrictEqual(viewModelNameCandidates("SettingsView"), ["SettingsViewModel", "SettingsViewViewModel"]);
		assert.deepStrictEqual(viewModelNameCandidates("MainWindow"), ["MainWindowViewModel", "MainViewModel"]);
		assert.deepStrictEqual(viewModelNameCandidates("HomePage"), ["HomePageViewModel", "HomeViewModel"]);
		assert.deepStrictEqual(viewModelNameCandidates("Dashboard"), ["DashboardViewModel"]);
	});

	test("type declaration line in C# and F#", () => {
		const cs = "using X;\nnamespace A;\n\npublic partial class MainViewModel : ViewModelBase\n{\n}\n";
		assert.strictEqual(findTypeDeclarationLine(cs, "MainViewModel"), 3);
		assert.strictEqual(findTypeDeclarationLine("namespace A\ntype MainViewModel() =\n    inherit Base()", "MainViewModel"), 1);
		assert.strictEqual(findTypeDeclarationLine("public record MainViewModelX();", "MainViewModel"), -1);
		assert.strictEqual(findTypeDeclarationLine("public sealed record MainViewModel(string A);", "MainViewModel"), 0);
	});
});
