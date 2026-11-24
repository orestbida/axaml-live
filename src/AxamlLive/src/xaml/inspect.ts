import { localName, parseXml, XmlElement } from "./xmlTree";

/** One step of the logical tree path that the designer hook reports: type name and index among same-type siblings. */
export interface PathStep {
    type: string;
    /** Full type name: finds the .axaml of a view (its x:Class) when the path continues inside it. */
    fullType?: string;
    index: number;
}

/** Property elements whose content is not in the logical tree of the element (or not created at all). */
const notLogical =
    /\.(Styles|Resources|DataTemplates|Template|ItemTemplate|ItemsPanel|ItemContainerTheme|Transitions|KeyBindings|DataContext|Theme)$/;

/** Elements that become logical children of `el`: object children, also through property elements like Border.Child. */
function logicalChildren(el: XmlElement): XmlElement[] {
    const result: XmlElement[] = [];
    for (const child of el.children) {
        if (child.kind !== "element") {
            continue;
        }
        if (!child.name.includes(".")) {
            result.push(child);
        } else if (!notLogical.test(child.name) && !child.name.startsWith("Design.")) {
            result.push(...child.children.filter((c): c is XmlElement => c.kind === "element" && !c.name.includes(".")));
        }
    }
    return result;
}

/**
 * The XAML element of the control at the end of `path` (from the designer's top-level down), or the deepest
 * element that could be matched (generated item containers and template parts are not in the XAML).
 * `wrapperDepth` is the number of elements the preview wrapped around the root's content (theme scope and
 * background borders, see applyThemeVariant): they are on the path but not in the file.
 * `pathIndex` is the index of the matched step, for its bounds.
 */
const parsedTexts = new Map<string, XmlElement | undefined>();

/**
 * Parsed documents, reused while the pointer moves over the same preview (the texts only change with an update). A
 * few are kept: the previewed file and the views it shows.
 */
function parsed(xaml: string): XmlElement | undefined {
    if (!parsedTexts.has(xaml)) {
        if (parsedTexts.size >= 8) {
            parsedTexts.delete(parsedTexts.keys().next().value!);
        }
        parsedTexts.set(xaml, parseXml(xaml)?.root);
    }
    return parsedTexts.get(xaml);
}

/** Follows `path` from `start` (the element of step `from - 1`) as far as the XAML has the steps. */
function descend(start: XmlElement, path: PathStep[], from: number): { element: XmlElement; pathIndex: number } {
    let current = start;
    let matched = from - 1;
    for (let i = from; i < path.length; i++) {
        const step = path[i];
        const next = logicalChildren(current).filter((c) => localName(c.name) === step.type)[step.index];
        if (!next) {
            break;
        }
        current = next;
        matched = i;
    }
    return { element: current, pathIndex: matched };
}

export function findElementByPath(
    xaml: string,
    path: PathStep[],
    wrapperDepth = 0
): { element: XmlElement; pathIndex: number } | undefined {
    const root = parsed(xaml);
    if (!root || !path.length) {
        return undefined;
    }
    const rootName = localName(root.name);
    let start: XmlElement | undefined = root;
    // a Window is the designer's top-level itself; other roots are placed in a designer window
    let index = /Window$/.test(rootName) || rootName === "TopLevel" ? 0 : 1;
    let skip = wrapperDepth; // wrappers inside the start element, before its content
    if (rootName === "Styles" || rootName === "ResourceDictionary") {
        // the Design.PreviewWith content is shown; the theme scope is wrapped around it
        const previewWith = root.children.find((c): c is XmlElement => c.kind === "element" && c.name === "Design.PreviewWith");
        start = previewWith?.children.find((c): c is XmlElement => c.kind === "element");
        index += wrapperDepth;
        skip = 0;
    }
    if (!start || path.length <= index) {
        return undefined;
    }

    const found = descend(start, path, index + 1 + skip);
    // nothing below the wrappers matched: the start element itself
    return found.pathIndex < index + 1 + skip ? { element: start, pathIndex: index } : found;
}

/** An .axaml file and its text (the editor's when it is open). */
export interface ViewSource {
    file: string;
    text: string;
}

export interface ViewMatch extends ViewSource {
    element: XmlElement;
    pathIndex: number;
}

/**
 * Like findElementByPath, and continues inside other views: when the path leaves the file at a control that is a view
 * of its own (a UserControl with x:Class, used as `<v:Card />` or created by a data template or an item container),
 * the rest of the path is matched in that view's file, and so on for views inside views. `resolveView` returns the
 * file whose x:Class is the given full type name.
 */
export function findElementAcrossViews(
    main: ViewSource,
    path: PathStep[],
    wrapperDepth: number,
    resolveView: (fullType: string) => ViewSource | undefined
): ViewMatch | undefined {
    const first = findElementByPath(main.text, path, wrapperDepth);
    if (!first) {
        return undefined;
    }
    let match: ViewMatch = { ...main, ...first };
    for (;;) {
        const next = continueInView(match, path, resolveView);
        if (!next) {
            return match;
        }
        match = next;
    }
}

function continueInView(
    match: ViewMatch,
    path: PathStep[],
    resolveView: (fullType: string) => ViewSource | undefined
): ViewMatch | undefined {
    for (let j = match.pathIndex; j < path.length; j++) {
        // the matched element continues in its own file only when it is the view itself (<v:Card />)
        if (j === match.pathIndex && localName(match.element.name) !== path[j].type) {
            continue;
        }
        const fullType = path[j].fullType;
        const view = fullType ? resolveView(fullType) : undefined;
        const root = view && view.file !== match.file ? parsed(view.text) : undefined;
        if (!view || !root) {
            continue;
        }
        // the view's root element is the control of step j; its content follows (or the root, when none matches)
        return { ...view, ...descend(root, path, j + 1) };
    }
    return undefined;
}
