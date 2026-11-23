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

const avaloniaNamespace = "https://github.com/avaloniaui";
const xamlNamespace = "http://schemas.microsoft.com/winfx/2006/xaml";

/**
 * Views often declare `x:DataType` for compiled bindings but no `Design.DataContext`, so the preview shows an
 * empty shell. Adds `<Design.DataContext><vm:Type/></Design.DataContext>` for the root's x:DataType, on the line of
 * the root start tag so error line numbers stay correct. The caller falls back to the original XAML when the type
 * cannot be constructed.
 */
export function applyDesignDataContext(xaml: string): string {
	const root = parseXml(xaml)?.root;
	if (!root || root.selfClosing) {
		return xaml;
	}
	const ns = new Map(root.attributes.filter((a) => a.name === "xmlns" || a.name.startsWith("xmlns:"))
		.map((a) => [a.name === "xmlns" ? "" : a.name.substring(6), a.value]));
	const prefixOf = (uri: string) => [...ns].find(([, v]) => v === uri)?.[0];
	const x = prefixOf(xamlNamespace);
	const rootName = localName(root.name);
	if (x === undefined || ns.get("") !== avaloniaNamespace || root.name.includes(":") || ["Styles", "ResourceDictionary", "Application"].includes(rootName)) {
		return xaml;
	}
	const hasDataContext =
		root.attributes.some((a) => a.name === "DataContext" || a.name === "Design.DataContext") ||
		root.children.some((c) => c.kind === "element" && (c.name === "Design.DataContext" || c.name === `${root.name}.DataContext`));
	if (hasDataContext) {
		return xaml;
	}
	const at = root.startTagEnd;
	const dataType = getAttribute(root, `${x}:DataType`)?.value.trim();
	if (dataType) {
		return /^([A-Za-z_]\w*:)?[A-Za-z_][\w.]*$/.test(dataType)
			? applyEdits(xaml, [{ start: at, end: at, text: `<Design.DataContext><${dataType}/></Design.DataContext>` }])
			: xaml;
	}
	// no x:DataType: the template's ViewLocator maps Xxx.ViewModels.FooViewModel to Xxx.Views.FooView; reverse it
	const xClass = getAttribute(root, `${x}:Class`)?.value.trim();
	if (!xClass || !/^[\w.]+$/.test(xClass) || !/View$/.test(xClass)) {
		return xaml;
	}
	const viewModel = xClass.replace(/View(?!Model)/g, "ViewModel");
	const dot = viewModel.lastIndexOf(".");
	if (dot < 0) {
		return xaml;
	}
	return applyEdits(xaml, [
		{ start: at, end: at, text: `<Design.DataContext><designvm:${viewModel.substring(dot + 1)}/></Design.DataContext>` },
		{ start: at - 1, end: at - 1, text: ` xmlns:designvm="clr-namespace:${viewModel.substring(0, dot)}"` },
	]);
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

/** Short explanation for the panel when the automatic design data context could not be created. */
export function designDataHint(error: string): string {
	const ctor = /Unable to find public constructor for type (?:[\w.]+:)?([\w.]+)\(\)/.exec(error);
	if (ctor) {
		return `no design data: ${ctor[1].split(".").pop()} has no parameterless constructor (add one for design time, or Design.DataContext)`;
	}
	return `no design data: ${error.split("\n")[0].slice(0, 120)}`;
}
