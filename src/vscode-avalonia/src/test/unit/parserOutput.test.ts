import * as assert from "assert";
import { missingSdk, parseSolutionParserOutput } from "../../services/parserOutput";

suite("solution parser output", () => {
	test("plain JSON", () => {
		assert.deepStrictEqual(parseSolutionParserOutput(`{"solution":"a","projects":[]}\n`), { solution: "a", projects: [] });
	});

	test("native SDK resolution messages around the JSON are ignored", () => {
		// hostfxr writes the installed SDK list to stdout when global.json requests a missing SDK
		const out = `8.0.134 [/usr/lib/dotnet/sdk]\n{\n  "solution": "/x/Dock.slnx",\n  "projects": [{ "name": "A" }]\n}\n8.0.134 [/usr/lib/dotnet/sdk]\n10.0.115 [/usr/lib/dotnet/sdk]\n`;
		assert.deepStrictEqual(parseSolutionParserOutput(out), { solution: "/x/Dock.slnx", projects: [{ name: "A" }] });
	});

	test("no JSON: a clear error", () => {
		assert.throws(() => parseSolutionParserOutput("10.0.115 [/usr/lib/dotnet/sdk]\n"), /no solution data/);
	});
});

suite("missing SDK requested by global.json", () => {
	test("is recognized in dotnet output", () => {
		const out = "A compatible .NET SDK was not found.\n\nRequested SDK version: 10.0.201\nglobal.json file: /home/me/Dock/global.json\n\nInstalled SDKs:\n";
		assert.deepStrictEqual(missingSdk(out), {
			version: "10.0.201",
			globalJson: "/home/me/Dock/global.json",
			downloadUrl: "https://dotnet.microsoft.com/download/dotnet/10.0",
		});
		assert.strictEqual(missingSdk("error CS1002: ; expected"), undefined);
	});
});
