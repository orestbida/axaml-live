import * as path from "path";
import * as Mocha from "mocha";
import { e2eSetting } from "./config";

export function run(): Promise<void> {
	const mocha = new Mocha({ ui: "tdd", color: true, timeout: 300000, bail: true, grep: e2eSetting("E2E_GREP") });
	mocha.addFile(path.resolve(__dirname, "preview.e2e.js"));
	return new Promise((resolve, reject) =>
		mocha.run((failures) => (failures ? reject(new Error(`${failures} e2e tests failed`)) : resolve()))
	);
}
