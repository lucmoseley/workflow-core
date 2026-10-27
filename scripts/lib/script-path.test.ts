// @vitest-environment node
/*
 * Tests for scripts/lib/script-path.js and its bash twin (#343): a message
 * names a core script by a path that resolves where the session runs.
 *
 * An install is simulated by pointing WFC_SCRIPT_ROOT at a throwaway tree with
 * no package.json; the checkout case is this repo itself.
 *
 * Every guard message that tells a session to run a core script spells it
 * through one of the two; loosen a case and an adopter's session is handed a
 * `scripts/x` that resolves nowhere in its install, or the twins drift apart.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COMMAND_SHAPED, PLAIN_POINTER } from "./script-path-testkit";

const SH = path.join(__dirname, "script-path.sh");
const RULE_SH = path.join(__dirname, "rule-text.sh");
const SCRIPTS = path.join(__dirname, "..");

// biome-ignore lint/suspicious/noExplicitAny: CommonJS module under test
const lib = require("./script-path") as any;
// biome-ignore lint/suspicious/noExplicitAny: CommonJS module under test
const ruleTextLib = require("./rule-text") as any;

const temps: string[] = [];

afterEach(() => {
	for (const t of temps.splice(0))
		fs.rmSync(t, { recursive: true, force: true });
	delete process.env.WFC_SCRIPT_ROOT;
	delete process.env.WFC_RULES_DIR;
	delete process.env.WFC_RULES_FALLBACK_DIR;
});

/** A throwaway plugin install holding `files` under scripts/. */
function install(files: string[], prefix = "script-path-"): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	temps.push(root);
	for (const f of files) {
		fs.mkdirSync(path.dirname(path.join(root, "scripts", f)), {
			recursive: true,
		});
		fs.writeFileSync(path.join(root, "scripts", f), "");
	}
	return root;
}

function bash(script: string, env: Record<string, string>, input = "") {
	const r = spawnSync("bash", ["-c", `source "${SH}"; ${script}`], {
		input,
		encoding: "utf8",
		env: { ...process.env, ...env },
	});
	expect(r.stderr).toBe("");
	expect(r.status).toBe(0);
	return r.stdout;
}

describe("in a source checkout", () => {
	it("names a script repo-relative", () => {
		expect(lib.scriptPath("session-arbiter.js")).toBe(
			"scripts/session-arbiter.js",
		);
		expect(bash("script_path session-arbiter.js", {})).toBe(
			"scripts/session-arbiter.js",
		);
	});

	it("spells a paste line's host root and script absolute, in both twins (#643)", () => {
		const text = "cd {host-root} && node {script:write-secret.js} X";
		const want = `cd '/h o/st' && node ${path.resolve(__dirname, "..", "write-secret.js")} X`;
		expect(lib.expandPastePaths(text, "/h o/st")).toBe(want);
		expect(bash('expand_paste_paths "/h o/st"', {}, text)).toBe(want);
	});

	it.each(["/tmp/a b/{script:x}", "/tmp/a b/{host-root}", "/tmp/a&b"])(
		"spells a host root verbatim, in both twins (#2613): %s",
		(host) => {
			const text = "cd {host-root} && node {script:y.js}";
			const want = `cd '${host}' && node ${path.join(SCRIPTS, "y.js")}`;
			expect(lib.expandPastePaths(text, host)).toBe(want);
			expect(bash(`expand_paste_paths '${host}'`, {}, text)).toBe(want);
		},
	);

	it("names a doc repo-relative", () => {
		expect(lib.docPath("agents/issue-tracker.md")).toBe(
			"docs/agents/issue-tracker.md",
		);
		expect(bash("doc_path agents/issue-tracker.md", {})).toBe(
			"docs/agents/issue-tracker.md",
		);
	});

	it("names any core file repo-relative (#2234)", () => {
		expect(lib.corePath(".claude/skills/x/scripts/y.js")).toBe(
			".claude/skills/x/scripts/y.js",
		);
	});

	it("leaves text untouched", () => {
		const text = "run `node scripts/session-arbiter.js list`.";
		expect(lib.resolveScriptPaths(text)).toBe(text);
		expect(bash("resolve_script_paths", {}, text)).toBe(text);
	});
});

/* Both bash libraries resolve their own directory once, at source, rather than
 * forking dirname per call (#653). */
