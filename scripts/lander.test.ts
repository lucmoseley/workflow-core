// @vitest-environment node
/*
 * scripts/lander.js end to end (#2402, #2404).
 *
 * Loosen it and a lander run can leave `main` behind a green `landing`, move
 * `main` backwards, run with no heartbeat for the stall check to read, or let
 * one red commit hold back the green ones around it.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { stubGhScript } from "./lib/gh-stub.js";
import { remoteGit } from "./lib/lander.js";
import { runInProcessAsync } from "./lib/run-in-process.js";

const LANDER = path.resolve(__dirname, "../scripts/lander.js");

let tmp: string;
let work: string;
let remote: string;

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const commit = (message: string) => {
	fs.writeFileSync(path.join(work, `${message}.txt`), message);
	git(work, "add", "-A");
	git(
		work,
		"-c",
		"user.email=t@t",
		"-c",
		"user.name=t",
		"commit",
		"-qm",
		message,
	);
	return git(work, "rev-parse", "HEAD");
};

const markers = () => path.join(work, ".claude", "tmp", "markers");

/**
 * A tester that copies the heartbeat as it stood mid-run, prints `failing`,
 * then exits `code`.
 */
const stubTester = (code: number, failing = "") => {
	const script = path.join(tmp, "tester.sh");
	fs.writeFileSync(
		script,
		`#!/bin/sh\ncp "${markers()}/.lander-heartbeat.json" "${tmp}/heartbeat-seen.json"\nprintf '%s' '${failing}'\nexit ${code}\n`,
	);
	fs.chmodSync(script, 0o755);
	return script;
};

const runLander = (
	tester: string,
	modules = "landing",
	extraEnv: Record<string, string> = {},
) => {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		WFC_MODULES: modules,
		CLAUDE_PROJECT_DIR: work,
		...extraEnv,
	};
	delete env.CLAUDE_CODE_SESSION_ID;
	return runInProcessAsync(LANDER, ["run", "--tester", tester], {
		cwd: work,
		env,
	});
};

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lander-"));
	remote = path.join(tmp, "remote.git");
	work = path.join(tmp, "work");
	git(tmp, "init", "-q", "--bare", "-b", "main", remote);
	git(tmp, "clone", "-q", remote, work);
	git(work, "config", "user.email", "t@t");
	git(work, "config", "user.name", "t");
	commit("seed");
	git(work, "push", "-q", "origin", "HEAD:main", "HEAD:landing");
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

it("lands a commit pushed to landing on main in one run, beating while the tester runs", async () => {
	const sha = commit("work");
	git(work, "push", "-q", "origin", "HEAD:landing");

	const r = await runLander(stubTester(0));

	expect(r.status, r.stderr).toBe(0);
	expect(git(remote, "rev-parse", "main")).toBe(sha);
	expect(
		JSON.parse(fs.readFileSync(path.join(tmp, "heartbeat-seen.json"), "utf8")),
	).toMatchObject({ batch: sha });
	expect(
		fs.readFileSync(path.join(markers(), ".landing-green-ledger"), "utf8"),
	).toMatch(new RegExp(`^${sha} `, "m"));
	expect(fs.existsSync(path.join(markers(), ".lander.pid"))).toBe(false);
});

