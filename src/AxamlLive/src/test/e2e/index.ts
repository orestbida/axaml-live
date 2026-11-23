import * as path from "path";
import * as Mocha from "mocha";
import { e2eSetting } from "./config";

export function run(): Promise<void> {
    // E2E_SUITE=allFiles: preview every .axaml file and write a report (read-only); E2E_SUITE=screenshot: README screenshot
    const suite = e2eSetting("E2E_SUITE") ?? "preview";
    const mocha = new Mocha({ ui: "tdd", color: true, timeout: 300000, bail: suite === "preview", grep: e2eSetting("E2E_GREP") });
    const files: Record<string, string> = { allFiles: "allFiles.e2e.js", screenshot: "screenshot.e2e.js" };
    mocha.addFile(path.resolve(__dirname, files[suite] ?? "preview.e2e.js"));
    return new Promise((resolve, reject) =>
        mocha.run((failures) => (failures ? reject(new Error(`${failures} e2e tests failed`)) : resolve()))
    );
}
