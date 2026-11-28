// @vitest-environment node

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SPEC as CLOSES } from "../check-commit-message-closes.js";
import { SPEC as WEAKENS } from "../check-weakens-line.js";
import { checkInProcess } from "./check.js";
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

const message = (body: string) => {
	const file = path.join(scratch(), "MSG");
	fs.writeFileSync(file, body);
	return file;
};

const STAND_DOWN = /^WFC_[A-Z0-9_]+_OFF$/;

const ENV = Object.fromEntries(
	Object.entries(process.env).filter(([k]) => !STAND_DOWN.test(k)),
);

beforeEach(() => {
	for (const k of Object.keys(process.env))
		if (STAND_DOWN.test(k)) vi.stubEnv(k, undefined);
});

const spawned = (cmd: string, args: string[], cwd = SCRIPTS) => {
	const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env: ENV });
	return { exit: r.status, stdout: r.stdout, stderr: r.stderr };
};

describe("the closing-keyword scan in-process equals check-commit-message-closes.js", () => {
	const Scanner = path.join(SCRIPTS, "check-commit-message-closes.js");
	it.each([
		["a clean message", "Add the thing\n\nBody.\n"],
		["a closing keyword", "Add the thing\n\nFixes #12\n"],
		["a Revert line only", 'Revert "Fixes #77 old"\n\nThis reverts x.\n'],
		["an unreadable message file", null],
	])("on %s", async (_name, body) => {
		const file = body === null ? "/nonexistent/MSG" : message(body);
		expect(
			await checkInProcess(CLOSES, [file, "commit-msg"], { script: Scanner }),
		).toEqual(spawned(process.execPath, [Scanner, file, "commit-msg"]));
	});
});

describe("the Weakens: check in-process equals check-weakens-line.js", () => {
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
