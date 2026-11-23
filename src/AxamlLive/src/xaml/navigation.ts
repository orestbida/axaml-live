import { getAttribute, localName, namespaces, parseXml, XmlElement } from "./xmlTree";

/** Full name of the class in `x:Class` on the root element. */
export function getXClass(xaml: string): string | undefined {
    const root = parseXml(xaml)?.root;
    return root ? getAttribute(root, "x:Class")?.value.trim() || undefined : undefined;
}

/**
 * Full name of the view model type: root `x:DataType` (also `{x:Type p:Name}`), else the first element of
 * `Design.DataContext`. The xmlns prefix is resolved (`using:Ns` and `clr-namespace:Ns;assembly=...`).
 */
export function getDataType(xaml: string): string | undefined {
    const root = parseXml(xaml)?.root;
    if (!root) {
        return undefined;
    }
    const dataType = getAttribute(root, "x:DataType")?.value.trim();
    if (dataType) {
        const m = /^\{\s*x:Type\s+([^\s}]+)\s*\}$/.exec(dataType);
        return resolveTypeName(m ? m[1] : dataType, root);
    }
    const designContext = root.children.find((c): c is XmlElement => c.kind === "element" && c.name === "Design.DataContext");
    const first = designContext?.children.find((c): c is XmlElement => c.kind === "element");
    return first ? resolveTypeName(first.name, first) : undefined;
}

function resolveTypeName(qualified: string, scope: XmlElement): string {
    const i = qualified.indexOf(":");
    if (i < 0) {
        return qualified;
    }
    const ns = namespaces(scope).get(qualified.substring(0, i)) ?? "";
    const typeName = qualified.substring(i + 1);
    const m = /^(?:using:|clr-namespace:)([^;]+)/.exec(ns);
    return m ? `${m[1].trim()}.${typeName}` : typeName;
}

export function codeBehindCandidates(axamlPath: string): string[] {
    return [`${axamlPath}.cs`, `${axamlPath}.fs`];
}

/** Conventional view model names for a view class name (short name, no namespace). */
export function viewModelNameCandidates(viewName: string): string[] {
    if (viewName.endsWith("View")) {
        return [`${viewName}Model`, `${viewName}ViewModel`];
    }
    const result = [`${viewName}ViewModel`];
    const m = /^(.+?)(Window|Page|Control|Dialog)$/.exec(viewName);
    if (m) {
        result.push(`${m[1]}ViewModel`);
    }
    return result;
}

/** Zero-based line of `class/record/struct/interface Name` (C#) or `type Name` (F#), or -1. */
export function findTypeDeclarationLine(source: string, typeName: string): number {
    const name = typeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const cs = new RegExp(`\\b(class|record|struct|interface)\\s+(struct\\s+|class\\s+)?${name}\\b`);
    const fs = new RegExp(`^\\s*type\\s+${name}\\b`);
    const lines = source.split(/\r?\n/);
    return lines.findIndex((l) => cs.test(l) || fs.test(l));
}

/** Short name of a possibly qualified type name. */
export function shortName(fullName: string): string {
    return localName(fullName).split(".").pop() ?? fullName;
}
