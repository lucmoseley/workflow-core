// @vitest-environment node
/*
 * scripts/supervise-landing.js end to end (#2692, ruled at #2672; #4458).
 *
 * Loosen it and a dead queue lander waits for the next push or session
 * start, a stalled queue sits unticketed while the founder is away, or every
 * tick files a second stall ticket.
 */
import { execFileSync } from "node:child_process";
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
let runs: string;
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

/** The queue log holding one land row, `ago` ms back. */
const landedAgo = (ago: number) => {
	fs.mkdirSync(markers(), { recursive: true });
	fs.writeFileSync(
		path.join(markers(), ".queue-log.jsonl"),
		`${JSON.stringify({
			at: new Date(Date.now() - ago).toISOString(),
			event: "land",
			ref: "refs/heads/queue/earlier",
			sha: "c".repeat(40),
		})}\n`,
	);
};

/** A queue lander heartbeat from `pid`, written now. */
const beat = (pid: number, extra: Record<string, unknown> = {}) => {
	fs.mkdirSync(markers(), { recursive: true });
	fs.writeFileSync(
		path.join(markers(), ".queue-lander-heartbeat.json"),
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
			WFC_UPTIME_S: "86400",
			CLAUDE_PROJECT_DIR: work,
			CLAUDE_CODE_SESSION_ID: "",
		},
	});

const readIssues = () => JSON.parse(fs.readFileSync(store, "utf8"));

const STALL = "Landing queue stalled: main has not moved for 2 h";
const stallTickets = () =>
	readIssues().filter((i: { title: string }) => i.title === STALL);

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
	runs = path.join(tmp, "runs.json");
	fs.writeFileSync(runs, "[]");
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
	out([["urgent", "bug", "takes:implement", "kind:ticket", "origin:lander-script", "origin:ci-red"].map((name) => ({ name }))]);
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
} else if (is("issue", "close")) {
	const all = read();
	const issue = all.find((i) => String(i.number) === a[2]);
	issue.state = "CLOSED";
	issue.closeComment = flag("--comment");
	write(all);
} else if (is("run", "list")) {
	out(fs.readFileSync(${JSON.stringify(runs)}, "utf8"));
} else out("[]");
`,
	).env;
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

it("starts the queue lander where a queue ref waits and none runs, naming the refill loop in the lander's log", async () => {
	commit("seed", 0, "main");
	const sha = commit("work", 0, "refs/heads/queue/work");
	const tester = path.join(tmp, "tester.sh");
	fs.writeFileSync(tester, "#!/bin/sh\nexit 0\n");
	fs.chmodSync(tester, 0o755);

	const r = supervise(["--tester", tester]);

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).toMatch(
		/^\S+Z started the queue lander, 1 queue ref\(s\) waiting: queue\/work, 0 drop\(s\) owed a decision \(launched by the refill loop; pid \d+\); its output: /,
	);
	expect(await waitFor(() => git(remote, ["rev-parse", "main"]) === sha)).toBe(
		true,
	);
	expect(
		fs.readFileSync(path.join(markers(), ".lander.log"), "utf8"),
	).toContain("launched by the refill loop");
	expect(readIssues()).toEqual([]);
});

it("starts none, and prints nothing, while a lander runs or no queue ref waits", () => {
	commit("seed", 0, "main");
	expect(supervise(["--tester", "true"]).stdout).toBe("");
	commit("work", 0, "refs/heads/queue/work");
	beat(process.pid);

	const r = supervise(["--tester", "true"]);

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).toBe("");
	expect(fs.existsSync(path.join(markers(), ".lander.log"))).toBe(false);
});

it("files one urgent bug stall ticket for a running lander whose main has stood 2 h with a queue ref waiting, and finds it current on the next pass", () => {
	commit("seed", 8 * 60 * MIN, "main");
	const tip = commit("work", 121 * MIN, "refs/heads/queue/work");
	beat(process.pid, { batch: tip });

	const first = supervise();
	const second = supervise();

	expect(first.status, first.stderr).toBe(0);
	expect(first.stdout).toContain("Filed #100");
	expect(second.status, second.stderr).toBe(0);
	expect(second.stdout).toContain("stall ticket: #100 is open and current.\n");
	const [ticket, ...more] = stallTickets();
	expect(more).toEqual([]);
	expect(ticket.number).toBe(100);
	expect(ticket.labels.map((l: { name: string }) => l.name)).toEqual([
		"urgent",
		"bug",
		"takes:implement",
		"kind:ticket",
		"origin:lander-script",
	]);
	expect(ticket.body).toContain(`with \`queue/work at ${tip}\` waiting`);
	expect(ticket.body).toContain(`Batch under test: \`${tip}\``);
	expect(ticket.body).toContain("Standalone:");
});

