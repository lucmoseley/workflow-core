// @vitest-environment node
/*
 * copyRequireClosure copies a file with everything it reaches by relative
 * require (#1657). The live case loads the copy in a child node, whose module
 * cache cannot fall back on a file already loaded from the real tree. Loosen
 * it and a fixture copying the config reader can again go missing a helper
 * the reader gains, failing the pre-commit gate suites on an unrelated commit.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { copyRequireClosure } from "./require-closure";

let tmp: string;
beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "require-closure-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

it("copies the live config reader whole enough to load on its own", () => {
	copyRequireClosure(tmp, path.resolve(__dirname, "../.."), [
		"scripts/lib/workflow-core-config.js",
	]);
	const out = execFileSync(
		process.execPath,
		[
			"-e",
			"require(process.argv[1]); console.log('loaded')",
			path.join(tmp, "scripts/lib/workflow-core-config.js"),
		],
		{ cwd: tmp, encoding: "utf8" },
	);
	expect(out).toBe("loaded\n");
});

it("follows a require added later, transitively and extensionless (#1657)", () => {
	const src = path.join(tmp, "src");
	const out = path.join(tmp, "out");
	const write = (rel: string, body: string) => {
		fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
		fs.writeFileSync(path.join(src, rel), body);
	};
	write("lib/a.js", 'require("./b.js");\nrequire("node:fs");\n');
	write("lib/b.js", 'require("../util/c");\nrequire("./a.js");\n');
	write("util/c.js", "");
	write("lib/unreached.js", "");

	copyRequireClosure(out, src, ["lib/a.js"]);

	expect(fs.readdirSync(path.join(out, "lib")).sort()).toEqual([
		"a.js",
		"b.js",
	]);
	expect(fs.existsSync(path.join(out, "util/c.js"))).toBe(true);
});