it("lands the green first of three commits, reverts the red middle one on landing and lands the third with the revert", async () => {
	const first = commit("first");
	const middle = commit("broken");
	const third = commit("third");
	git(work, "push", "-q", "origin", "HEAD:landing");
	const tester = path.join(tmp, "tester.sh");
	fs.writeFileSync(
		tester,
		`#!/bin/sh\nif git cat-file -e "$1:broken.txt" 2>/dev/null; then echo scripts/broken.test.ts; exit 1; fi\nexit 0\n`,
	);
	fs.chmodSync(tester, 0o755);
	const created = path.join(tmp, "created.txt");
	const gh = stubGhScript(
		tmp,
		`#!/bin/sh
case "$*" in
  *"issue list"*) echo '[]' ;;
  *labels*) echo '[[{"name":"takes:implement"},{"name":"kind:ticket"}]]' ;;
  *"issue create"*) cat > "${created}"; echo https://github.com/o/here/issues/7 ;;
  *) echo '[]' ;;
esac
`,
	);
	fs.mkdirSync(path.join(work, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(work, ".claude", "workflow-core.json"),
		JSON.stringify({ tracker: "o/here" }),
	);

	const r = await runLander(tester, "landing", gh.env);

	expect(r.status, r.stderr).toBe(0);
	const lines = r.stdout.split("\n");
	const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
	expect(at(`fast-forward ${first}`)).toBeGreaterThan(-1);
	expect(at(`fast-forward ${first}`)).toBeLessThan(at(`revert ${middle}`));
	const reverted = git(remote, "rev-parse", "landing");
	expect(git(remote, "rev-parse", `${reverted}^`)).toBe(third);
	expect(git(remote, "log", "-1", "--format=%s", reverted)).toBe(
		'Revert "broken"',
	);
	expect(git(remote, "rev-parse", "main")).toBe(reverted);
	const body = fs.readFileSync(created, "utf8");
	expect(body).toContain(`reverted it in ${reverted}`);
	expect(body).toContain("- `scripts/broken.test.ts`");
	expect(body).toContain("Standalone:");
});

it("holds without a bisect, moving nothing, where the failing files are red on main too (#3324)", async () => {
	const seed = git(remote, "rev-parse", "main");
	const sha = commit("work");
	git(work, "push", "-q", "origin", "HEAD:landing");

	const r = await runLander(stubTester(1, "scripts/x.test.ts"));

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).toContain(`rerun ${seed} (base): scripts/x.test.ts`);
	expect(r.stdout).toContain("hold already red on `main`: scripts/x.test.ts");
	expect(r.stdout).not.toContain("bisect");
	expect(git(remote, "rev-parse", "main")).toBe(seed);
	expect(git(remote, "rev-parse", "landing")).toBe(sha);
});

it("never moves main back to a landing it has passed", async () => {
	const ahead = commit("straight-to-main");
	git(work, "push", "-q", "origin", "HEAD:main");

	const r = await runLander(stubTester(0));

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).toContain("exit landing is behind main");
	expect(git(remote, "rev-parse", "main")).toBe(ahead);
});

it("does nothing with the landing module off", async () => {
	const seed = git(remote, "rev-parse", "main");
	commit("work");
	git(work, "push", "-q", "origin", "HEAD:landing");

	const r = await runLander(stubTester(0), "suites");

	expect(r.status).toBe(0);
	expect(r.stdout).toContain('SKIP: module "landing" is off');
	expect(git(remote, "rev-parse", "main")).toBe(seed);
});

