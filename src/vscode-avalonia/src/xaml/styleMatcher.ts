import { getAttribute, localName, parseXml, walk, XmlElement } from "./xmlTree";

/**
 * Finds which `<Style Selector="...">` declared in the same file match each element (for 🎨 badges).
 * Supports type, .class, #name, [Prop=value], pseudo-classes (ignored for matching: they are state dependent),
 * descendant (space) and child (>) combinators, selector lists (,), nested styles (^) and `/template/`
 * (the badge goes on the templated control).
 */
export interface StyleMatch {
	offset: number; // '<' of the element
	nameEnd: number; // offset right after the tag name
	startTagEnd: number;
	selectors: string[];
}

interface Compound {
	type?: string;
	classes: string[];
	name?: string;
	props: [string, string][];
}

interface Step {
	compound: Compound;
	combinator?: " " | ">"; // relation to the previous (left) step
}

const styleContainers = new Set(["Style", "Styles", "ControlTheme", "Setter"]);

export function findStyleMatches(xaml: string): StyleMatch[] {
	const root = parseXml(xaml)?.root;
	if (!root) {
		return [];
	}

	const selectors: { text: string; steps: Step[] }[] = [];
	collectStyles(root, undefined, selectors);
	if (!selectors.length) {
		return [];
	}

	const result: StyleMatch[] = [];
	for (const el of walk(root)) {
		if (!isTarget(el)) {
			continue;
		}
		const matched = selectors.filter((s) => matches(el, s.steps)).map((s) => s.text);
		if (matched.length) {
			result.push({ offset: el.start, nameEnd: el.nameEnd, startTagEnd: el.startTagEnd, selectors: matched });
		}
	}
	return result;
}

function isTarget(el: XmlElement): boolean {
	if (localName(el.name).includes(".")) {
		return false; // property element
	}
	for (let e: XmlElement | undefined = el; e; e = e.parent) {
		if (styleContainers.has(localName(e.name)) || /\.Styles$/.test(e.name)) {
			return false;
		}
	}
	return true;
}

function collectStyles(el: XmlElement, parentSelector: string | undefined, out: { text: string; steps: Step[] }[]) {
	let selectorForChildren = parentSelector;
	if (localName(el.name) === "Style") {
		const raw = getAttribute(el, "Selector")?.value;
		if (raw) {
			const resolved = parentSelector !== undefined ? raw.replace(/\^/g, parentSelector) : raw;
			for (const alt of splitList(resolved)) {
				const steps = parseSelector(alt);
				if (steps) {
					out.push({ text: alt, steps });
				}
			}
			selectorForChildren = resolved;
		}
	} else if (localName(el.name) === "ControlTheme") {
		return; // nested styles of control themes target the theme's control, not elements in this file
	}
	for (const c of el.children) {
		if (c.kind === "element") {
			collectStyles(c, selectorForChildren, out);
		}
	}
}

function splitList(s: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let cur = "";
	for (const ch of s) {
		if (ch === "(" || ch === "[") {
			depth++;
		} else if (ch === ")" || ch === "]") {
			depth--;
		}
		if (ch === "," && depth === 0) {
			parts.push(cur.trim());
			cur = "";
		} else {
			cur += ch;
		}
	}
	if (cur.trim()) {
		parts.push(cur.trim());
	}
	return parts;
}

/** Parses one selector (no commas). Steps are left-to-right. Undefined when unsupported. */
function parseSelector(sel: string): Step[] | undefined {
	const templateAt = sel.indexOf("/template/");
	if (templateAt >= 0) {
		sel = sel.substring(0, templateAt);
	}
	const steps: Step[] = [];
	let i = 0;
	let combinator: " " | ">" | undefined;
	while (i < sel.length) {
		const ws = /^\s*(>)?\s*/.exec(sel.substring(i))!;
		if (ws[0].length) {
			if (steps.length) {
				combinator = ws[1] ? ">" : " ";
			}
			i += ws[0].length;
			continue;
		}
		const compound: Compound = { classes: [], props: [] };
		const type = /^(?:[A-Za-z_][\w]*\|)?([A-Za-z_][\w]*)/.exec(sel.substring(i));
		if (type) {
			compound.type = type[1];
			i += type[0].length;
		}
		for (;;) {
			const rest = sel.substring(i);
			let m: RegExpExecArray | null;
			if ((m = /^\.([\w-]+)/.exec(rest))) {
				compound.classes.push(m[1]);
			} else if ((m = /^#([\w-]+)/.exec(rest))) {
				compound.name = m[1];
			} else if ((m = /^\[\s*([\w.:]+)\s*=\s*([^\]]*)\]/.exec(rest))) {
				compound.props.push([m[1], m[2].trim()]);
			} else if ((m = /^:[\w-]+(\((?:[^()]|\([^()]*\))*\))?/.exec(rest))) {
				// pseudo-class or :is()/:not()/:nth-child(): state dependent, ignored
			} else {
				break;
			}
			i += m[0].length;
		}
		if (!compound.type && !compound.classes.length && !compound.name && !compound.props.length) {
			if (/^:/.test(sel.substring(i - 1))) {
				// selector made only of pseudo classes
			}
			if (i < sel.length && !/\s|>/.test(sel[i])) {
				return undefined;
			}
		}
		steps.push({ compound, combinator: steps.length ? combinator ?? " " : undefined });
		combinator = undefined;
	}
	return steps.length ? steps : undefined;
}

function matches(el: XmlElement, steps: Step[]): boolean {
	return matchFrom(el, steps, steps.length - 1);
}

function matchFrom(el: XmlElement, steps: Step[], index: number): boolean {
	if (!matchCompound(el, steps[index].compound)) {
		return false;
	}
	if (index === 0) {
		return true;
	}
	const combinator = steps[index].combinator;
	let parent = logicalParent(el);
	if (combinator === ">") {
		return !!parent && matchFrom(parent, steps, index - 1);
	}
	for (; parent; parent = logicalParent(parent)) {
		if (matchFrom(parent, steps, index - 1)) {
			return true;
		}
	}
	return false;
}

/** Parent in the logical tree: skips property elements (`Border.Child`). */
function logicalParent(el: XmlElement): XmlElement | undefined {
	let p = el.parent;
	while (p && localName(p.name).includes(".")) {
		p = p.parent;
	}
	return p;
}

function matchCompound(el: XmlElement, c: Compound): boolean {
	if (c.type && localName(el.name) !== c.type) {
		return false;
	}
	if (c.classes.length) {
		const classes = (getAttribute(el, "Classes")?.value ?? "").split(/\s+/).filter(Boolean);
		if (!c.classes.every((cls) => classes.includes(cls))) {
			return false;
		}
	}
	if (c.name) {
		const name = getAttribute(el, "x:Name")?.value ?? getAttribute(el, "Name")?.value;
		if (name !== c.name) {
			return false;
		}
	}
	for (const [prop, value] of c.props) {
		const attr = el.attributes.find((a) => a.name === prop || localName(a.name) === prop);
		if (!attr || attr.value.trim().toLowerCase() !== value.toLowerCase()) {
			return false;
		}
	}
	return true;
}
