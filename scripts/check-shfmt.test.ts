// @vitest-environment node

/*
 * Pins scripts/check-shfmt.js, the shfmt run CI's `check:sh:format` step makes
 * over the tracked shell (#1332): it checks by default, --write formats, no
 * paths means every tracked shell file and nothing else, and a missing
 * shfmt or path is BROKEN (#1354).
 *
 * Run in process in a throwaway repo, with the core's pinned shfmt. Loosen a
 * case and CI passes unformatted shell, or reads files outside the set
 * shellcheck lints.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	newRepo,
	registerTempCleanup,
	type TempRepo,
} from "./lib/precommit-gate-harness";
import { ROOT } from "./lib/precommit-gate-testkit";
import { runInProcess } from "./lib/run-in-process.js";

const temps = registerTempCleanup();
const CLI = path.join(ROOT, "scripts", "check-shfmt.js");

const OK = "if true; then\n  echo x\nfi\n";
const BAD = "if true; then\n\techo x\nfi\n";

function repo(files: Record<string, string>): TempRepo {
	const r = newRepo("shfmt-", temps);
	for (const [rel, body] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(r.root, rel)), { recursive: true });
		fs.writeFileSync(path.join(r.root, rel), body);
		r.git("add", "--", rel);
	}
	return r;
}

const run = (r: TempRepo, args: string[] = [], env: object = {}) => {
	const p = runInProcess(CLI, args, {
		cwd: r.root,
		env: { ...process.env, ...env },
	});
	return { code: p.status, output: `${p.stdout}${p.stderr}` };
};

describe("check-shfmt.js", () => {
	it("checks the tracked shell set by default, naming each unformatted file and the fix", () => {
		const r = repo({
			"scripts/a.sh": BAD,
			"scripts/lib/b.sh": OK,
			".husky/pre-commit": BAD,
			"tools/c.sh": BAD,
			"vendor/d.sh": BAD,
			".gitattributes": "vendor/** linguist-vendored\n",
		});
		const { code, output } = run(r);
		expect(output).toMatch(/scripts\/a\.sh: not shfmt-formatted/);
		expect(output).toMatch(/\.husky\/pre-commit: not shfmt-formatted/);
		expect(output).toMatch(/tools\/c\.sh: not shfmt-formatted/);
		expect(output).not.toMatch(/vendor\/d\.sh/);
		expect(output).toMatch(/FAIL: 3 of 4 file\(s\) failed/);
		expect(output).toMatch(/Fix: node scripts\/check-shfmt\.js --write <path>/);
		expect(code).toBe(1);
		expect(fs.readFileSync(path.join(r.root, "scripts/a.sh"), "utf8")).toBe(
			BAD,
		);
	});

	it("formats in place with --write, and a check then passes", () => {
		const r = repo({ "scripts/a.sh": BAD });
		const write = run(r, ["--write"]);
		expect(write.output).toMatch(/OK: 1 of 1 file\(s\) rewritten/);
		expect(write.code).toBe(0);
		expect(fs.readFileSync(path.join(r.root, "scripts/a.sh"), "utf8")).toBe(OK);
		expect(run(r).code).toBe(0);
	});

	it("checks only the paths it is handed", () => {
		const r = repo({ "scripts/a.sh": BAD, "scripts/b.sh": OK });
		expect(run(r, ["scripts/b.sh"]).code).toBe(0);
	});

	it("fails on a file shfmt cannot parse, even with --write, naming the file", () => {
		const r = repo({ "scripts/a.sh": "if then fi (\n" });
		const { code, output } = run(r, ["--write"]);
		expect(output).toMatch(/scripts\/a\.sh: shfmt cannot parse it/);
		expect(code).toBe(1);
	});

	it("refuses to respace an unquoted associative-array key, offering the quoted form, and leaves the file as written (#1332)", () => {
		const body = "declare -A M\nM[a-b]=1\n";
		const r = repo({
			"scripts/a.sh": body,
			"scripts/q.sh": 'declare -A M\nM["a-b"]=1\n',
			"scripts/n.sh": "local -A N=(\n  [-x-y]=1\n)\n",
		});
		const { code, output } = run(r, ["--write"]);
		expect(output).toContain(
			'rewrite the key [a-b] as [a - b]; quote it: ["a-b"]',
		);
		expect(output).toContain("rewrite the key [-x-y] as [-x - y]");
		expect(code).toBe(1);
		expect(fs.readFileSync(path.join(r.root, "scripts/a.sh"), "utf8")).toBe(
			body,
		);
		expect(output).not.toContain("q.sh");
	});

	it("respaces an indexed array's arithmetic subscript, which means the same either way (#1332)", () => {
		const r = repo({ "scripts/a.sh": "w=(a b)\nw[i+1]=c\n" });
		const { code } = run(r, ["--write"]);
		expect(code).toBe(0);
		expect(fs.readFileSync(path.join(r.root, "scripts/a.sh"), "utf8")).toBe(
			"w=(a b)\nw[i + 1]=c\n",
		);
	});

	it("is BROKEN on a path that is not there, naming it (#1354)", () => {
		const { code, output } = run(repo({ "scripts/a.sh": OK }), [
			"scripts/gone.sh",
		]);
		expect(output).toMatch(/BROKEN: cannot read scripts\/gone\.sh/);
		expect(code).toBe(2);
	});

	it("is BROKEN where shfmt is not installed, naming the install (#1354)", () => {
		const { code, output } = run(repo({ "scripts/a.sh": OK }), [], {
			WFC_SHFMT: "/nonexistent/shfmt",
		});
		expect(output).toMatch(
			/BROKEN: @wasm-fmt\/shfmt is not installed — run npm install/,
		);
		expect(code).toBe(2);
	});

	it("is what CI's shfmt step runs", () => {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
		);
		const ci = fs.readFileSync(
			path.join(ROOT, ".github", "workflows", "ci.yml"),
			"utf8",
		);
		expect(pkg.scripts["check:sh:format"]).toBe("node scripts/check-shfmt.js");
		expect(ci).toMatch(/run: npm run check:sh:format/);
	});
});
