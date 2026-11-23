export interface XamlResult {
	error?: string;
	exceptionType?: string;
	message?: string;
	line?: number;
	column?: number;
}

/**
 * The previewer often reports compile errors only as text, e.g.
 * "System.AggregateException: One or more errors occurred. (Unable to resolve type X ... Line 13, position 10.) (...)"
 * Extracts distinct inner messages and the first line/position.
 */
export function parseXamlError(error: string): Partial<XamlResult> {
	const firstLine = error.split(/\r?\n/)[0];
	const typeMatch = /^([\w.]+(?:Exception|Error)):\s*/.exec(firstLine);
	let text = typeMatch ? firstLine.substring(typeMatch[0].length) : firstLine;

	if (/^One or more errors occurred\./.test(text)) {
		const inner: string[] = [];
		const re = /\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(text))) {
			if (!inner.includes(m[1])) {
				inner.push(m[1]);
			}
		}
		if (inner.length) {
			text = inner.join("\n");
		}
	}
	const pos = /Line (\d+), position (\d+)/i.exec(text);
	const type = typeMatch?.[1].split(".").pop();
	return {
		message: text,
		exceptionType: type === "AggregateException" ? undefined : type,
		line: pos ? Number(pos[1]) : undefined,
		column: pos ? Number(pos[2]) : undefined,
	};
}
