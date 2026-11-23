/**
 * The solution parser prints one JSON object. When global.json requests an SDK that is not installed, the native
 * .NET host also writes the list of installed SDKs to stdout (before or after it), which the parser cannot suppress.
 */
export function parseSolutionParserOutput(stdout: string): any {
	const start = stdout.indexOf("{");
	const end = stdout.lastIndexOf("}");
	if (start < 0 || end < start) {
		throw new Error(`The solution parser printed no solution data: ${stdout.trim().slice(0, 300)}`);
	}
	return JSON.parse(stdout.substring(start, end + 1));
}

export interface MissingSdk {
	version: string;
	globalJson?: string;
	downloadUrl: string;
}

/** Recognizes "A compatible .NET SDK was not found" (global.json pins an SDK that is not installed). */
export function missingSdk(output: string): MissingSdk | undefined {
	if (!/compatible \.NET SDK was not found/i.test(output)) {
		return undefined;
	}
	const version = /Requested SDK version:\s*(\S+)/i.exec(output)?.[1] ?? "";
	const globalJson = /global\.json file:\s*(.+)/i.exec(output)?.[1].trim();
	const channel = /^(\d+\.\d+)/.exec(version)?.[1];
	return { version, globalJson, downloadUrl: `https://dotnet.microsoft.com/download/dotnet${channel ? `/${channel}` : ""}` };
}
