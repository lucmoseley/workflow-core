// @vitest-environment node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { cutWorktree, defineTemplate, mkScratchDir } from "./lib/git-fixture";
import { buildBashPayload, spawnGuard } from "./lib/pretool-guard-testkit";
import { shellQuote } from "./lib/sh-quote.js";

const HOOK = path.resolve(__dirname, "start-lander-on-push.js");
// guess: far above the hook's sub-second run, #2405
const HOOK_TIMEOUT_MS = 20_000;
const LAUNCH_WAIT_MS = 10_000;
// guess, #2675
const STUB_POLL_S = 0.05;
const STUB_POLLS = 60 / STUB_POLL_S;

let dir: string;
let repo: string;
let stubs: string;
let gate: string;
let launches: string;

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: repo, encoding: "utf8" });

const run = (command: string) =>
	spawnGuard(HOOK, buildBashPayload(command), {
		project: repo,
		config: path.join(dir, "config"),
		cwd: repo,
		env: { PATH: `${stubs}:${process.env.PATH}`, WFC_MODULES: "" },
		timeout: HOOK_TIMEOUT_MS,
	});

const readLaunches = () =>
	fs.existsSync(launches)
		? fs.readFileSync(launches, "utf8").split("\n").filter(Boolean)
		: [];

const launchRecorded = async () => {
	for (
		let waited = 0;
		waited < LAUNCH_WAIT_MS && readLaunches().length === 0;
		waited += 50
	)
		await new Promise((resolve) => setTimeout(resolve, 50));
	return readLaunches();
};

const template = defineTemplate((at) => {
	execFileSync("git", ["init", "-q", "-b", "main", at]);
	execFileSync(
		"git",
		[
			"-c",
			"user.email=t@t",
			"-c",
			"user.name=t",
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			"seed",
		],
		{ cwd: at },
	);
});

beforeEach(() => {
	dir = mkScratchDir("start-lander-on-push-");
	repo = path.join(dir, "repo");
	stubs = path.join(dir, "stubs");
	gate = path.join(dir, "gate");
	launches = path.join(dir, "launches");
	fs.mkdirSync(stubs);
	fs.mkdirSync(path.join(dir, "config"));
	template.instantiate(repo);
	fs.writeFileSync(
		path.join(stubs, "node"),
		`#!/bin/sh\ncase "$1" in\n  */start-lander.js)\n    i=0\n    while [ ! -e ${shellQuote(gate)} ] && [ -d ${shellQuote(dir)} ] && [ $i -lt ${STUB_POLLS} ]; do sleep ${STUB_POLL_S}; i=$((i+1)); done\n    [ -e ${shellQuote(gate)} ] && echo "$*" >> ${shellQuote(launches)} ;;\n  *) exec ${shellQuote(process.execPath)} "$@" ;;\nesac\n`,
	);
	fs.chmodSync(path.join(stubs, "node"), 0o755);
});

afterEach(() => {
	fs.writeFileSync(gate, "");
	fs.rmSync(dir, { recursive: true, force: true });
});

it.each([
	"git push origin HEAD:queue/q1",
	"timeout 60 git push -q origin HEAD:refs/heads/queue/q1",
])(
	"starts the lander after %s, returning before the start does",
	async (command) => {
		const r = run(command);

		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toBe("");
		expect(readLaunches()).toEqual([]);
		fs.writeFileSync(gate, "");
		const seen = await launchRecorded();
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatch(/\/scripts\/start-lander\.js$/);
	},
);

it("starts it from a bare push on a branch named for a queue ref", async () => {
	git("switch", "-q", "-c", "queue/q1");
	fs.writeFileSync(gate, "");

	expect(run("git push").status).toBe(0);
	expect(await launchRecorded()).toHaveLength(1);
});

it("starts nothing after a push to another ref or a dry run", async () => {
	fs.writeFileSync(gate, "");
	for (const command of [
		"git push origin main",
		"git push origin HEAD:landing",
		"git push --dry-run origin HEAD:queue/q1",
	])
		expect(run(command).status, command).toBe(0);
	expect(run("git push origin HEAD:queue/q1").status).toBe(0);

	expect(await launchRecorded()).toHaveLength(1);
});

it("reads a bare push's branch in the payload's linked worktree, not the main checkout it runs from (#4271, #4695)", async () => {
	const wt = cutWorktree(repo);
	execFileSync("git", ["switch", "-q", "-c", "queue/q1"], { cwd: wt });
	fs.writeFileSync(gate, "");

	const r = spawnGuard(
		HOOK,
		{ ...buildBashPayload("git push"), cwd: wt },
		{
			project: repo,
			config: path.join(dir, "config"),
			cwd: repo,
			env: { PATH: `${stubs}:${process.env.PATH}`, WFC_MODULES: "" },
			timeout: HOOK_TIMEOUT_MS,
		},
	);

	expect(r.status, r.stderr).toBe(0);
	expect(await launchRecorded()).toHaveLength(1);
});
