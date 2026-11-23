import { getAttribute, localName, parseXml, XmlElement } from "./xmlTree";

/**
 * Rewrites the XAML that is sent to the previewer (never the user's file) to apply previewer options.
 * Verified against the Avalonia 12 designer host:
 *  - `RequestedThemeVariant` works on TopLevel roots (Window); `Design` has no theme property, so other roots get a
 *    ThemeVariantScope around their content (Styles/ResourceDictionary: around the Design.PreviewWith content).
 *  - `d:DesignWidth/Height` win over `Design.Width/Height`, so existing ones are rewritten instead of adding new ones.
 */

export type ThemeVariant = "Default" | "Light" | "Dark";

export function applyThemeVariant(xaml: string, variant: ThemeVariant | string): string {
	if (!variant || variant === "Default") {
		return xaml;
	}
	const root = parseXml(xaml)?.root;
	if (!root) {
		return xaml;
	}
	const rootName = localName(root.name);

	if (/Window$/.test(rootName) || rootName === "TopLevel") {
		return setRootAttribute(xaml, root, "RequestedThemeVariant", variant);
	}

	const previewWith = rootName === "Styles" || rootName === "ResourceDictionary"
		? root.children.find((c): c is XmlElement => c.kind === "element" && c.name === "Design.PreviewWith")
		: undefined;
	return wrapContent(xaml, previewWith ?? root, variant);
}

export function applyDesignSize(xaml: string, width: number, height: number): string {
	const root = parseXml(xaml)?.root;
	if (!root) {
		return xaml;
	}
	const edits: { start: number; end: number; text: string }[] = [];
	const missing: string[] = [];
	for (const [suffix, value, fallback] of [
		["DesignWidth", width, "Design.Width"],
		["DesignHeight", height, "Design.Height"],
	] as const) {
		const attr = root.attributes.find((a) => a.name.includes(":") && localName(a.name) === suffix);
		if (attr) {
			edits.push({ start: attr.valueStart, end: attr.valueEnd, text: String(value) });
		} else {
			missing.push(`${fallback}="${value}"`);
		}
	}
	if (missing.length) {
		edits.push({ start: root.nameEnd, end: root.nameEnd, text: " " + missing.join(" ") });
	}
	return applyEdits(xaml, edits);
}

function setRootAttribute(xaml: string, root: XmlElement, name: string, value: string): string {
	const existing = getAttribute(root, name);
	if (existing) {
		return applyEdits(xaml, [{ start: existing.valueStart, end: existing.valueEnd, text: value }]);
	}
	return applyEdits(xaml, [{ start: root.nameEnd, end: root.nameEnd, text: ` ${name}="${value}"` }]);
}

/** Wraps the content (not property elements like `UserControl.Styles`) of `el` in a ThemeVariantScope. */
function wrapContent(xaml: string, el: XmlElement, variant: string): string {
	const content = el.children.filter(
		(c) => (c.kind === "element" && !localName(c.name).includes(".")) || (c.kind === "text" && c.raw.trim() !== "")
	);
	if (!content.length) {
		return xaml;
	}
	const start = content[0].start;
	const end = content[content.length - 1].end;
	return applyEdits(xaml, [
		{ start: end, end, text: "</ThemeVariantScope>" },
		{ start, end: start, text: `<ThemeVariantScope RequestedThemeVariant="${variant}">` },
	]);
}

function applyEdits(text: string, edits: { start: number; end: number; text: string }[]): string {
	return [...edits]
		.sort((a, b) => b.start - a.start)
		.reduce((t, e) => t.substring(0, e.start) + e.text + t.substring(e.end), text);
}
