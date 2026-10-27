// @vitest-environment node
/*
 * scripts/supervise-landing.js end to end (#2692, ruled at #2672).
 *
 * Loosen it and a dead lander waits for the next push or session start, a
 * stalled queue sits unticketed while the founder is away, or every tick
 * files a second stall ticket.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { stubGhScript } from "./lib/gh-stub.js";
import { runInProcess } from "./lib/run-in-process.js";

const SUPERVISE = path.resolve(__dirname, "supervise-landing.js");
const MIN = 60 * 1000;
/* A guess: a lander run here takes well under a second. */
const WAIT_MS = 30_000;

let tmp: string;
let work: string;
let remote: string;
let store: string;
let ghEnv: NodeJS.ProcessEnv;

const git = (cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
	execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, ...env },
	}).trim();

/** A commit made `ago` ms back, pushed to each of `branches`. */
const commit = (name: string, ago: number, ...branches: string[]) => {
	fs.writeFileSync(path.join(work, name), name);
	git(work, ["add", "-A"]);
	git(work, ["commit", "-qm", name], {
		GIT_COMMITTER_DATE: new Date(Date.now() - ago).toISOString(),
	});
	for (const b of branches) git(work, ["push", "-q", "origin", `HEAD:${b}`]);
	return git(work, ["rev-parse", "HEAD"]);
};

const markers = () => path.join(work, ".claude", "tmp", "markers");

/** A heartbeat from `pid`, written now. */
const beat = (pid: number, extra: Record<string, unknown> = {}) => {
	fs.mkdirSync(markers(), { recursive: true });
	fs.writeFileSync(
		path.join(markers(), ".lander-heartbeat.json"),
		JSON.stringify({
			pid,
			at: new Date().toISOString(),
			batch: null,
			...extra,
		}),
	);
};

const supervise = (args: string[] = [], modules = "landing") =>
	runInProcess(SUPERVISE, args, {
		cwd: work,
		env: {
			...process.env,
			...ghEnv,
			WFC_MODULES: modules,
			CLAUDE_PROJECT_DIR: work,
			CLAUDE_CODE_SESSION_ID: "",
		},
	});

const readIssues = () => JSON.parse(fs.readFileSync(store, "utf8"));

/* Crosses the real clock: the lander is a detached process. */
const waitFor = async (done: () => boolean) => {
	for (let waited = 0; waited < WAIT_MS && !done(); waited += 100)
		await new Promise((resolve) => setTimeout(resolve, 100));
	return done();
};

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "supervise-landing-"));
	remote = path.join(tmp, "remote.git");
	work = path.join(tmp, "work");
	git(tmp, ["init", "-q", "--bare", "-b", "main", remote]);
	git(tmp, ["clone", "-q", remote, work]);
	git(work, ["config", "user.email", "t@t"]);
	git(work, ["config", "user.name", "t"]);
	fs.mkdirSync(path.join(work, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(work, ".claude", "workflow-core.json"),
		JSON.stringify({ tracker: "o/here" }),
	);
	git(work, ["add", "-A"]);
	store = path.join(tmp, "issues.json");
	fs.writeFileSync(store, "[]");
	ghEnv = stubGhScript(
		tmp,
		`#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
const read = () => JSON.parse(fs.readFileSync(${JSON.stringify(store)}, "utf8"));
const write = (all) => fs.writeFileSync(${JSON.stringify(store)}, JSON.stringify(all));
const out = (o) => process.stdout.write(typeof o === "string" ? o : JSON.stringify(o));
const flag = (name) => a[a.indexOf(name) + 1];
const is = (...words) => words.every((w, i) => a[i] === w);
if (is("issue", "list")) {
	const state = flag("--state");
	out(read().filter((i) => state === "all" || i.state === state.toUpperCase()));
} else if (is("api") && a[1].endsWith("/labels")) {
	out([["urgent", "bug", "takes:implement", "kind:ticket"].map((name) => ({ name }))]);
} else if (is("issue", "create")) {
	const all = read();
	const number = 100 + all.length;
	const labels = a.flatMap((w, i) => (w === "--label" ? [{ name: a[i + 1] }] : []));
	all.push({ number, title: flag("--title"), state: "OPEN", labels, body: fs.readFileSync(0, "utf8") });
	write(all);
	out("https://github.com/o/here/issues/" + number + "\\n");
} else if (is("issue", "view")) {
	const issue = read().find((i) => String(i.number) === a[2]);
	out(a.includes("--jq") ? issue.body : { body: issue.body });
} else if (is("issue", "edit")) {
	const all = read();
	const issue = all.find((i) => String(i.number) === a[2]);
	if (a.includes("--body-file")) issue.body = fs.readFileSync(flag("--body-file"), "utf8");
	a.forEach((w, i) => w === "--add-label" && issue.labels.push({ name: a[i + 1] }));
	write(all);
} else out("[]");
`,
	).env;
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

it("starts a lander where landing is ahead and none runs, naming the refill loop in the lander's log", async () => {
	commit("seed", 0, "main", "landing");
	const sha = commit("work", 0, "landing");
	const tester = path.join(tmp, "tester.sh");
	fs.writeFileSync(tester, "#!/bin/sh\nexit 0\n");
	fs.chmodSync(tester, 0o755);

	const r = supervise(["--tester", tester]);

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).toMatch(
		new RegExp(
			`^\\S+Z started the lander, testing ${sha.slice(0, 9)} \\(launched by the refill loop; pid \\d+\\); its output: `,
		),
	);
	expect(await waitFor(() => git(remote, ["rev-parse", "main"]) === sha)).toBe(
		true,
	);
	expect(
		fs.readFileSync(path.join(markers(), ".lander.log"), "utf8"),
	).toContain("launched by the refill loop");
	expect(readIssues()).toEqual([]);
});