describe("the bash twins' own directory", () => {
	const inLib = (script: string) =>
		spawnSync("bash", ["-c", script], { cwd: __dirname, encoding: "utf8" });

	it("stays the core root after the caller changes directory", () => {
		const r = spawnSync(
			"bash",
			["-c", `source "${SH}"; cd /; sp_core_root; echo; script_path x.js`],
			{ encoding: "utf8" },
		);
		expect(r.stderr).toBe("");
		expect(r.stdout).toBe(
			`${path.dirname(fs.realpathSync(SCRIPTS))}\nscripts/x.js`,
		);
	});

	it("resolves when sourced by a bare name from its own directory", () => {
		const r = inLib("source script-path.sh; sp_core_root");
		expect(r.stderr).toBe("");
		expect(r.stdout).toBe(path.dirname(fs.realpathSync(SCRIPTS)));
	});

	it("prints a rule when rule-text.sh is run by a bare name", () => {
		const id = spawnSync(RULE_SH, ["--ids"], { encoding: "utf8" }).stdout.split(
			"\n",
		)[0];
		const r = inLib(`bash rule-text.sh ${id}`);
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
		expect(r.stdout.trim().length).toBeGreaterThan(0);
	});
});

describe("in a plugin install", () => {
	it("names a script under the plugin root", () => {
		const root = install(["session-arbiter.js"]);
		process.env.WFC_SCRIPT_ROOT = root;
		const want = `${root}/scripts/session-arbiter.js`;
		expect(lib.scriptPath("session-arbiter.js")).toBe(want);
		expect(
			bash("script_path session-arbiter.js", { WFC_SCRIPT_ROOT: root }),
		).toBe(want);
	});

	it("names a doc under the plugin root (#1010)", () => {
		const root = install([]);
		process.env.WFC_SCRIPT_ROOT = root;
		const want = `${root}/docs/agents/issue-tracker.md`;
		expect(lib.docPath("agents/issue-tracker.md")).toBe(want);
		expect(
			bash("doc_path agents/issue-tracker.md", { WFC_SCRIPT_ROOT: root }),
		).toBe(want);
	});

	it("names any core file absolute from a checkout the cwd is outside (#2234)", () => {
		const root = install([]);
		fs.writeFileSync(path.join(root, "package.json"), "{}");
		process.env.WFC_SCRIPT_ROOT = root;
		expect(lib.corePath(".claude/skills/x/scripts/y.js")).toBe(
			`${root}/.claude/skills/x/scripts/y.js`,
		);
	});

	it("names any core file under the plugin root (#2234)", () => {
		const root = install([]);
		process.env.WFC_SCRIPT_ROOT = root;
		expect(lib.corePath(".claude/skills/x/scripts/y.js")).toBe(
			`${root}/.claude/skills/x/scripts/y.js`,
		);
	});

	it("quotes a doc under a root a shell would split", () => {
		const root = install([], "doc path '");
		process.env.WFC_SCRIPT_ROOT = root;
		const got = lib.docPath("agents/t.md");
		expect(got.startsWith("'")).toBe(true);
		expect(bash("doc_path agents/t.md", { WFC_SCRIPT_ROOT: root })).toBe(got);
	});

	it("spells a paste line's script at the plugin root, in both twins", () => {
		const root = install(["write-secret.js"]);
		process.env.WFC_SCRIPT_ROOT = root;
		const text = "node {script:write-secret.js} X";
		const want = `node ${lib.scriptPath("write-secret.js")} X`;
		expect(lib.expandPastePaths(text, "/h")).toBe(want);
		expect(
			bash('expand_paste_paths "/h"', { WFC_SCRIPT_ROOT: root }, text),
		).toBe(want);
	});

	it("quotes a root a shell would split", () => {
		const root = install(["x.sh"], "script path '");
		process.env.WFC_SCRIPT_ROOT = root;
		const got = lib.scriptPath("x.sh");
		expect(got.startsWith("'")).toBe(true);
		expect(bash("script_path x.sh", { WFC_SCRIPT_ROOT: root })).toBe(got);
		const echoed = spawnSync("bash", ["-c", `printf %s ${got}`], {
			encoding: "utf8",
		});
		expect(echoed.stdout).toBe(`${root}/scripts/x.sh`);
	});

	const cases: [string, (root: string) => string][] = [
		["node scripts/a.js list", (r) => `node ${r}/scripts/a.js list`],
		[
			"`scripts/lib/b.sh check <name>`",
			(r) => `\`${r}/scripts/lib/b.sh check <name>\``,
		],
		["see scripts/a.js.", (r) => `see ${r}/scripts/a.js.`],
		["run ./scripts/a.js", (r) => `run ${r}/scripts/a.js`],
		[
			"an adopter's scripts/own.js stays",
			() => "an adopter's scripts/own.js stays",
		],
		["a glob scripts/guard-* stays", () => "a glob scripts/guard-* stays"],
		["a tail foo/scripts/a.js stays", () => "a tail foo/scripts/a.js stays"],
		// biome-ignore lint/suspicious/noTemplateCurlyInString: a shell variable, the left edge under test
		["${X}scripts/a.js stays", () => "${X}scripts/a.js stays"],
		[
			"scripts/a.js then scripts/lib/b.sh",
			(r) => `${r}/scripts/a.js then ${r}/scripts/lib/b.sh`,
		],
		["no path at all", () => "no path at all"],
	];

	it.each(cases)("resolves %j, both twins alike", (text, want) => {
		const root = install(["a.js", "lib/b.sh"]);
		process.env.WFC_SCRIPT_ROOT = root;
		expect(lib.resolveScriptPaths(text)).toBe(want(root));
		expect(bash("resolve_script_paths", { WFC_SCRIPT_ROOT: root }, text)).toBe(
			want(root),
		);
	});

	/* Any doc the install holds resolves; one it lacks — a doc the host owns —
	 * stays (#1010, #1452). */
	const docCases: [string, (root: string) => string][] = [
		[
			'Rules: docs/agents/t.md, "Placing".',
			(r) => `Rules: ${r}/docs/agents/t.md, "Placing".`,
		],
		["read `docs/agents/t.md`.", (r) => `read \`${r}/docs/agents/t.md\`.`],
		["see docs/agents/t.md.", (r) => `see ${r}/docs/agents/t.md.`],
		[
			"a doc it lacks docs/agents/no.md stays",
			() => "a doc it lacks docs/agents/no.md stays",
		],
		["read docs/env.md §6.", (r) => `read ${r}/docs/env.md §6.`],
		[
			"the host's docs/doc-map.md stays",
			() => "the host's docs/doc-map.md stays",
		],
		[
			"a tail x/docs/agents/t.md stays",
			() => "a tail x/docs/agents/t.md stays",
		],
	];

	it.each(docCases)("resolves %j, both twins alike", (text, want) => {
		const root = install(["a.js"]);
		fs.mkdirSync(path.join(root, "docs", "agents"), { recursive: true });
		fs.writeFileSync(path.join(root, "docs", "agents", "t.md"), "");
		fs.writeFileSync(path.join(root, "docs", "env.md"), "");
		process.env.WFC_SCRIPT_ROOT = root;
		expect(lib.resolveScriptPaths(text)).toBe(want(root));
		expect(bash("resolve_script_paths", { WFC_SCRIPT_ROOT: root }, text)).toBe(
			want(root),
		);
	});

	it("serves a rule fragment resolved, from both rule-text accessors", () => {
		const root = install(["issue-body.js"]);
		const rules = fs.mkdtempSync(path.join(os.tmpdir(), "script-path-rules-"));
		temps.push(rules);
		fs.writeFileSync(
			path.join(rules, "demo.txt"),
			"Route it through `node scripts/issue-body.js append`.\n",
		);
		const env = { WFC_SCRIPT_ROOT: root, WFC_RULES_DIR: rules };
		Object.assign(process.env, env);
		const want = `Route it through \`node ${root}/scripts/issue-body.js append\`.`;
		expect(ruleTextLib.readRuleText("demo")).toBe(want);
		const r = spawnSync("bash", [RULE_SH, "demo"], {
			encoding: "utf8",
			env: { ...process.env, ...env },
		});
		expect(r.stdout).toBe(`${want}\n`);
	});
});

/*
 * The regression #343 exists for: a guard or lib message that tells a session
 * to RUN a script by a bare path. These pin the shapes the scan reads; the
 * scan over the real scripts is `script-path-scan.test.ts` (#1900).
 */
describe("a message line's script-path shape", () => {
	it.each([
		["node scripts/x.js list", true],
		["source scripts/lib/x.sh", true],
		["$(scripts/x.sh)", true],
		["`scripts/x.sh check <name>`", true],
		["`fault (node scripts/x.js)`", true],
		["see `scripts/x.js`", false],
		["see scripts/x.js", false],
	])("reads %j as command-shaped: %s", (line, want) => {
		expect(COMMAND_SHAPED.test(line)).toBe(want);
	});

	it.each([
		["To link: scripts/x.sh <parent> <child>", true],
		["The full rule: scripts/lib/x.sh founder-deliverable", true],
		["see `scripts/x.js` at session start", false],
		["see scripts/x.js.", false],
		["a tail foo/scripts/x.js list", false],
	])("reads %j as a plain pointer: %s", (line, want) => {
		expect(PLAIN_POINTER.test(line)).toBe(want);
	});
});
