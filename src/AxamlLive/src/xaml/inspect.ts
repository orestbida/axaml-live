import { localName, parseXml, XmlElement } from "./xmlTree";

/** One step of the logical tree path that the designer hook reports: type name and index among same-type siblings. */
export interface PathStep {
    type: string;
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
export function findElementByPath(
    xaml: string,
    path: PathStep[],
    wrapperDepth = 0
): { element: XmlElement; pathIndex: number } | undefined {
    const root = parseXml(xaml)?.root;
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

    let current = start;
    let matched = index;
    for (let i = index + 1 + skip; i < path.length; i++) {
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