it("files one held-queue issue over two holds in a row, urgent and bug, refreshing its body to the second batch and re-adding a label taken off (#2694)", async () => {
	const store = path.join(tmp, "issues.json");
	fs.writeFileSync(store, "[]");
	const gh = stubGhScript(
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
	out([[{ name: "urgent" }, { name: "bug" }, { name: "takes:implement" }, { name: "kind:ticket" }]]);
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
	);
	fs.mkdirSync(path.join(work, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(work, ".claude", "workflow-core.json"),
		JSON.stringify({ tracker: "o/here" }),
	);
	const tester = stubTester(1, "scripts/x.test.ts");

	const first = commit("first");
	git(work, "push", "-q", "origin", "HEAD:landing");
	const r1 = await runLander(tester, "landing", gh.env);
	const readStore = () => JSON.parse(fs.readFileSync(store, "utf8"));
	const readLabelNames = () =>
		readStore()[0].labels.map((l: { name: string }) => l.name);
	expect(readLabelNames()).toEqual([
		"urgent",
		"bug",
		"takes:implement",
		"kind:ticket",
	]);
	const filed = readStore();
	filed[0].labels = filed[0].labels.filter(
		(l: { name: string }) => l.name !== "urgent",
	);
	fs.writeFileSync(store, JSON.stringify(filed));
	const second = commit("second");
	git(work, "push", "-q", "origin", "HEAD:landing");
	const r2 = await runLander(tester, "landing", gh.env);

	expect(r1.status, r1.stderr).toBe(0);
	expect(r2.status, r2.stderr).toBe(0);
	const issues = readStore();
	expect(issues).toHaveLength(1);
	expect(issues[0].body).toContain(`Batch: \`${second}\``);
	expect(issues[0].body).not.toContain(first);
	expect(issues[0].body).toContain("- `scripts/x.test.ts`");
	expect(r2.stdout).toContain(
		"held-queue issue: Refreshed #100. Re-added urgent.",
	);
	expect(readLabelNames()).toContain("urgent");
	expect(
		JSON.parse(
			fs.readFileSync(path.join(markers(), ".lander-heartbeat.json"), "utf8"),
		),
	).toMatchObject({
		batch: second,
		hold: {
			landing: second,
			filed: "held-queue issue: Refreshed #100. Re-added urgent.",
		},
	});
});

it("takes a revert already on landing as landed rather than reverting twice, reading the rows it left stale, as a retried push finds one (#2673, #3127)", () => {
	const culprit = commit("bad");
	git(work, "push", "-q", "origin", "HEAD:landing");
	git(work, "revert", "--no-edit", culprit);
	const revert = git(work, "rev-parse", "HEAD");
	git(work, "push", "-q", "origin", "HEAD:landing");

	const made = remoteGit(work).revertOnLanding(culprit, null, "why");

	expect(made).toEqual({ sha: revert, onto: culprit, stale: [] });
	expect(git(remote, "rev-parse", "landing")).toBe(revert);
});

it("fails a revert whose commit prepare-commit-msg refuses, naming the gate's verdict and pushing nothing (#3123)", () => {
	const culprit = commit("bad");
	git(work, "push", "-q", "origin", "HEAD:landing");
	const hooks = path.join(tmp, "hooks");
	fs.mkdirSync(hooks);
	fs.writeFileSync(
		path.join(hooks, "prepare-commit-msg"),
		"#!/bin/sh\necho '> workflow-core@0.1.0 check:staged' >&2\necho 'FAIL: 1 fault(s) this commit adds' >&2\nexit 1\n",
	);
	fs.chmodSync(path.join(hooks, "prepare-commit-msg"), 0o755);
	git(work, "config", "core.hooksPath", hooks);

	const made = remoteGit(work).revertOnLanding(culprit, null, "why");

	expect(made).toEqual({
		failed: "its commit was refused: FAIL: 1 fault(s) this commit adds",
	});
	expect(git(remote, "rev-parse", "landing")).toBe(culprit);
});

/**
 * A reconcile merge pushed to landing: the session's side `s` as its first
 * parent, `l` (which main holds) as its second, then `tip` on top.
 */
const reconcileMerge = () => {
	const seed = git(work, "rev-parse", "HEAD");
	const l = commit("l");
	git(work, "push", "-q", "origin", "HEAD:main", "HEAD:landing");
	git(work, "checkout", "-q", "--detach", seed);
	const s = commit("s");
	git(work, "merge", "-q", "--no-edit", l);
	const merge = git(work, "rev-parse", "HEAD");
	const tip = commit("tip");
	git(work, "push", "-q", "origin", "HEAD:landing");
	return { l, s, merge, tip };
};

it("bisects a reconcile merge's range along the parent main precedes, never the session's side (#2996)", () => {
	const { l, s, merge, tip } = reconcileMerge();

	const chain = remoteGit(work).chain(l, tip);

	expect(chain).toEqual([merge, tip]);
	expect(chain).not.toContain(s);
});

it("bisects a range with no main along first parents from the root (#2996)", () => {
	const { l, s, merge, tip } = reconcileMerge();

	const chain = remoteGit(work).chain(null, tip);

	expect(chain.slice(-3)).toEqual([s, merge, tip]);
	expect(chain).not.toContain(l);
});

it("refuses a range whose base the tip does not descend from (#2996)", () => {
	const { l, tip } = reconcileMerge();
	git(work, "checkout", "-q", "--detach", l);
	const other = commit("other");

	expect(() => remoteGit(work).chain(other, tip)).toThrow(
		"does not descend from",
	);
});

it("reverts a merge culprit against the parent the bisect stepped from, undoing the session's side (#2996)", () => {
	const { l, merge } = reconcileMerge();

	const made = remoteGit(work).revertOnLanding(merge, l, "why");

	if (!("sha" in made)) throw new Error(made.failed);
	const files = git(remote, "ls-tree", "--name-only", made.sha).split("\n");
	expect(files).toContain("l.txt");
	expect(files).not.toContain("s.txt");
});
