// @vitest-environment node
/*
 * scripts/start-lander-on-push.sh (#2405): which pushes start the lander, and
 * that the hook returns before the lander's start does. A stub `node` ahead on
 * PATH stands in for start-lander.js: it waits for a gate file, then records
 * its launch; any other node call goes to the real one.
 *
 * Loosen it and a push to `landing` sits untested until some later session
 * starts, or a push elsewhere starts a lander nobody asked for.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { mkScratchDir } from "./lib/git-fixture";
import { buildBashPayload, spawnGuard } from "./lib/pretool-guard-testkit";

const HOOK = path.resolve(__dirname, "start-lander-on-push.sh");
/* Guesses, each far above the hook's sub-second run: the hook's own ceiling,
 * and how long a detached launch is awaited on the real clock. */
const HOOK_TIMEOUT_MS = 20_000;
const LAUNCH_WAIT_MS = 10_000;
/* The stub's gate poll, which gives up after a minute: above any one case's
 * run, so only a stub stranded past its test reaches it (#2675). It also ends
 * once teardown removes `dir`. */
const STUB_POLL_S = 0.05;
const STUB_POLLS = 60 / STUB_POLL_S;

let dir: string;
let repo: string;
let stubs: string;
let gate: string;
let launches: string;

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: repo, encoding: "utf8" });

const run = (command: string, modules = "landing") =>
	spawnGuard(HOOK, buildBashPayload(command), {
		project: repo,
		config: path.join(dir, "config"),
		cwd: repo,
		env: { PATH: `${stubs}:${process.env.PATH}`, WFC_MODULES: modules },
		timeout: HOOK_TIMEOUT_MS,
	});

const recorded = () =>
	fs.existsSync(launches)
		? fs.readFileSync(launches, "utf8").split("\n").filter(Boolean)
		: [];

/* Crosses the real clock: the launch is a detached child, so its record is
 * awaited. */
const launchRecorded = async () => {
	for (
		let waited = 0;
		waited < LAUNCH_WAIT_MS && recorded().length === 0;
		waited += 50
	)
		await new Promise((resolve) => setTimeout(resolve, 50));
	return recorded();
};

beforeEach(() => {
	dir = mkScratchDir("start-lander-on-push-");
	repo = path.join(dir, "repo");
	stubs = path.join(dir, "stubs");
	gate = path.join(dir, "gate");
	launches = path.join(dir, "launches");
	fs.mkdirSync(stubs);
	fs.mkdirSync(path.join(dir, "config"));
	execFileSync("git", ["init", "-q", "-b", "main", repo]);
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
	fs.writeFileSync(
		path.join(stubs, "node"),
		`#!/bin/sh\ncase "$1" in\n  */start-lander.js)\n    i=0\n    while [ ! -e "${gate}" ] && [ -d "${dir}" ] && [ $i -lt ${STUB_POLLS} ]; do sleep ${STUB_POLL_S}; i=$((i+1)); done\n    [ -e "${gate}" ] && echo "$*" >> "${launches}" ;;\n  *) exec "${process.execPath}" "$@" ;;\nesac\n`,
	);
	fs.chmodSync(path.join(stubs, "node"), 0o755);
});

afterEach(() => {
	fs.writeFileSync(gate, "");
	fs.rmSync(dir, { recursive: true, force: true });
});

it.each([
	"git push origin HEAD:landing",
	"git push origin main:refs/heads/landing",
	"timeout 60 git push -q origin HEAD:landing",
])(
	"starts the lander after %s, returning before the start does",
	async (command) => {
		const r = run(command);

		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toBe("");
		expect(recorded()).toEqual([]);
		fs.writeFileSync(gate, "");
		const seen = await launchRecorded();
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatch(/\/scripts\/start-lander\.js$/);
	},
);

it("starts it from a bare push on a branch named landing", async () => {
	git("switch", "-q", "-c", "landing");
	fs.writeFileSync(gate, "");

	expect(run("git push").status).toBe(0);
	expect(await launchRecorded()).toHaveLength(1);
});

it("starts nothing after a push to another ref, a dry run, a deletion, --all, a mention or with the module off", async () => {
	fs.writeFileSync(gate, "");
	for (const command of [
		"git push origin main",
		"git push origin HEAD:spike/x",
		"git push --dry-run origin HEAD:landing",
		"git push origin --delete landing",
		"git push origin :landing",
		"git push --all origin",
		"echo git push origin HEAD:landing",
	])
		expect(run(command).status, command).toBe(0);
	expect(run("git push origin HEAD:landing", "suites").status).toBe(0);
	/* A control launch after them all: once its record lands, any launch the
	 * pushes above made has had its chance to land first. */
	expect(run("git push origin HEAD:landing").status).toBe(0);

	expect(await launchRecorded()).toHaveLength(1);
});