it("closes the stall ticket with the stall's length once main moves, and files a new one for a later stall (#4443)", () => {
	commit("seed", 150 * MIN, "main");
	commit("work", 125 * MIN, "refs/heads/queue/work");
	beat(process.pid);
	expect(supervise().stdout).toContain("Filed #100");

	git(work, ["push", "-q", "origin", "HEAD:main", ":refs/heads/queue/work"]);
	landedAgo(0);
	const moved = supervise();

	expect(moved.status, moved.stderr).toBe(0);
	expect(moved.stdout).toContain("stall ticket: closed #100.\n");
	const [closed] = stallTickets();
	expect(closed.state).toBe("CLOSED");
	expect(closed.closeComment).toMatch(
		/^`main` moved to `[0-9a-f]{40}` at \S+, after standing 2 h 30 min since \S+\.$/,
	);
	expect(supervise().stdout).not.toContain("stall ticket");

	commit("more", 125 * MIN, "refs/heads/queue/more");
	landedAgo(121 * MIN);
	const again = supervise();
	expect(again.stdout).toContain("Filed #");
	expect(stallTickets().map((i: { state: string }) => i.state)).toEqual([
		"CLOSED",
		"OPEN",
	]);
});

it("closes the stall ticket on a move the queue log did not record, onto a commit older than the stall", () => {
	commit("seed", 150 * MIN, "main");
	commit("work", 200 * MIN, "refs/heads/queue/work");
	beat(process.pid);
	expect(supervise().stdout).toContain("Filed #100");

	git(work, ["push", "-q", "origin", "HEAD:main", ":refs/heads/queue/work"]);
	const moved = supervise();

	expect(moved.stdout).toContain("stall ticket: closed #100.\n");
	expect(stallTickets()[0].closeComment).toMatch(
		/^`main` moved to `[0-9a-f]{40}`, having stood since \S+\.$/,
	);
});

it("drops a torn stall record, saying so, and closes nothing", () => {
	fs.mkdirSync(markers(), { recursive: true });
	fs.writeFileSync(path.join(markers(), ".landing-stall-ticket.json"), "{");
	commit("seed", 5 * MIN, "main");

	const r = supervise();

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).toContain("would not parse and is dropped");
	expect(
		fs.existsSync(path.join(markers(), ".landing-stall-ticket.json")),
	).toBe(false);
	expect(readIssues()).toEqual([]);
});

it("starts the queue lander and files the stall ticket too where main has stood 2 h with no lander running", () => {
	commit("seed", 8 * 60 * MIN, "main");
	commit("work", 121 * MIN, "refs/heads/queue/work");
	const tester = path.join(tmp, "tester.sh");
	fs.writeFileSync(tester, "#!/bin/sh\nexit 2\n");
	fs.chmodSync(tester, 0o755);

	const r = supervise(["--tester", tester]);

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).toContain("started the queue lander");
	expect(stallTickets()).toHaveLength(1);
});

it("files nothing on a push onto a main idle for hours (#3303)", () => {
	commit("seed", 8 * 60 * MIN, "main");
	commit("work", MIN, "refs/heads/queue/work");
	beat(process.pid);

	const r = supervise();

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).toBe("");
	expect(readIssues()).toEqual([]);
});

it("files no stall ticket where the queue log has main landed within 2 h, though its tip is older", () => {
	commit("seed", 5 * 60 * MIN, "main");
	commit("work", 3 * 60 * MIN, "refs/heads/queue/work");
	beat(process.pid);
	landedAgo(30 * MIN);

	const r = supervise();

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).not.toContain("stall ticket");
	expect(stallTickets()).toEqual([]);
});

it("does nothing with the landing module off", () => {
	commit("seed", 8 * 60 * MIN, "main");
	commit("work", 121 * MIN, "refs/heads/queue/work");

	const r = supervise([], "suites");

	expect(r.status).toBe(0);
	expect(r.stdout).toBe("");
	expect(fs.existsSync(path.join(markers(), ".lander.log"))).toBe(false);
});

