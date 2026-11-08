// @vitest-environment node
/*
 * run-pinned-guards.js runs the guard entry from the pinned guard code (#4227): its
 * refusals where that code is missing or throws, and the hook line run end to
 * end over the 3 Nov case. spawn-kept: the shim's contract is its own process —
 * it rewrites process.argv for the entry and ends on process.exit(2).
 *
 * Break it and a working copy's edit reaches the hooks again, or a load fault
 * refuses every call with no repair the founder can paste.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isLockoutText } from "./lib/core-fault.js";
import { SELF_PLUGIN_DIR } from "./lib/core-hooks.js";
import { MAIN_SCRIPTS } from "./lib/core-hooks-testkit";
import { readHookLines } from "./lib/pretool-guard-testkit";

const SHIM = path.join(__dirname, "run-pinned-guards.js");
const CHECKOUT = path.resolve(__dirname, "..");
const HOOKS = "self-plugin/hooks/hooks.json";

const THROWS = "throw new SyntaxError(\"Unexpected token '}'\");\n";

let dir: string;
let link: string;

/* A guard code worktree `name` whose entry is `entry` and whose kit is `kit`. */
function code(name: string, entry: string, kit = ""): string {
	const at = path.join(dir, ".guard-code", name);
	fs.mkdirSync(path.join(at, "scripts", "lib"), { recursive: true });
	fs.writeFileSync(path.join(at, "scripts", "guard-dispatch.js"), entry);
	fs.writeFileSync(path.join(at, "scripts", "lib", "guard-dispatch.js"), kit);
	return at;
}

const entryOf = () => path.join(link, "scripts", "guard-dispatch.js");

const runShim = (...args: string[]) =>
	spawnSync(process.execPath, [SHIM, ...args], {
		encoding: "utf8",
		input: "{}",
	});

beforeEach(() => {
	dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "run-pinned-guards-")),
	);
	link = path.join(dir, ".guard-code.current");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("the shim", () => {
	it("refuses with exit 2 and the adopt command where the link is missing, as on a fresh machine", () => {
		const r = runShim(entryOf());
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/^Guard code missing/);
		expect(isLockoutText(r.stderr)).toBe(true);
		expect(r.stderr).toContain(
			`! node '${path.join(__dirname, "adopt-guard-code.js")}'`,
		);
	});

	it("refuses with exit 2, the error's first line and the roll-back where the live code fails to load", () => {
		const before = code("aaa", "");
		const failing = code("bbb", "", THROWS);
		fs.symlinkSync(before, path.join(dir, ".guard-code.previous"));
		fs.symlinkSync(failing, link);
		const r = runShim(entryOf());
		expect(r.status).toBe(2);
		expect(isLockoutText(r.stderr)).toBe(true);
		expect(r.stderr).toMatch(
			/^Guard code failed .*\(bbb\): Unexpected token '}'\nIt fails to load/,
		);
		const repair = r.stderr.match(/^ {2}! (.*)$/m)?.[1] ?? "";
		expect(repair).toContain("mv -T");
		execFileSync("bash", ["-c", repair]);
		expect(fs.readlinkSync(link)).toBe(before);
		expect(fs.existsSync(path.join(dir, ".guard-code.previous"))).toBe(false);
		expect(fs.readFileSync(path.join(dir, ".guard-code.refused"), "utf8")).toBe(
			"bbb\n",
		);
	});

	it("offers the roll-back only where every call fails so, where the entry throws judging the call", () => {
		fs.symlinkSync(code("aaa", ""), path.join(dir, ".guard-code.previous"));
		fs.symlinkSync(code("bbb", 'throw new Error("stdin unreadable");\n'), link);
		const r = runShim(entryOf());
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(
			/: stdin unreadable\nIt threw judging this call\. Where every call fails so/,
		);
	});

	it("names the adopt command where the live code throws and there is no previous", () => {
		fs.symlinkSync(code("bbb", THROWS), link);
		const r = runShim(entryOf());
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(
			`! node '${path.join(__dirname, "adopt-guard-code.js")}'`,
		);
	});

	it("runs the entry as if run directly, its argv its own", () => {
		fs.symlinkSync(
			code(
				"aaa",
				"process.stdout.write(JSON.stringify(process.argv.slice(1).map((a, i) => i ? a : require('path').basename(a))));\n",
			),
			link,
		);
		const r = runShim(entryOf(), "--only", "x");
		expect(r.status).toBe(0);
		expect(JSON.parse(r.stdout)).toEqual(["guard-dispatch.js", "--only", "x"]);
	});
});

describe("the hook line", () => {
	const [line] = readHookLines(HOOKS, "scripts/guard-dispatch.js");

	it("runs the guards through the shim from the pinned code", () => {
		expect(line).toContain(`${MAIN_SCRIPTS}run-pinned-guards.js `);
		expect(line).toMatch(
			/\.guard-code\}"\.current\/scripts\/guard-dispatch\.js$/,
		);
	});

	/* The 3 Nov case (#4203): one uncommitted syntax error in the main
	 * checkout's shell-parse.js refused every guarded call in every session. */
	it("leaves the guards working past a syntax error in the main checkout's shell-parse.js", () => {
		const main = path.join(dir, "main");
		fs.cpSync(path.join(CHECKOUT, "scripts"), path.join(main, "scripts"), {
			recursive: true,
		});
		fs.mkdirSync(path.join(main, SELF_PLUGIN_DIR));
		execFileSync("git", ["init", "--quiet", main]);
		fs.appendFileSync(path.join(main, "scripts/lib/shell-parse.js"), "}{\n");
		fs.symlinkSync(CHECKOUT, link);
		const payload = JSON.stringify({
			session_id: `run-pinned-guards-test-${path.basename(dir)}`,
			transcript_path: "/dev/null",
			cwd: main,
			hook_event_name: "PreToolUse",
			tool_name: "Bash",
			tool_input: { command: "ls" },
		});
		const run = (command: string) =>
			spawnSync("/bin/bash", ["-c", command], {
				cwd: main,
				encoding: "utf8",
				input: payload,
				env: {
					...process.env,
					CLAUDE_PROJECT_DIR: main,
					CLAUDE_PLUGIN_ROOT: path.join(main, SELF_PLUGIN_DIR),
					CLAUDE_CONFIG_DIR: path.join(dir, "config"),
					WFC_GUARD_CODE_DIR: path.join(dir, ".guard-code"),
				},
			});
		const unpinned = run(`node ${MAIN_SCRIPTS}guard-dispatch.js`);
		expect(unpinned.stdout).toMatch(/failed to load — fix that module/);
		const r = run(line ?? "");
		expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
	});
});
