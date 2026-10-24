// @vitest-environment node
/*
 * lib/host-package.js's contract (#1380): the package's exports where the host
 * root or the caller's directory has it installed, and an outcome naming the
 * package, the root and the install command where neither does — never a
 * MODULE_NOT_FOUND throw. That outcome is what turns an adopter's missing
 * js-yaml into a BROKEN gate naming the fix.
 *
 * Real packages under temp roots, the host root set through
 * CLAUDE_PROJECT_DIR, which hostRoot() reads first: the resolution is Node's
 * own, so only real directories prove it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostPackage } from "./host-package.js";

let tmp: string;
let host: string;
let own: string;
beforeEach(() => {
	tmp = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "host-package-")),
	);
	host = path.join(tmp, "host");
	own = path.join(tmp, "own");
	fs.mkdirSync(host);
	fs.mkdirSync(own);
	vi.stubEnv("CLAUDE_PROJECT_DIR", host);
});
afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(tmp, { recursive: true, force: true });
});

function install(root: string, name: string): void {
	const dir = path.join(root, "node_modules", name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "package.json"),
		JSON.stringify({ name, main: "index.js" }),
	);
	fs.writeFileSync(path.join(dir, "index.js"), `exports.who = "${root}";`);
}

describe("hostPackage", () => {
	it("loads the package from the host root's own install", () => {
		install(host, "wfc-fake-yaml");

		expect(hostPackage("wfc-fake-yaml", own)).toEqual({
			ok: true,
			module: { who: host },
		});
	});

	it("takes the host's copy over the caller's where both have it", () => {
		install(host, "wfc-fake-yaml");
		install(own, "wfc-fake-yaml");

		expect(hostPackage("wfc-fake-yaml", own)).toEqual({
			ok: true,
			module: { who: host },
		});
	});

	it("falls back to the caller's install, as in a core checkout", () => {
		install(own, "wfc-fake-yaml");

		expect(hostPackage("wfc-fake-yaml", own)).toEqual({
			ok: true,
			module: { who: own },
		});
	});

	it("returns an outcome naming the package, the host root and the install where neither has it", () => {
		expect(hostPackage("wfc-fake-yaml", own)).toEqual({
			ok: false,
			message: `wfc-fake-yaml is not installed in ${host}, so this check cannot run. Install it there: npm install --ignore-scripts --save-dev --save-exact wfc-fake-yaml`,
		});
	});
});