it("files the queue alert once for a queue ref waiting past 60 min, says nothing while it stands, and closes it once the ref leaves (#4485)", () => {
	commit("seed", 0, "main");
	commit("waiting", 61 * MIN, "refs/heads/queue/old");
	beat(process.pid);

	const first = supervise();
	const second = supervise();

	expect(first.status, first.stderr).toBe(0);
	expect(first.stdout).toContain("Filed #100");
	expect(second.status, second.stderr).toBe(0);
	expect(second.stdout).toBe("");
	const [alert, ...more] = readIssues();
	expect(more).toEqual([]);
	expect(alert.title).toBe(
		"Landing queue slow: a queue ref has waited past its limit",
	);
	expect(alert.body).toContain("queue/old has waited 1 h 1 min");

	git(work, ["push", "-q", "origin", ":refs/heads/queue/old"]);
	const gone = supervise();

	expect(gone.stdout).toBe("queue alert: closed #100.\n");
	expect(readIssues()[0].closeComment).toMatch(/^No queue ref waits at \S+\.$/);
});

it("fails the pass on a queue log it cannot read, naming it and filing nothing", () => {
	commit("seed", 8 * 60 * MIN, "main");
	commit("work", 121 * MIN, "refs/heads/queue/work");
	beat(process.pid);
	fs.mkdirSync(path.join(markers(), ".queue-log.jsonl"), { recursive: true });

	const r = supervise();

	expect(r.status).toBe(1);
	expect(r.stderr).toMatch(/EISDIR/);
	expect(readIssues()).toEqual([]);
});

it("files one urgent alarm ticket for two failed Landing quiet 14h runs at main's sha, and closes it, filing none, once main moves (#4772)", () => {
	const main = commit("seed", 15 * 60 * MIN, "main");
	const workflows = path.join(work, ".github", "workflows");
	fs.mkdirSync(workflows, { recursive: true });
	fs.writeFileSync(path.join(workflows, "landing-quiet.yml"), "");
	const failed = (id: number, headSha: string) => ({
		databaseId: id,
		conclusion: "failure",
		createdAt: new Date(Date.now() - (60 - id) * MIN).toISOString(),
		headSha,
	});
	fs.writeFileSync(runs, JSON.stringify([failed(1, main)]));
	const first = supervise();
	fs.writeFileSync(runs, JSON.stringify([failed(2, main), failed(1, main)]));
	const second = supervise();

	expect(first.status, first.stderr).toBe(0);
	expect(first.stdout).toContain("Filed #100");
	expect(second.status, second.stderr).toBe(0);
	const [ticket, ...more] = readIssues();
	expect(more).toEqual([]);
	expect(ticket.title).toBe(
		"Landing alarm red: an off-machine queue alarm failed since main last moved",
	);
	expect(ticket.labels.map((l: { name: string }) => l.name)).toContain(
		"urgent",
	);
	expect(ticket.body).toContain("- `Landing quiet 14h`: run 2, created ");
	expect(ticket.body).toContain("2 failed runs at this sha");

	const moved = commit("next", 0, "main");
	const after = supervise();

	expect(after.status, after.stderr).toBe(0);
	expect(after.stdout).toBe("alarm ticket: closed #100.\n");
	expect(readIssues()).toHaveLength(1);
	expect(readIssues()[0].closeComment).toBe(
		`\`main\` moved from \`${main}\` to \`${moved}\`.`,
	);
});

it("names an alarm read that fails and fails the pass, the queue's acts still made (#4772)", () => {
	commit("seed", 0, "main");
	const workflows = path.join(work, ".github", "workflows");
	fs.mkdirSync(workflows, { recursive: true });
	fs.writeFileSync(path.join(workflows, "main-lag.yml"), "");
	fs.writeFileSync(runs, "not json");

	const r = supervise();

	expect(r.status).toBe(1);
	expect(r.stdout).toMatch(/^queue alarms: not read: /);
	expect(readIssues()).toEqual([]);
});

it("drops a torn alarm record, saying so, and closes the open alarm ticket where no alarm fires (#4772)", () => {
	commit("seed", 0, "main");
	const workflows = path.join(work, ".github", "workflows");
	fs.mkdirSync(workflows, { recursive: true });
	fs.writeFileSync(path.join(workflows, "landing-quiet.yml"), "");
	fs.writeFileSync(
		store,
		JSON.stringify([
			{
				number: 100,
				title:
					"Landing alarm red: an off-machine queue alarm failed since main last moved",
				state: "OPEN",
				labels: [],
				body: "",
			},
		]),
	);
	fs.mkdirSync(markers(), { recursive: true });
	fs.writeFileSync(path.join(markers(), ".landing-alarm-ticket.json"), "{");

	const r = supervise();

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).toMatch(
		/would not parse and is dropped\.\nalarm ticket: closed #100\.\n$/,
	);
	expect(readIssues()[0].closeComment).toBe(
		"No queue alarm fires; its record had torn.",
	);
	expect(
		fs.existsSync(path.join(markers(), ".landing-alarm-ticket.json")),
	).toBe(false);
});
