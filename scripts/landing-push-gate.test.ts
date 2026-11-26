// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineTemplate } from "./lib/git-fixture";
import { gitTrimmedIn } from "./lib/repo-tree-testkit";
import { runInProcess } from "./lib/run-in-process.js";

const ROOT = path.resolve(__dirname, "..");
const CHECK = path.join(ROOT, "scripts", "landing-push-gate.js");
const ZERO = "0".repeat(40);

let tmp: string;
let work: string;
let sha: string;

const git = (...args: string[]) => gitTrimmedIn(work, ...args);

const seeded = defineTemplate((root) => {
	gitTrimmedIn(root, "init", "-q", "-b", "main");
	gitTrimmedIn(
		root,
		"-c",
		"user.email=t@t",
		"-c",
		"user.name=t",
		"commit",
		"-q",
		"--allow-empty",
		"-m",
		"seed",
	);
	gitTrimmedIn(root, "config", "user.email", "t@t");
	gitTrimmedIn(root, "config", "user.name", "t");
});

const ledger = () =>
	path.join(work, ".claude", "tmp", "markers", ".landing-green-ledger");

const ledgerHolds = (held: string) => {
	fs.mkdirSync(path.dirname(ledger()), { recursive: true });
	fs.writeFileSync(ledger(), `${held} 2026-10-21T00:00:00.000Z\n`);
};

const REMOTE_TIP = "a".repeat(40);

const buildRefLine = (local: string, remoteRef: string, remote = REMOTE_TIP) =>
	`refs/heads/main ${local} ${remoteRef} ${remote}\n`;

const check = (stdin: string) =>
	runInProcess(CHECK, [], { cwd: work, env: process.env, stdin });

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "landing-push-"));
	work = seeded.instantiate(path.join(tmp, "work"));
	sha = git("rev-parse", "HEAD");
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("the gate", () => {
	it("passes a push to main of a sha the green ledger holds", () => {
		ledgerHolds(sha);
		const r = check(buildRefLine(sha, "refs/heads/main"));
		expect(r.status, r.stderr).toBe(0);
	});

	it("refuses a push to main of any other sha, naming it and the queue ref route", () => {
		ledgerHolds("f".repeat(40));
		const r = check(buildRefLine(sha, "refs/heads/main"));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(sha);
		expect(r.stderr).toContain("Push your session's queue ref instead");
		expect(r.stderr).toContain("session-checkout.js land");
	});

	it("refuses a push to main where the lander has ledgered nothing", () => {
		const r = check(buildRefLine(sha, "refs/heads/main"));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(sha);
		expect(r.stderr).toContain("session-checkout.js land");
	});

	it("refuses a deletion of main, a ledgered sha git cannot resolve beside it", () => {
		ledgerHolds(sha);
		fs.appendFileSync(ledger(), `${"e".repeat(40)} 2026-10-21T00:00:00.000Z\n`);
		const r = check(buildRefLine(ZERO, "refs/heads/main"));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(ZERO);
		expect(r.stderr).toContain("session-checkout.js land");
	});

	it("refuses a push to main where the green ledger will not read, naming the fault (#4856)", () => {
		fs.mkdirSync(ledger(), { recursive: true });
		const r = check(buildRefLine(sha, "refs/heads/main"));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("green ledger");
		expect(r.stderr).toContain("EISDIR");
	});

	it("passes a push creating main on a remote that has none: a new repo's first push (#2412)", () => {
		const r = check(buildRefLine(sha, "refs/heads/main", ZERO));
		expect(r.status, r.stderr).toBe(0);
	});

	it("passes a push to a queue ref of an unledgered sha", () => {
		expect(check(buildRefLine(sha, "refs/heads/queue/s1")).status).toBe(0);
	});

	it("passes a push to main of an unledgered root whose tree a ledgered sha holds (#1954)", () => {
		ledgerHolds(sha);
		const root = git("commit-tree", "HEAD^{tree}", "-m", "squashed root");
		const r = check(buildRefLine(root, "refs/heads/main"));
		expect(r.status, r.stderr).toBe(0);
	});

	it("refuses a push to main of an unledgered sha whose tree no ledgered sha holds (#1954)", () => {
		ledgerHolds(sha);
		fs.writeFileSync(path.join(work, "f"), "changed\n");
		git("add", "f");
		const tree = git("write-tree");
		const other = git("commit-tree", tree, "-m", "untested tree");
		const r = check(buildRefLine(other, "refs/heads/main"));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(other);
		expect(r.stderr).toContain("session-checkout.js land");
	});
});

const hook = (stdin: string) =>
	spawnSync("sh", [path.join(ROOT, ".husky", "pre-push")], {
		cwd: work,
		input: stdin,
		encoding: "utf8",
		env: { ...process.env, WFC_MODULES: "", WFC_PLUGIN_ROOT: ROOT },
	});

it("makes .husky/pre-push refuse an unledgered push to main and pass a ledgered one", () => {
	const refused = hook(buildRefLine(sha, "refs/heads/main"));
	expect(refused.status).toBe(1);
	expect(refused.stderr).toContain("session-checkout.js land");
	ledgerHolds(sha);
	const r = hook(buildRefLine(sha, "refs/heads/main"));
	expect(r.status, r.stderr).toBe(0);
});

it("makes .husky/pre-push pass a push to a queue ref with no coverage warning (#2929)", () => {
	const r = hook(buildRefLine(sha, "refs/heads/queue/s1"));
	expect(r.status, r.stderr).toBe(0);
	expect(r.stderr).not.toContain("CERTIFICATE:");
});
