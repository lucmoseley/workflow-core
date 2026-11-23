// @vitest-environment node
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAgentsBranch, buildListedRow } from "./lib/agents-stop-fake";
import { writeClaudeStub } from "./lib/claude-stub";
import { defineTemplate } from "./lib/git-fixture";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.join(__dirname, "check-main-checkout-cutover.js");

let tmp: string;
let main: string;
let config: string;

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

const upstream = () =>
	execFileSync("git", ["config", "--get", "branch.main.merge"], {
		cwd: main,
		encoding: "utf8",
		stdio: "pipe",
	}).trim();

const listSessionIn = (cwd: string) =>
	writeClaudeStub(path.join(config, "bin", "claude"), [
		buildAgentsBranch([
			buildListedRow({ name: "live", sessionId: "s-1", cwd }),
		]),
	]);

const originAndClone = defineTemplate((at) => {
	const origin = path.join(at, "origin.git");
	const clone = path.join(at, "main");
	fs.mkdirSync(path.join(at, "config", "bin"), { recursive: true });
	fs.writeFileSync(
		path.join(at, "npm"),
		"#!/bin/sh\nmkdir node_modules && cp package-lock.json node_modules/lock\n",
	);
	fs.chmodSync(path.join(at, "npm"), 0o755);
	git(at, "init", "-q", "--bare", "-b", "main", origin);
	git(at, "clone", "-q", origin, clone);
	git(clone, "config", "user.email", "t@t");
	git(clone, "config", "user.name", "t");
	for (const [name, text] of Object.entries({
		".gitignore": ".claude/\n",
		"package-lock.json": "{}\n",
	}))
		fs.writeFileSync(path.join(clone, name), text);
	git(clone, "add", "-A");
	git(clone, "commit", "-qm", "seed");
	git(clone, "push", "-q", "origin", "HEAD:main", "HEAD:landing");
	git(clone, "branch", "-q", "--set-upstream-to=origin/landing", "main");
});

beforeEach(() => {
	tmp = originAndClone.instantiate(
		fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "main-checkout-cutover-")),
		),
	);
	main = path.join(tmp, "main");
	config = path.join(tmp, "config");
});
afterEach(() => {
	execFileSync("chmod", ["-R", "u+w", tmp]);
	fs.rmSync(tmp, { recursive: true, force: true });
});

const check = (...args: string[]) => {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		WFC_REPO_ROOT: main,
		CLAUDE_PROJECT_DIR: main,
		CLAUDE_CONFIG_DIR: config,
		WFC_CLAUDE_CONFIG_A: config,
		WFC_CLAUDE_CONFIG_B: config,
		WFC_CLAUDE_CONFIG_C: config,
		WFC_CLAUDE_BIN: path.join(config, "bin", "claude"),
		WFC_NPM: path.join(tmp, "npm"),
	};
	delete env.CLAUDE_CODE_SESSION_ID;
	return runInProcess(SCRIPT, args, { cwd: main, env });
};

describe("check-main-checkout-cutover.js (#5276)", () => {
	it("cuts over a main checkout no session stands in, printing the cutover's report", () => {
		listSessionIn(tmp);
		const r = check("--notify");
		expect(r.stdout).toContain("the main checkout is cut over");
		expect(() => upstream()).toThrow();
	});

	it("fails naming the session standing in the main checkout, cutting nothing over", () => {
		listSessionIn(main);
		const r = check("--notify");
		expect(r.stdout).toContain("OCCUPIED");
		expect(r.stdout).toContain("1 session(s) stand in it: live");
		expect(upstream()).toBe("refs/heads/landing");
	});

	it("only reports, run as npm run status runs it, cutting nothing over", () => {
		listSessionIn(tmp);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("NOT-CUT-OVER");
		expect(upstream()).toBe("refs/heads/landing");
	});

	it("skips while another run holds the cutover's lock, cutting nothing over", () => {
		listSessionIn(tmp);
		const holder = spawn("sh", ["-c", "sleep 60", "cutover-main-checkout.js"], {
			stdio: "ignore",
		});
		try {
			fs.writeFileSync(
				path.join(main, ".git", "wfc-cutover.pid"),
				`${holder.pid}\n`,
			);
			const r = check();
			expect(r.stderr).toContain("NOT-CUT-OVER");
			expect(check("--notify").stdout).toBe("");
			expect(upstream()).toBe("refs/heads/landing");
		} finally {
			holder.kill();
		}
	});

	it("is BROKEN where git cannot read the mark", () => {
		const gitConfig = path.join(main, ".git", "config");
		fs.chmodSync(gitConfig, 0o000);
		const r = check();
		fs.chmodSync(gitConfig, 0o644);
		expect(r.stderr).toContain("BROKEN");
		expect(r.stderr).toContain(
			"git could not read whether the main checkout is cut over",
		);
	});

	it("passes a cut-over main checkout and prints nothing at SessionStart", () => {
		git(main, "branch", "--unset-upstream", "main");
		expect(check().stderr).toContain("OK:");
		expect(check("--notify").stdout).toBe("");
	});

	it("is listed in npm run status", () => {
		const status = fs.readFileSync(
			path.join(__dirname, "status-report.js"),
			"utf8",
		);
		expect(status).toContain(
			'["main-checkout-cutover", "check-main-checkout-cutover.js"]',
		);
	});
});
