// @vitest-environment node
/*
 * scripts/landing-push-gate.js and its .husky/pre-push limb (#2409).
 *
 * Each case runs the gate on a throwaway repo's ref list and ledger, and the
 * last two run .husky/pre-push itself through `sh`, as git does: one tests
 * the hook's wiring of the gate, the other that a push to `landing` meets no
 * coverage warning (#2929).
 *
 * Loosen it and a push from the founder's terminal or a script moves `main`
 * to a sha the full suite never passed; tighten it and the lander's own push
 * of a green batch is refused.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const ROOT = path.resolve(__dirname, "..");
const CHECK = path.join(ROOT, "scripts", "landing-push-gate.js");
const ZERO = "0".repeat(40);

let tmp: string;
let work: string;
let sha: string;

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: work, encoding: "utf8" }).trim();

const ledger = () =>
	path.join(work, ".claude", "tmp", "markers", ".landing-green-ledger");

const ledgerHolds = (held: string) => {
	fs.mkdirSync(path.dirname(ledger()), { recursive: true });
	fs.writeFileSync(ledger(), `${held} 2026-10-21T00:00:00.000Z\n`);
};

const buildRefLine = (local: string, remoteRef: string) =>
	`refs/heads/main ${local} ${remoteRef} ${ZERO}\n`;

const check = (stdin: string, modules = "landing") => {
	const env: NodeJS.ProcessEnv = { ...process.env, WFC_MODULES: modules };
	return runInProcess(CHECK, [], { cwd: work, env, stdin });
};

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "landing-push-"));
	work = path.join(tmp, "work");
	fs.mkdirSync(work);
	git("init", "-q", "-b", "main");
	git(
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
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	sha = git("rev-parse", "HEAD");
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("with the landing module on", () => {
	it("passes a push to main of a sha the green ledger holds", () => {
		ledgerHolds(sha);
		const r = check(buildRefLine(sha, "refs/heads/main"));
		expect(r.status, r.stderr).toBe(0);
	});

	it("refuses a push to main of any other sha, naming it and the landing route", () => {
		ledgerHolds("f".repeat(40));
		const r = check(buildRefLine(sha, "refs/heads/main"));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(sha);
		expect(r.stderr).toContain("git push origin main:landing");
	});

	it("refuses a push to main where the lander has ledgered nothing", () => {
		const r = check(buildRefLine(sha, "refs/heads/main"));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(sha);
		expect(r.stderr).toContain("git push origin main:landing");
	});

	it("refuses a deletion of main, a ledgered sha git cannot resolve beside it", () => {
		ledgerHolds(sha);
		fs.appendFileSync(ledger(), `${"e".repeat(40)} 2026-10-21T00:00:00.000Z\n`);
		const r = check(buildRefLine(ZERO, "refs/heads/main"));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(ZERO);
		expect(r.stderr).toContain("git push origin main:landing");
	});

	it("passes a push to landing of an unledgered sha", () => {
		expect(check(buildRefLine(sha, "refs/heads/landing")).status).toBe(0);
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
		expect(r.stderr).toContain("git push origin main:landing");
	});
});

it("passes a push to main of an unledgered sha with the landing module off", () => {
	const r = check(buildRefLine(sha, "refs/heads/main"), "suites");
	expect(r.status, r.stderr).toBe(0);
	expect(r.stderr).toBe("");
});

const hook = (stdin: string, modules = "landing") =>
	spawnSync("sh", [path.join(ROOT, ".husky", "pre-push")], {
		cwd: work,
		input: stdin,
		encoding: "utf8",
		env: { ...process.env, WFC_MODULES: modules, WFC_PLUGIN_ROOT: ROOT },
	});

it("makes .husky/pre-push refuse an unledgered push to main and pass a ledgered one", () => {
	const refused = hook(buildRefLine(sha, "refs/heads/main"));
	expect(refused.status).toBe(1);
	expect(refused.stderr).toContain("git push origin main:landing");
	ledgerHolds(sha);
	const r = hook(buildRefLine(sha, "refs/heads/main"));
	expect(r.status, r.stderr).toBe(0);
});

it("makes .husky/pre-push pass a push to landing with no coverage warning, suites on (#2929)", () => {
	const r = hook(buildRefLine(sha, "refs/heads/landing"), "suites,landing");
	expect(r.status, r.stderr).toBe(0);
	expect(r.stderr).not.toContain("CERTIFICATE:");
	expect(r.stderr).toContain('SKIP: module "landing" is on');
});
