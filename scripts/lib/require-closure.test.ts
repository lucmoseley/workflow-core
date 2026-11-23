// @vitest-environment node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { copyRequireClosure, launchedScripts } from "./require-closure";

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

it("names the scripts a hook runs or sources by path, off its comments (#5423)", () => {
	const hook = [
		"# see scripts/lib/commented.js",
		'. "$R"/scripts/lib/gate.sh',
		'out="$(node "$R"/scripts/run.js --gate)"',
		'd="$here/../scripts/dispatch.js"; node "$d" scripts/run.js',
		"cat myscripts/x.js",
	].join("\n");
	expect(launchedScripts(hook)).toEqual([
		"scripts/lib/gate.sh",
		"scripts/run.js",
		"scripts/dispatch.js",
	]);
});

it("follows a shell file's launches and their requires, skipping a path it lacks (#5423)", () => {
	const src = path.join(tmp, "src");
	const out = path.join(tmp, "out");
	const write = (rel: string, body: string) => {
		fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
		fs.writeFileSync(path.join(src, rel), body);
	};
	write(
		"scripts/lib/gate.sh",
		'node "$R"/scripts/run.js\nnode "$R"/scripts/absent.js\n# scripts/lib/note.js\n',
	);
	write("scripts/run.js", 'require("./lib/dep.js");\n');
	write("scripts/lib/dep.js", "");
	write("scripts/lib/note.js", "");
	write("scripts/plain.js", "// scripts/run.js\n");

	copyRequireClosure(out, src, ["scripts/lib/gate.sh", "scripts/plain.js"]);

	expect(fs.readdirSync(path.join(out, "scripts")).sort()).toEqual([
		"lib",
		"plain.js",
		"run.js",
	]);
	expect(fs.readdirSync(path.join(out, "scripts/lib")).sort()).toEqual([
		"dep.js",
		"gate.sh",
	]);
});

it("follows no require a comment shows as usage, from the caller's directory (#5656)", () => {
	const src = path.join(tmp, "src");
	const out = path.join(tmp, "out");
	const write = (rel: string, body: string) => {
		fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
		fs.writeFileSync(path.join(src, rel), body);
	};
	write(
		"scripts/lib/used.js",
		[
			"/*",
			" * Usage:",
			' *   const { run } = require("./lib/used.js");',
			" */",
			'/* require("./lib/inline.js") */ require("./dep.js"); // require("./lib/other.js")',
		].join("\n"),
	);
	write("scripts/lib/dep.js", "");

	copyRequireClosure(out, src, ["scripts/lib/used.js"]);

	expect(fs.readdirSync(path.join(out, "scripts/lib")).sort()).toEqual([
		"dep.js",
		"used.js",
	]);
});
