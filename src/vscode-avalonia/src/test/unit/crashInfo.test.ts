import * as assert from "assert";
import { CrashGuard, summarizeCrash } from "../../services/crashInfo";

suite("previewer crash summary", () => {
	const log = [
		"info: something",
		"Unhandled exception. ",
		"System.NullReferenceException: Object reference not set to an instance of an object.",
		"   at DemoCenter.Views.DataGridLiveDataPageView.OnLoaded(RoutedEventArgs e) in /home/orest/controls-demo/DemoCenter/DemoCenter/Views/DataGrid/DataGridLiveDataPageView.axaml.cs:line 25",
		"   at Avalonia.Controls.Control.<>c.<.cctor>b__70_0()",
		"   at Avalonia.Threading.DispatcherOperation.InvokeCore()",
		"   at Avalonia.Designer.HostApp.Program.Main(String[] args)",
	];

	test("names the exception and the first user frame", () => {
		assert.strictEqual(
			summarizeCrash(log, null, "SIGABRT"),
			"Previewer crashed: NullReferenceException in DataGridLiveDataPageView.OnLoaded (DataGridLiveDataPageView.axaml.cs:25)"
		);
	});

	test("Windows paths and frames without source", () => {
		assert.strictEqual(
			summarizeCrash([
				"Unhandled exception. System.InvalidOperationException: Boom",
				"   at App.Views.Main.Ctor() in C:\\src\\App\\Views\\Main.axaml.cs:line 7",
			], -532462766, null),
			"Previewer crashed: InvalidOperationException in Main.Ctor (Main.axaml.cs:7)"
		);
		assert.strictEqual(
			summarizeCrash(["Unhandled exception. System.Exception: x", "   at Lib.Thing.Run()"], 1, null),
			"Previewer crashed: Exception in Thing.Run"
		);
	});

	test("without an exception: exit code or signal", () => {
		assert.strictEqual(summarizeCrash(["bye"], 3, null), "Previewer process exited with code 3");
		assert.strictEqual(summarizeCrash([], null, "SIGKILL"), "Previewer process was terminated (SIGKILL)");
	});
});

suite("previewer crash guard", () => {
	test("restarts after a crash, stops when the same file crashes twice in a row", () => {
		const g = new CrashGuard();
		assert.strictEqual(g.onCrash("a.axaml"), true);
		assert.strictEqual(g.onCrash("a.axaml"), false);
		// another file, or a file switch or an edit in between, allows restarting again
		assert.strictEqual(g.onCrash("b.axaml"), true);
		g.reset();
		assert.strictEqual(g.onCrash("b.axaml"), true);
	});
});

suite("previewer crash summary: messages", () => {
	test("includes the exception message when no user frame is known", () => {
		assert.strictEqual(
			summarizeCrash(["Unhandled exception. System.IO.IOException: The pipe is broken.", "   at System.IO.Pipe.Write()"], 134, null),
			"Previewer crashed: IOException: The pipe is broken."
		);
	});

	test("explains a missing BuildAvaloniaApp method", () => {
		const out = summarizeCrash([
			"Unhandled exception. System.InvalidOperationException: Unable to create AppBuilder from type \"DrmFps.Program\". Input type either needs to have BuildAvaloniaApp -> AppBuilder method or inherit Application type.",
			"   at Avalonia.DesignerSupport.Remote.RemoteDesignerEntryPoint.Main(String[] args)",
		], 134, null);
		assert.match(out, /DrmFps\.Program has no BuildAvaloniaApp\(\)/);
		assert.match(out, /public static AppBuilder BuildAvaloniaApp\(\)/);
	});
});
