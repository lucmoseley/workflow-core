// @vitest-environment node
/*
 * Pins gh-route.js's judgement of one file's text, in-process (#4123).
 * check-gh-route.test.ts holds the program's boundary cases.
 */

import { describe, expect, it } from "vitest";
import { judgeFile, kindOf } from "./gh-route.js";

/** A shell or template expansion of `name`, spelt out of plain strings. */
const sub = (name: string) => ["$", `{${name}}`].join("");

/* Spelt apart, so check-gh-route does not read this test as naming one. */
const SECOND_GH_VAR = ["WFC", "X", "GH"].join("_");

const tags = (rel: string, kind: "node" | "test" | "shell", source: string) =>
	judgeFile(rel, kind, source).map((f) => [f.tag, f.bin, f.line]);

describe("kindOf", () => {
	it("reads a listed shell file as shell, a test as test, other code as node, and anything else as none", () => {
		const shell = new Set(["scripts/a.sh"]);
		expect(kindOf("scripts/a.sh", shell)).toBe("shell");
		expect(kindOf("scripts/a.test.ts", shell)).toBe("test");
		expect(kindOf("scripts/a.js", shell)).toBe("node");
		expect(kindOf("scripts/a.md", shell)).toBeNull();
	});
});

describe("judgeFile", () => {
	it("names a literal spawn and a second env var read in a Node program, per binary", () => {
		expect(
			tags(
				"scripts/x.js",
				"node",
				`spawnSync("gh", []);\nconst c = process.env.WFC_CLAUDE_BIN;\nconst v = process.env.${SECOND_GH_VAR};\n`,
			),
		).toEqual([
			["NODE-COPY", "gh", 1],
			["NODE-COPY", "claude", 2],
			["SECOND-VAR", "gh", 3],
		]);
	});

	it("lets the primitive read its own var, and a program assign it", () => {
		expect(
			tags("scripts/lib/gh.js", "node", "const b = process.env.WFC_GH;\n"),
		).toEqual([]);
		/* The program text is spelt apart so no lexical check reads it as this
		 * test's own env write. */
		const assign = `${["process", "env", "WFC_GH"].join(".")} = "/stub";\n`;
		expect(tags("scripts/x.js", "node", assign)).toEqual([]);
	});

	it("names a bare shell run and probe, past comments, and honours a marker on the line or the one above", () => {
		expect(
			tags(
				"scripts/x.sh",
				"shell",
				[
					"# gh issue list",
					"out=$(gh issue list)",
					"command -v claude",
					"# gh-route-exempt: a message naming the binary",
					'echo "run"; gh auth login',
					`"${sub("WFC_GH:-gh")}" issue list`,
				].join("\n"),
			),
		).toEqual([
			["SHELL-BARE", "gh", 2],
			["SHELL-BARE", "claude", 3],
		]);
	});

	it("never takes a marker on a Node copy", () => {
		expect(
			tags(
				"scripts/x.js",
				"node",
				'// gh-route-exempt: no\nexecFileSync("gh", []);\n',
			),
		).toEqual([["NODE-COPY", "gh", 2]]);
	});

	it("names a test prepending to PATH a directory it joins the binary onto, directly or through a helper", () => {
		const direct = [
			'fs.writeFileSync(path.join(bin, "gh"), "");',
			`env.PATH = \`${sub("bin")}:${sub("process.env.PATH")}\`;`,
		].join("\n");
		const helper = [
			"function stub(name: string, dir = binDir) {",
			"\tfs.writeFileSync(path.join(dir, name), '');",
			"}",
			'stub("claude");',
			`env.PATH = \`${sub("binDir")}${sub("path.delimiter")}${sub("process.env.PATH")}\`;`,
		].join("\n");
		expect(tags("scripts/a.test.ts", "test", direct)).toEqual([
			["PATH-STUB", "gh", 2],
		]);
		expect(tags("scripts/a.test.ts", "test", helper)).toEqual([
			["PATH-STUB", "claude", 5],
		]);
	});

	it("keys each finding by its text and its count among identical lines, carrying its fix line", () => {
		const found = judgeFile(
			"scripts/x.js",
			"node",
			'spawn("gh", a);\nspawn("gh",   a);\n',
		);
		expect(found.map((f) => f.match)).toEqual([
			'spawn("gh", a); #1',
			'spawn("gh", a); #2',
		]);
		expect(found[0]?.fixLine).toBe(
			"gh NODE-COPY Fix: call `gh`, `ghJson` or their kin from scripts/lib/gh.js, as scripts/check-issue-orphans.js does.",
		);
		expect(found[0]?.message).toBe(
			"scripts/x.js:1 reaches `gh` off its one route (NODE-COPY). Fix: call `gh`, `ghJson` or their kin from scripts/lib/gh.js, as scripts/check-issue-orphans.js does.",
		);
	});
});