it("files one urgent bug stall ticket for a running lander whose main has stood 2 h, and finds it current on the next pass", () => {
	commit("seed", 121 * MIN, "main", "landing");
	const tip = commit("work", MIN, "landing");
	beat(process.pid, {
		batch: tip,
		red: { sha: tip, files: ["scripts/x.test.ts"] },
	});

	const first = supervise();
	const second = supervise();

	expect(first.status, first.stderr).toBe(0);
	expect(first.stdout).toContain("Filed #100");
	expect(second.status, second.stderr).toBe(0);
	expect(second.stdout).toContain("stall ticket: #100 is open and current.\n");
	const [ticket, ...more] = readIssues();
	expect(more).toEqual([]);
	expect(ticket.title).toBe(
		"Landing queue stalled: main has not moved for 2 h",
	);
	expect(ticket.labels.map((l: { name: string }) => l.name)).toEqual([
		"urgent",
		"bug",
		"takes:implement",
		"kind:ticket",
	]);
	expect(ticket.body).toContain(`Batch under test: \`${tip}\``);
	expect(ticket.body).toContain("- `scripts/x.test.ts`");
	expect(ticket.body).toContain("Standalone:");
});

it("starts a dead lander and files the stall ticket too where main has stood 2 h", () => {
	commit("seed", 121 * MIN, "main", "landing");
	commit("work", MIN, "landing");
	const tester = path.join(tmp, "tester.sh");
	fs.writeFileSync(tester, "#!/bin/sh\nexit 2\n");
	fs.chmodSync(tester, 0o755);

	const r = supervise(["--tester", tester]);

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).toContain("started the lander");
	expect(r.stdout).toContain("Filed #100");
	expect(readIssues()).toHaveLength(1);
});

it("files nothing where a running lander moved main within 2 h", () => {
	commit("seed", 5 * 60 * MIN, "main", "landing");
	commit("work", MIN, "landing");
	beat(process.pid, {
		movedAt: new Date(Date.now() - 30 * MIN).toISOString(),
	});

	const r = supervise();

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).toBe("");
	expect(readIssues()).toEqual([]);
});

it("starts nothing and files nothing on a queue the last run held", () => {
	commit("seed", 121 * MIN, "main", "landing");
	const tip = commit("work", MIN, "landing");
	const gone = spawnSync("true").pid;
	beat(gone, { hold: { landing: tip, reason: "r", filed: "Filed #9" } });

	const r = supervise();

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).toBe("");
	expect(fs.existsSync(path.join(markers(), ".lander.pid"))).toBe(false);
	expect(readIssues()).toEqual([]);
});

it("does nothing with the landing module off", () => {
	commit("seed", 121 * MIN, "main", "landing");
	commit("work", MIN, "landing");

	const r = supervise([], "suites");

	expect(r.status).toBe(0);
	expect(r.stdout).toBe("");
	expect(fs.existsSync(path.join(markers(), ".lander.pid"))).toBe(false);
});
