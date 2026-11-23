/**
 * Minimal, position-aware XML parser for AXAML tooling (formatter, design transforms, style badges, navigation).
 * Keeps exact offsets so callers can edit the original text surgically. Returns undefined on malformed input.
 * No dependency on vscode: unit-testable in plain Node.
 */

export interface XmlAttribute {
    name: string;
    value: string; // raw text between the quotes (entities not decoded)
    quote: '"' | "'";
    start: number; // offset of the attribute name
    valueStart: number; // offset of the first character inside the quotes
    valueEnd: number; // offset of the closing quote
}

export interface XmlElement {
    kind: "element";
    name: string;
    attributes: XmlAttribute[];
    children: XmlNode[];
    parent?: XmlElement;
    start: number; // '<'
    nameEnd: number; // offset right after the tag name
    startTagEnd: number; // offset right after '>' of the start tag
    selfClosing: boolean;
    closeStart: number; // '<' of the end tag (== startTagEnd for self-closing)
    end: number; // offset right after the element
}

export interface XmlText {
    kind: "text" | "comment" | "cdata" | "pi";
    raw: string;
    start: number;
    end: number;
}

export type XmlNode = XmlElement | XmlText;

export interface XmlDocument {
    children: XmlNode[];
    root?: XmlElement;
}

class ParseError extends Error {}

export function parseXml(text: string): XmlDocument | undefined {
    try {
        return new Parser(text).parse();
    } catch (e) {
        if (e instanceof ParseError) {
            return undefined;
        }
        throw e;
    }
}

export function localName(name: string): string {
    const i = name.indexOf(":");
    return i >= 0 ? name.substring(i + 1) : name;
}

export function getAttribute(el: XmlElement, name: string): XmlAttribute | undefined {
    return el.attributes.find((a) => a.name === name);
}

export function* walk(node: XmlElement): Generator<XmlElement> {
    yield node;
    for (const c of node.children) {
        if (c.kind === "element") {
            yield* walk(c);
        }
    }
}

/** Namespace prefixes declared on the element and its ancestors (prefix -> namespace). "" is the default namespace. */
export function namespaces(el: XmlElement): Map<string, string> {
    const chain: XmlElement[] = [];
    for (let e: XmlElement | undefined = el; e; e = e.parent) {
        chain.unshift(e);
    }
    const map = new Map<string, string>();
    for (const e of chain) {
        for (const a of e.attributes) {
            if (a.name === "xmlns") {
                map.set("", a.value);
            } else if (a.name.startsWith("xmlns:")) {
                map.set(a.name.substring(6), a.value);
            }
        }
    }
    return map;
}

const nameChar = /[A-Za-z0-9_.:\-|]/;

class Parser {
    private pos = 0;
    constructor(private readonly text: string) {}

    parse(): XmlDocument {
        const doc: XmlDocument = { children: [] };
        const stack: XmlElement[] = [];
        const add = (node: XmlNode) => (stack.length ? stack[stack.length - 1].children : doc.children).push(node);

        while (this.pos < this.text.length) {
            const lt = this.text.indexOf("<", this.pos);
            if (lt < 0) {
                add({ kind: "text", raw: this.text.substring(this.pos), start: this.pos, end: this.text.length });
                this.pos = this.text.length;
                break;
            }
            if (lt > this.pos) {
                add({ kind: "text", raw: this.text.substring(this.pos, lt), start: this.pos, end: lt });
                this.pos = lt;
            }
            if (this.text.startsWith("<!--", lt)) {
                const end = this.mustFind("-->", lt + 4) + 3;
                add({ kind: "comment", raw: this.text.substring(lt, end), start: lt, end });
                this.pos = end;
            } else if (this.text.startsWith("<![CDATA[", lt)) {
                const end = this.mustFind("]]>", lt + 9) + 3;
                add({ kind: "cdata", raw: this.text.substring(lt, end), start: lt, end });
                this.pos = end;
            } else if (this.text.startsWith("<?", lt) || this.text.startsWith("<!", lt)) {
                const end = this.mustFind(">", lt + 2) + 1;
                add({ kind: "pi", raw: this.text.substring(lt, end), start: lt, end });
                this.pos = end;
            } else if (this.text.startsWith("</", lt)) {
                const name = this.readName(lt + 2);
                const gt = this.mustFind(">", lt + 2 + name.length);
                if (this.text.substring(lt + 2 + name.length, gt).trim() !== "") {
                    throw new ParseError("bad end tag");
                }
                const open = stack.pop();
                if (!open || open.name !== name) {
                    throw new ParseError(`mismatched </${name}>`);
                }
                open.closeStart = lt;
                open.end = gt + 1;
                this.pos = gt + 1;
            } else {
                const el = this.readStartTag(lt);
                el.parent = stack[stack.length - 1];
                add(el);
                if (!el.selfClosing) {
                    stack.push(el);
                }
            }
        }
        if (stack.length) {
            throw new ParseError("unclosed element");
        }
        doc.root = doc.children.find((c): c is XmlElement => c.kind === "element");
        return doc;
    }

    private mustFind(s: string, from: number): number {
        const i = this.text.indexOf(s, from);
        if (i < 0) {
            throw new ParseError(`missing ${s}`);
        }
        return i;
    }

    private readName(from: number): string {
        let i = from;
        while (i < this.text.length && nameChar.test(this.text[i])) {
            i++;
        }
        if (i === from) {
            throw new ParseError("name expected");
        }
        return this.text.substring(from, i);
    }

    private skipWs(i: number): number {
        while (i < this.text.length && /\s/.test(this.text[i])) {
            i++;
        }
        return i;
    }

    private readStartTag(lt: number): XmlElement {
        const name = this.readName(lt + 1);
        let i = lt + 1 + name.length;
        const attributes: XmlAttribute[] = [];
        for (;;) {
            i = this.skipWs(i);
            if (i >= this.text.length) {
                throw new ParseError("unterminated start tag");
            }
            if (this.text.startsWith("/>", i)) {
                this.pos = i + 2;
                return this.element(name, attributes, lt, i + 2, true);
            }
            if (this.text[i] === ">") {
                this.pos = i + 1;
                return this.element(name, attributes, lt, i + 1, false);
            }
            const attrName = this.readName(i);
            const attrStart = i;
            i = this.skipWs(i + attrName.length);
            if (this.text[i] !== "=") {
                throw new ParseError("= expected");
            }
            i = this.skipWs(i + 1);
            const quote = this.text[i];
            if (quote !== '"' && quote !== "'") {
                throw new ParseError("quote expected");
            }
            const close = this.mustFind(quote, i + 1);
            attributes.push({
                name: attrName,
                value: this.text.substring(i + 1, close),
                quote,
                start: attrStart,
                valueStart: i + 1,
                valueEnd: close,
            });
            i = close + 1;
        }
    }

    private element(name: string, attributes: XmlAttribute[], start: number, startTagEnd: number, selfClosing: boolean): XmlElement {
        return {
            kind: "element",
            name,
            attributes,
            children: [],
            start,
            nameEnd: start + 1 + name.length,
            startTagEnd,
            selfClosing,
            closeStart: startTagEnd,
            end: startTagEnd,
        };
    }
}
