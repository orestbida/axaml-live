import { getAttribute, parseXml, XmlAttribute, XmlElement, XmlNode } from "./xmlTree";

export interface FormatOptions {
    indentSize: number;
    useTabs: boolean;
    /** none: keep all attributes on one line; alignWithFirst: continuation aligned with the first attribute; indent: one level deeper */
    attributeWrapping: "none" | "alignWithFirst" | "indent";
    /** wrap when an element has MORE attributes than this; 0 disables */
    attributeWrapThreshold: number;
    /** wrap markup extension arguments when there are MORE than this; 0 disables */
    markupExtensionArgWrapThreshold: number;
    collapseBlankLines: boolean;
    quoteStyle: "double" | "single";
}

/**
 * Formats AXAML. Returns undefined when the document is not well-formed (never corrupts a file).
 * Text-only elements stay inline, mixed content and xml:space="preserve" are kept verbatim.
 */
export function formatXaml(text: string, options: FormatOptions): string | undefined {
    const doc = parseXml(text);
    if (!doc) {
        return undefined;
    }
    const lines: string[] = [];
    new Formatter(options, text).emitChildren(doc.children, 0, lines);
    // lines produced by the formatter never end with whitespace; verbatim regions are kept as they are
    return lines.join("\n") + "\n";
}

class Formatter {
    private readonly unit: string;
    constructor(
        private readonly o: FormatOptions,
        private readonly source: string
    ) {
        this.unit = o.useTabs ? "\t" : " ".repeat(o.indentSize);
    }

    private indent(depth: number) {
        return this.unit.repeat(depth);
    }

    /** Emits sibling nodes, one per line, preserving (collapsed) blank lines between them. */
    emitChildren(nodes: XmlNode[], depth: number, out: string[]) {
        let pendingNewlines = 0;
        let first = true;
        for (const node of nodes) {
            if (node.kind === "text") {
                if (node.raw.trim() === "") {
                    pendingNewlines += (node.raw.match(/\n/g) ?? []).length;
                    continue;
                }
                // stray text between elements (rare in XAML): keep trimmed on its own line
                this.blank(out, pendingNewlines, first);
                out.push(this.indent(depth) + node.raw.trim());
            } else {
                this.blank(out, pendingNewlines, first);
                if (node.kind === "element") {
                    this.emitElement(node, depth, out);
                } else {
                    const raw = node.raw;
                    out.push(this.indent(depth) + (node.kind === "comment" ? raw : raw.trim()));
                }
            }
            pendingNewlines = 0;
            first = false;
        }
    }

    private blank(out: string[], newlines: number, first: boolean) {
        if (first) {
            return;
        }
        let blanks = Math.max(0, newlines - 1);
        if (this.o.collapseBlankLines) {
            blanks = Math.min(blanks, 1);
        }
        for (let i = 0; i < blanks; i++) {
            out.push("");
        }
    }

    private emitElement(el: XmlElement, depth: number, out: string[]) {
        const prefix = this.indent(depth);
        const children = el.children;
        const hasElementChildren = children.some((c) => c.kind === "element" || c.kind === "comment" || c.kind === "pi");
        const hasText = children.some((c) => (c.kind === "text" && c.raw.trim() !== "") || c.kind === "cdata");
        const preserve = getAttribute(el, "xml:space")?.value === "preserve";

        if (el.selfClosing) {
            out.push(...this.startTag(el, prefix, " />"));
            return;
        }

        const inner = this.innerRaw(el);
        if (preserve || (hasElementChildren && hasText) || (!hasElementChildren && hasText)) {
            // verbatim inner content (text-only, CDATA, mixed content or xml:space="preserve")
            const lines = this.startTag(el, prefix, ">");
            lines[lines.length - 1] += inner + `</${el.name}>`;
            out.push(...lines);
            return;
        }
        if (!hasElementChildren) {
            const lines = this.startTag(el, prefix, ">");
            lines[lines.length - 1] += `</${el.name}>`;
            out.push(...lines);
            return;
        }
        out.push(...this.startTag(el, prefix, ">"));
        this.emitChildren(children, depth + 1, out);
        out.push(`${prefix}</${el.name}>`);
    }

    private innerRaw(el: XmlElement): string {
        return el.children.map((c) => (c.kind === "element" ? this.rawOf(c) : c.raw)).join("");
    }

    private rawOf(el: XmlElement): string {
        // children of verbatim regions are re-serialized from their original text
        return this.source.substring(el.start, el.end);
    }

    /** Start tag lines; `close` is "/>" (with leading space) or ">". */
    private startTag(el: XmlElement, prefix: string, close: string): string[] {
        const head = `${prefix}<${el.name}`;
        const attrs = el.attributes;
        if (!attrs.length) {
            return [head + (close === ">" ? ">" : close)];
        }
        const wrap =
            this.o.attributeWrapping !== "none" && this.o.attributeWrapThreshold > 0 && attrs.length > this.o.attributeWrapThreshold;
        if (!wrap) {
            let line = head;
            for (const a of attrs) {
                line += " " + this.attribute(a, line.length + 1);
            }
            return [line + close];
        }
        const lines: string[] = [];
        if (this.o.attributeWrapping === "alignWithFirst") {
            const pad = " ".repeat(head.length + 1 - prefix.length);
            attrs.forEach((a, i) => {
                const linePrefix = i === 0 ? head + " " : prefix + pad;
                lines.push(linePrefix + this.attribute(a, linePrefix.length));
            });
        } else {
            lines.push(head);
            const linePrefix = prefix + this.unit;
            for (const a of attrs) {
                lines.push(linePrefix + this.attribute(a, (prefix + " ".repeat(this.o.indentSize)).length));
            }
        }
        lines[lines.length - 1] += close;
        return lines;
    }

    /** `name="value"`; `column` is where the attribute starts on its line (for markup extension alignment). */
    private attribute(a: XmlAttribute, column: number): string {
        let quote: string = this.o.quoteStyle === "single" ? "'" : '"';
        if (a.value.includes(quote)) {
            quote = quote === '"' ? "'" : '"';
        }
        const valueColumn = column + a.name.length + 2;
        return `${a.name}=${quote}${this.markupExtension(a.value, valueColumn)}${quote}`;
    }

    private markupExtension(value: string, column: number): string {
        const t = this.o.markupExtensionArgWrapThreshold;
        const m = /^\{([A-Za-z_][\w:.]*)\s+([\s\S]*)\}$/.exec(value.trim());
        if (!t || !m) {
            return value;
        }
        const args = splitTopLevel(m[2]);
        if (args.length <= t) {
            return value;
        }
        const pad = " ".repeat(column + 1 + m[1].length + 1);
        return `{${m[1]} ` + args.map((s) => s.trim()).join(`,\n${pad}`) + "}";
    }
}

function splitTopLevel(s: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let cur = "";
    for (const ch of s) {
        if (ch === "{" || ch === "(" || ch === "[") {
            depth++;
        } else if (ch === "}" || ch === ")" || ch === "]") {
            depth--;
        }
        if (ch === "," && depth === 0) {
            parts.push(cur);
            cur = "";
        } else {
            cur += ch;
        }
    }
    parts.push(cur);
    return parts;
}
