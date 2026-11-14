// @vitest-environment node
/*
 * The equivalence contract for .husky/commit-msg's three checks (#5207): the
 * closing-keyword scan, the subject check and the `Weakens:` check, each run
 * in-process as its dispatcher row runs it, give the same exit code, stdout
 * and stderr as the program the hook spawned, over the same message and
 * tree. Each case runs both ways and compares them, never against a
 * hand-written expectation.
 *
 * Loosen a case and a check whose in-process run drifts from its program
 * refuses, or passes, a commit differently from the hook it replaced.
 *
 * spawn-kept: `spawned` is the program each in-process run is held to.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main as scanCloses } from "../check-commit-message-closes.js";
import { SPEC as WEAKENS } from "../check-weakens-line.js";
import { checkInProcess } from "./check.js";
import { checkSubject } from "./commit-subject.js";
import { initGitRepo, mkScratchDir } from "./git-fixture";

const SCRIPTS = path.join(__dirname, "..");

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0))
		fs.rmSync(d, { recursive: true, force: true });
});

const scratch = () => {
	const d = fs.realpathSync(mkScratchDir("commit-msg-checks-"));
	dirs.push(d);
	return d;
};

/** A message file holding `body`. */
const message = (body: string) => {
	const file = path.join(scratch(), "MSG");
	fs.writeFileSync(file, body);
	return file;
};

/** process.env less any gate stand-down a developer has exported. */
const ENV = Object.fromEntries(
	Object.entries(process.env).filter(([k]) => !/^WFC_[A-Z0-9_]+_OFF$/.test(k)),
);

const spawned = (cmd: string, args: string[], cwd = SCRIPTS) => {
	const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env: ENV });
	return { exit: r.status, stdout: r.stdout, stderr: r.stderr };
};

const LONG = "x".repeat(73);

describe("the closing-keyword scan in-process equals check-commit-message-closes.sh", () => {
	it.each([
		["a clean message", "Add the thing\n\nBody.\n"],
		["a closing keyword", "Add the thing\n\nFixes #12\n"],
		["a Revert line only", 'Revert "Fixes #77 old"\n\nThis reverts x.\n'],
	])("on %s", (_name, body) => {
		const file = message(body);
		const r = scanCloses([file, "commit-msg"]);
		expect({ exit: r.code, stdout: "", stderr: r.stderr }).toEqual(
			spawned("bash", [
				path.join(SCRIPTS, "check-commit-message-closes.sh"),
				file,
				"commit-msg",
			]),
		);
	});

	it("on an unreadable message file", () => {
		const r = scanCloses(["/nonexistent/MSG", "commit-msg"]);
		expect({ exit: r.code, stdout: "", stderr: r.stderr }).toEqual(
			spawned("bash", [
				path.join(SCRIPTS, "check-commit-message-closes.sh"),
				"/nonexistent/MSG",
				"commit-msg",
			]),
		);
	});
});

describe("the subject check in-process equals check-commit-subject.sh", () => {
	const both = (args: string[]) => {
		const r = checkSubject(args);
		expect({ exit: r.code, stdout: "", stderr: r.stderr }).toEqual(
			spawned("bash", [path.join(SCRIPTS, "check-commit-subject.sh"), ...args]),
		);
		return r.code;
	};

	it.each([
		["72 characters", `${"x".repeat(72)}\n`, 0],
		["73 characters", `${LONG}\n`, 1],
		["72 two-byte characters", `${"é".repeat(72)}\n`, 0],
		["73 two-byte characters", `${"é".repeat(73)}\n`, 1],
		["a subject below blank lines", `\n  \n${LONG}  \n\nbody\n`, 1],
		["trailing whitespace past 72", `${"x".repeat(72)}   \t\n`, 0],
		["a `#` line, dropped as a comment", `#2332 ${LONG}\n`, 0],
		["git's Revert", `Revert "${LONG}"\n`, 0],
		["a Revert with no closing quote", `Revert "${LONG}\n`, 1],
		["the lander's merge", `Merge queue/${LONG} into the batch\n`, 0],
		["a fixup", `fixup! ${LONG}\n`, 0],
		["an empty message", "", 0],
	])("on %s", (_name, body, code) => {
		expect(both([message(body), "commit-msg"])).toBe(code);
	});

	it("on an unreadable file, and on no context given", () => {
		expect(both(["/nonexistent/MSG", "commit-msg"])).toBe(1);
		expect(both([message(`${LONG}\n`)])).toBe(1);
		expect(both([])).toBe(1);
	});
});

describe("the Weakens: check in-process equals check-weakens-line.js", () => {
	/** A repo whose HEAD config disables nothing, `staged` its next config. */
	const repo = (staged: string[]) => {
		const dir = scratch();
		initGitRepo(dir, path.join(dir, ".git", "no-hooks"));
		const cfg = path.join(dir, ".claude", "workflow-core.json");
		fs.mkdirSync(path.dirname(cfg));
		fs.writeFileSync(cfg, '{ "disabled": [] }\n');
		const git = (...a: string[]) =>
			execFileSync("git", a, { cwd: dir, env: ENV });
		git("add", "-A");
		git("commit", "-qm", "seed");
		fs.writeFileSync(cfg, `${JSON.stringify({ disabled: staged })}\n`);
		git("add", "-A");
		return dir;
	};

	it.each([
		["nothing weakened", [], "Add\n"],
		["an unnamed module-off", ["guard-x"], "Add\n"],
		["a named module-off", ["guard-x"], "Add\n\nWeakens: guard-x — why\n"],
	])("on %s", async (_name, staged, body) => {
		const dir = repo(staged);
		const file = message(body);
		const prev = process.cwd();
		process.chdir(dir);
		let inProcess: Awaited<ReturnType<typeof checkInProcess>>;
		try {
			inProcess = await checkInProcess(WEAKENS, [file], {
				script: path.join(SCRIPTS, "check-weakens-line.js"),
			});
		} finally {
			process.chdir(prev);
		}
		expect(inProcess).toEqual(
			spawned(
				process.execPath,
				[path.join(SCRIPTS, "check-weakens-line.js"), file],
				dir,
			),
		);
	});
});
