import * as assert from "assert";
import { LineSplitter } from "../../util/lines";
import { projectNameError } from "../../util/projectName";

suite("process output lines", () => {
    function split(chunks: (string | Buffer)[]): string[] {
        const lines: string[] = [];
        const s = new LineSplitter((l) => lines.push(l));
        chunks.forEach((c) => s.write(c));
        s.end();
        return lines;
    }

    test("a line split across chunks is joined", () => {
        assert.deepStrictEqual(split(['AXAML_LIVE {"kind":"ho', 'ver"}\nnext\n']), ['AXAML_LIVE {"kind":"hover"}', "next"]);
    });

    test("CRLF, also when the CR ends a chunk", () => {
        assert.deepStrictEqual(split(["a\r", "\nb\r\n", "c"]), ["a", "b", "c"]);
    });

    test("a UTF-8 character cut between chunks", () => {
        // a Cyrillic user name: every letter is two bytes
        const name = "Олег";
        const bytes = Buffer.from(`/home/${name}/app\n`, "utf8");
        const cut = bytes.indexOf(Buffer.from("л", "utf8")) + 1;
        assert.deepStrictEqual(split([bytes.subarray(0, cut), bytes.subarray(cut)]), [`/home/${name}/app`]);
    });
});

suite("new project name", () => {
    test("valid names", () => {
        for (const name of ["MyApp", "Company.App", "_App2"]) {
            assert.strictEqual(projectNameError(name), undefined, name);
        }
    });
    test("invalid names", () => {
        for (const name of ["", " ", "../x", "My App", "1App", "App.", "a/b"]) {
            assert.ok(projectNameError(name), name);
        }
    });
});
