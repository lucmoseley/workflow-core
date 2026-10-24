// @vitest-environment node
/*
 * Pins that a granted permission lands once in the right settings file's allow
 * list, with every other key, entry, indentation and layout kept.
 *
 * grant-permission.js adds one rule to a Claude Code settings file (#596).
 *
 * Every case drives the CLI in-process against a throwaway git repo and reads
 * back only what the founder sees: the exit, the printed line, the file's
 * bytes. The repo shuts out the developer's global git excludes, which ignore
 * settings.local.json on this machine and would silence the git-ignore warning
 * whatever the script did. Loosening a byte-exact assertion here lets a
 * rewrite reorder or reflow a founder's hand-kept settings unnoticed.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "grant-permission.js");

let host: string;
let home: string;
const local = () => path.join(host, ".claude", "settings.local.json");
const project = () => path.join(host, ".claude", "settings.json");

const isolatedEnv = (extra: Record<string, string> = {}) => ({
	PATH: process.env.PATH ?? "",
	HOME: home,
	XDG_CONFIG_HOME: home,
	GIT_CONFIG_NOSYSTEM: "1",
	...extra,
});

beforeEach(() => {
	host = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "grant-permission-")),
	);
	home = fs.mkdtempSync(path.join(os.tmpdir(), "grant-permission-home-"));
	execFileSync("git", ["init", "-q"], { cwd: host, env: isolatedEnv() });
	fs.writeFileSync(
		path.join(host, ".gitignore"),
		".claude/settings.local.json\n",
	);
});
afterEach(() => {
	fs.rmSync(host, { recursive: true, force: true });
	fs.rmSync(home, { recursive: true, force: true });
});

const run = (...args: string[]) => {
	const r = runInProcess(SCRIPT, args, {
		cwd: host,
		env: isolatedEnv({ CLAUDE_PROJECT_DIR: host }),
	});
	return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

describe("grant-permission", () => {
	it("creates the local settings file and its permissions object where absent", () => {
		const r = run("Bash(git status *)");
		expect(r.status).toBe(0);
		expect(readJson(local())).toEqual({
			permissions: { allow: ["Bash(git status *)"] },
		});
		expect(r.stdout).toBe(
			`grant-permission: added Bash(git status *) to ${local()}\n`,
		);
		expect(r.stderr).toBe("");
		expect(fs.existsSync(project())).toBe(false);
	});

	it("--project writes the committed settings file instead", () => {
		const r = run("--project", "Read");
		expect(r.status).toBe(0);
		expect(readJson(project())).toEqual({ permissions: { allow: ["Read"] } });
		expect(fs.existsSync(local())).toBe(false);
		expect(r.stdout).toContain(project());
	});

	it("adds a permissions object to a file without one, keeping every other key in order", () => {
		fs.mkdirSync(path.dirname(local()));
		fs.writeFileSync(
			local(),
			'{\n\t"b": 1,\n\t"a": {\n\t\t"x": true\n\t}\n}\n',
		);
		expect(run("Write").status).toBe(0);
		expect(fs.readFileSync(local(), "utf8")).toBe(
			'{\n\t"b": 1,\n\t"a": {\n\t\t"x": true\n\t},\n\t"permissions": {\n\t\t"allow": [\n\t\t\t"Write"\n\t\t]\n\t}\n}\n',
		);
	});

	it("appends after existing entries, keeping their order, the indentation and the other permission lists", () => {
		fs.mkdirSync(path.dirname(local()));
		const before = {
			permissions: { deny: ["Bash(rm *)"], allow: ["Z", "A"] },
			env: { K: "v" },
		};
		fs.writeFileSync(local(), `${JSON.stringify(before, null, 4)}\n`);
		expect(run("mcp__github__get_issue").status).toBe(0);
		const after = {
			permissions: {
				deny: ["Bash(rm *)"],
				allow: ["Z", "A", "mcp__github__get_issue"],
			},
			env: { K: "v" },
		};
		expect(fs.readFileSync(local(), "utf8")).toBe(
			`${JSON.stringify(after, null, 4)}\n`,
		);
	});

	it("reports a rule already present, exits 0 and does not rewrite the file", () => {
		fs.mkdirSync(path.dirname(local()));
		const text = '{ "permissions": { "allow": ["Read"] } }';
		fs.writeFileSync(local(), text);
		const mtime = fs.statSync(local()).mtimeMs;
		const r = run("Read");
		expect(r.status).toBe(0);
		expect(r.stdout).toBe(
			`grant-permission: Read is already allowed in ${local()} — left unchanged\n`,
		);
		expect(fs.readFileSync(local(), "utf8")).toBe(text);
		expect(fs.statSync(local()).mtimeMs).toBe(mtime);
	});

	it("keeps a one-line file on one line", () => {
		fs.mkdirSync(path.dirname(local()));
		fs.writeFileSync(local(), '{"env":{"K":"v"}}');
		expect(run("Read").status).toBe(0);
		expect(fs.readFileSync(local(), "utf8")).toBe(
			'{"env":{"K":"v"},"permissions":{"allow":["Read"]}}',
		);
	});

	it.each([
		"Read",
		"mcp__github__*",
		'Bash(echo ")")',
		'Bash(grep -E "a(" *)',
		"WebFetch(domain:example.com)",
	])("accepts the rule %j", (rule) => {
		expect(run(rule).status).toBe(0);
		expect(readJson(local()).permissions.allow).toEqual([rule]);
	});

	it("running the same rule twice adds it once", () => {
		run("Edit");
		run("Edit");
		expect(readJson(local()).permissions.allow).toEqual(["Edit"]);
	});

	it.each([
		"",
		"Bash()",
		"Bash( )",
		"Bash(git status",
		"Bash(x)y",
		"1Bash",
		"Bash git",
		"Bash(a\nb)",
	])("refuses the malformed rule %j and touches nothing", (rule) => {
		const r = run(rule);
		expect(r.status).toBe(2);
		expect(r.stderr).toBe(
			`grant-permission: refused, settings untouched — ${JSON.stringify(rule)} is not a permission rule. Give a tool name, optionally with a non-empty parenthesised specifier, e.g. 'Bash(git status *)'.\n`,
		);
		expect(fs.existsSync(local())).toBe(false);
	});

	it.each([
		[
			"a file that will not parse",
			'{ "permissions": { "allow": [ } ',
			/will not parse as JSON \(.+\)\. Fix it by hand, then re-run\.$/,
		],
		["a top level that is not an object", "[]", /holds no JSON object/],
		[
			"a permissions that is not an object",
			'{ "permissions": [] }',
			/"permissions" in .+ is not an object\.$/,
		],
		[
			"an allow that is not a list",
			'{ "permissions": { "allow": "Read" } }',
			/"permissions\.allow" in .+ is not a list\.$/,
		],
	])(
		"refuses %s, exit 1, naming the file and why, file untouched",
		(_label, text, why) => {
			fs.mkdirSync(path.dirname(local()));
			fs.writeFileSync(local(), text);
			const r = run("Read");
			expect(r.status).toBe(1);
			expect(r.stderr).toMatch(
				/^grant-permission: refused, settings untouched — /,
			);
			expect(r.stderr).toContain(local());
			expect(r.stderr.trimEnd()).toMatch(why);
			expect(fs.readFileSync(local(), "utf8")).toBe(text);
			expect(fs.readdirSync(path.dirname(local()))).toEqual([
				"settings.local.json",
			]);
		},
	);

	it("warns in local mode when git does not ignore the local file, and still writes it", () => {
		fs.writeFileSync(path.join(host, ".gitignore"), "");
		const r = run("Read");
		expect(r.status).toBe(0);
		expect(r.stderr).toContain(
			"git does not ignore .claude/settings.local.json",
		);
		expect(readJson(local()).permissions.allow).toEqual(["Read"]);
	});

	it("does not warn about the git-ignore in --project mode", () => {
		fs.writeFileSync(path.join(host, ".gitignore"), "");
		expect(run("--project", "Read").stderr).toBe("");
	});

	it("resolves an adopting repository's root from its working directory when no project dir is declared", () => {
		const sub = path.join(host, "deep", "er");
		fs.mkdirSync(sub, { recursive: true });
		const r = runInProcess(SCRIPT, ["Read"], {
			cwd: sub,
			env: isolatedEnv(),
		});
		expect(r.status).toBe(0);
		expect(readJson(local()).permissions.allow).toEqual(["Read"]);
	});

	it.each([[["Read", "Write"]], [["--local", "Read"]]])(
		"rejects the arguments %j with the usage",
		(args) => {
			const r = run(...args);
			expect(r.status).toBe(2);
			expect(r.stderr).toMatch(
				/^usage: grant-permission\.js '<rule>' \[--project\]/m,
			);
			expect(fs.existsSync(local())).toBe(false);
		},
	);
});
