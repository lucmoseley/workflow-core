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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubGhScript } from "./lib/gh-stub.js";
import { remoteGit } from "./lib/lander.js";
import { isDead, waitFor } from "./lib/process-fixture.js";
import { runInProcessAsync } from "./lib/run-in-process.js";
import { shellQuote } from "./lib/sh-quote.js";

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
		`#!/bin/sh\ncp ${shellQuote(`${markers()}/.lander-heartbeat.json`)} ${shellQuote(`${tmp}/heartbeat-seen.json`)}\nprintf '%s' ${shellQuote(failing)}\nexit ${code}\n`,
	);
	fs.chmodSync(script, 0o755);
	return script;
};

/** A tester red on `scripts/<name>.test.ts` while `<name>.txt` is in the tree. */
const stubRedWhile = (name: string, alongside?: string) => {
	const script = path.join(tmp, "tester.sh");
	fs.writeFileSync(
		script,
		`#!/bin/sh\nif git cat-file -e "$1:"${shellQuote(`${name}.txt`)} 2>/dev/null${alongside ? ` && git cat-file -e "$1:"${shellQuote(`${alongside}.txt`)} 2>/dev/null` : ""}; then echo ${shellQuote(`scripts/${name}.test.ts`)}; exit 1; fi\nexit 0\n`,
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
	return runInProcessAsync(LANDER, ["run", "--tester", shellQuote(tester)], {
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
	const tester = stubRedWhile("broken");
	const created = path.join(tmp, "created.txt");
	const gh = stubGhScript(
		tmp,
		`#!/bin/sh
case "$*" in
  *"issue list"*) echo '[]' ;;
  *labels*) echo '[[{"name":"takes:implement"},{"name":"kind:ticket"}]]' ;;
  *"issue create"*) cat > ${shellQuote(created)}; echo https://github.com/o/here/issues/7 ;;
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

/**
 * A tracker of issues held in a JSON file, served by a gh stub, with the
 * config naming it.
 */
const stubTracker = () => {
	const store = path.join(tmp, "issues.json");
	const refuseReland = path.join(tmp, "refuse-reland");
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
	if (flag("--title").startsWith("Re-land") && fs.existsSync(${JSON.stringify(refuseReland)})) {
		process.stderr.write("gh down\\n");
		process.exit(1);
	}
	const all = read();
	const number = 100 + all.length;
	const labels = a.flatMap((w, i) => (w === "--label" ? [{ name: a[i + 1] }] : []));
	all.push({ number, title: flag("--title"), state: "OPEN", labels, body: fs.readFileSync(0, "utf8") });
	write(all);
	out("https://github.com/o/here/issues/" + number + "\\n");
} else if (is("issue", "view")) {
	const issue = read().find((i) => String(i.number) === a[2]);
	out(a.includes("--jq") ? issue.body : { body: issue.body });
} else if (is("issue", "close")) {
	const all = read();
	const issue = all.find((i) => String(i.number) === a[2]);
	issue.state = "CLOSED";
	issue.closing = flag("--comment");
	write(all);
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
	const readStore = () => JSON.parse(fs.readFileSync(store, "utf8"));
	return { store, refuseReland, gh, readStore };
};

it("files one held-queue issue over two holds in a row, urgent and bug, refreshing its body to the second batch and re-adding a label taken off (#2694)", async () => {
	const { store, gh, readStore } = stubTracker();
	const tester = stubTester(1, "scripts/x.test.ts");

	const first = commit("first");
	git(work, "push", "-q", "origin", "HEAD:landing");
	const r1 = await runLander(tester, "landing", gh.env);
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

it("closes the held-queue issue once a later run lands past its batch, naming the sha it landed, over a gate a session wrote on it (#3636)", async () => {
	const { store, gh, readStore } = stubTracker();
	commit("bad");
	git(work, "push", "-q", "origin", "HEAD:landing");
	const held = await runLander(
		stubTester(1, "scripts/x.test.ts"),
		"landing",
		gh.env,
	);
	const gated = readStore();
	gated[0].body += "\n**Gated on:** b lands — check: true\n";
	fs.writeFileSync(store, JSON.stringify(gated));
	const fix = commit("fix");
	git(work, "push", "-q", "origin", "HEAD:landing");

	const moved = await runLander(stubTester(0), "landing", gh.env);

	expect(held.status, held.stderr).toBe(0);
	expect(moved.status, moved.stderr).toBe(0);
	expect(git(remote, "rev-parse", "main")).toBe(fix);
	const [issue] = readStore();
	expect(issue.state).toBe("CLOSED");
	expect(issue.closing).toContain(fix);
	expect(moved.stdout).toContain(`held-queue issue: closed #${issue.number}.`);
});

it("files on a later run the fix ticket a run failed to file, across the heartbeat, then lands the revert and closes the held-queue issue (#3777)", async () => {
	const { refuseReland, gh, readStore } = stubTracker();
	fs.writeFileSync(refuseReland, "");
	const middle = commit("broken");
	git(work, "push", "-q", "origin", "HEAD:landing");
	const tester = stubRedWhile("broken");

	const held = await runLander(tester, "landing", gh.env);

	expect(held.status, held.stderr).toBe(0);
	const reverted = git(remote, "rev-parse", "landing");
	expect(git(remote, "rev-parse", "main")).not.toBe(reverted);
	const heartbeat = () =>
		JSON.parse(
			fs.readFileSync(path.join(markers(), ".lander-heartbeat.json"), "utf8"),
		);
	expect(heartbeat().owed).toMatchObject([
		{ culprit: middle, revert: reverted },
	]);
	expect(readStore().map((i: { title: string }) => i.title)).toEqual([
		"Landing queue held: the lander cannot clear a batch",
	]);

	fs.rmSync(refuseReland);
	const later = await runLander(tester, "landing", gh.env);

	expect(later.status, later.stderr).toBe(0);
	expect(git(remote, "rev-parse", "main")).toBe(reverted);
	expect(heartbeat().owed).toBeUndefined();
	const [queue, ticket] = readStore();
	expect(queue.state).toBe("CLOSED");
	expect(ticket.title).toMatch(/^Re-land /);
	expect(ticket.state).toBe("OPEN");
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

/** A commit on `landing` to revert, with `body` as prepare-commit-msg. */
const culpritWithCommitHook = (body: string) => {
	const culprit = commit("bad");
	git(work, "push", "-q", "origin", "HEAD:landing");
	const hooks = path.join(tmp, "hooks");
	fs.mkdirSync(hooks);
	fs.writeFileSync(
		path.join(hooks, "prepare-commit-msg"),
		`#!/bin/sh\n${body}\n`,
	);
	fs.chmodSync(path.join(hooks, "prepare-commit-msg"), 0o755);
	git(work, "config", "core.hooksPath", hooks);
	return culprit;
};

it("fails a revert whose commit prepare-commit-msg refuses, naming the gate's verdict and pushing nothing (#3123)", () => {
	const culprit = culpritWithCommitHook(
		"echo '> workflow-core@0.1.0 check:staged' >&2\necho 'FAIL: 1 fault(s) this commit adds' >&2\nexit 1",
	);

	const made = remoteGit(work).revertOnLanding(culprit, null, "why");

	expect(made).toEqual({
		failed: "its commit was refused: FAIL: 1 fault(s) this commit adds",
	});
	expect(git(remote, "rev-parse", "landing")).toBe(culprit);
});

it("fails a revert whose commit is killed at its timeout as timed out, not refused, naming what it last printed and pushing nothing (#3913)", () => {
	const culprit = culpritWithCommitHook(
		"echo '> workflow-core@0.1.0 check:staged' >&2\necho 'second gate running' >&2\nexec sleep 10",
	);

	/* Crosses the real clock: only a real kill gives git's error its ETIMEDOUT
	 * and the stderr up to the kill. Untraced: 3 s is room for git to reach the
	 * hook's two lines, and the sleep need only outlast it. */
	const made = remoteGit(work, 3000).revertOnLanding(culprit, null, "why");

	expect(made).toEqual({
		failed:
			"its commit timed out after 3 s, last printing: second gate running",
	});
	expect(git(remote, "rev-parse", "landing")).toBe(culprit);
});

it("kills the hook's child with a commit killed at its timeout, keeps the reason and takes the worktree off (#3916)", () => {
	const pidFile = path.join(tmp, "child-pid");
	const culprit = culpritWithCommitHook(
		`(while :; do touch still-writing; sleep 0.1; done) >/dev/null 2>&1 &\necho $! > ${shellQuote(pidFile)}\necho 'second gate running' >&2\nwait`,
	);

	/* Crosses the real clock: what is pinned is a real kill of a real process
	 * tree. Untraced: 3 s is room for git to start the hook and its child. */
	const made = remoteGit(work, 3000).revertOnLanding(culprit, null, "why");

	expect(made).toEqual({
		failed:
			"its commit timed out after 3 s, last printing: second gate running",
	});
	const child = Number(fs.readFileSync(pidFile, "utf8"));
	expect(waitFor(() => isDead(child))).toBe(true);
	expect(git(work, "worktree", "list").split("\n")).toHaveLength(1);
});

it("lets a hook's trap clean up when its commit is killed at its timeout (#3923)", () => {
	const marker = path.join(tmp, "gate-temp");
	fs.writeFileSync(marker, "");
	const culprit = culpritWithCommitHook(
		`trap ${shellQuote(`rm -f ${shellQuote(marker)}`)} EXIT\ntrap 'exit 143' TERM\nsleep 60`,
	);

	/* Crosses the real clock: what is pinned is a real signal to a real hook.
	 * Untraced: 3 s is room for git to start the hook and the hook its traps. */
	remoteGit(work, 3000).revertOnLanding(culprit, null, "why");

	expect(fs.existsSync(marker)).toBe(false);
});

it("keeps the failure's reason and says so where the revert's worktree will not come off (#3913)", () => {
	const named = path.join(tmp, "worktree-path");
	const culprit = culpritWithCommitHook(
		`git rev-parse --show-toplevel > ${shellQuote(named)}\ngit worktree lock "$(cat ${shellQuote(named)})"\necho 'FAIL: 1 fault(s) this commit adds' >&2\nexit 1`,
	);
	const writeSync = fs.writeSync;
	let printed = "";
	const spied = vi.spyOn(fs, "writeSync").mockImplementation(((
		fd: number,
		data: Buffer,
		...rest: []
	) => {
		if (fd !== 2) return writeSync(fd, data, ...rest);
		printed += data.toString();
		return data.length;
	}) as typeof fs.writeSync);

	const made = remoteGit(work).revertOnLanding(culprit, null, "why");

	const dir = fs.readFileSync(named, "utf8").trim();
	spied.mockRestore();
	git(work, "worktree", "remove", "--force", "--force", dir);
	expect(made).toEqual({
		failed: "its commit was refused: FAIL: 1 fault(s) this commit adds",
	});
	expect(printed).toContain(
		`lander: could not remove the revert's worktree ${dir}`,
	);
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

it("reads a merge's other side from where it forks, and none for a plain commit or a parent the merge lacks (#3631)", () => {
	const { l, s, merge, tip } = reconcileMerge();
	const seed = git(work, "rev-parse", `${s}^`);

	expect(remoteGit(work).mergedSide(merge, l)).toEqual({
		base: seed,
		range: [s],
		merges: [],
	});
	expect(remoteGit(work).mergedSide(tip, merge)).toBeNull();
	expect(remoteGit(work).mergedSide(merge, tip)).toBeNull();
});

it("reads a side that reconciled with landing past its merges, stopping at what the parent holds (#3932)", () => {
	const seed = git(work, "rev-parse", "HEAD");
	const l1 = commit("l1");
	const l2 = commit("l2");
	git(work, "checkout", "-q", "--detach", seed);
	const red = commit("red");
	git(work, "merge", "-q", "--no-edit", l1);
	const inner = git(work, "rev-parse", "HEAD");
	const last = commit("last");
	git(work, "merge", "-q", "--no-edit", l2);
	const merge = git(work, "rev-parse", "HEAD");

	expect(remoteGit(work).mergedSide(merge, l2)).toEqual({
		base: seed,
		range: [red, inner, last],
		merges: [inner],
	});
});

it("reads a merge on a side down its other parent, leaving out what the bisected parent holds, and none where that is everything (#3936)", () => {
	const seed = git(work, "rev-parse", "HEAD");
	const held = commit("held");
	git(work, "checkout", "-q", "--detach", seed);
	const first = commit("first");
	git(work, "merge", "-q", "--no-edit", held);
	const adds = git(work, "rev-parse", "HEAD");
	git(work, "checkout", "-q", "--detach", first);
	const brought = commit("brought");
	git(work, "merge", "-q", "--no-edit", adds);
	const inner = git(work, "rev-parse", "HEAD");

	expect(remoteGit(work).mergedSide(inner, brought, held)).toEqual({
		base: first,
		range: [adds],
		merges: [adds],
	});
	expect(remoteGit(work).mergedSide(adds, first, held)).toBeNull();
});

describe("a culprit merge whose own revert conflicts (#3932)", () => {
	const editShared = (line: string) => {
		fs.writeFileSync(path.join(work, "shared.txt"), `${line}\n`);
		return commit(line);
	};

	/**
	 * `main` on `m`, and on `landing` a merge of `side` into `m` with a tip
	 * editing a file the side added, so reverting the merge conflicts.
	 */
	const pushMergeOf = (side: string, m: string) => {
		git(work, "checkout", "-q", "--detach", m);
		git(work, "merge", "-q", "--no-edit", side);
		const merge = git(work, "rev-parse", "HEAD");
		const tip = editShared("tip");
		git(work, "push", "-q", "origin", `${m}:main`, `${tip}:landing`);
		return { merge, tip };
	};

	const expectRedRevertedAndLanded = () => {
		const landed = git(remote, "rev-parse", "main");
		expect(git(remote, "rev-parse", "landing")).toBe(landed);
		expect(git(remote, "log", "-1", "--format=%s", landed)).toBe(
			'Revert "red"',
		);
		const files = git(remote, "ls-tree", "--name-only", landed).split("\n");
		expect(files).not.toContain("red.txt");
		expect(files).toContain("shared.txt");
	};

	it("reverts the side commit behind the side's own reconcile merge, and lands the batch", async () => {
		const seed = git(work, "rev-parse", "HEAD");
		const m = commit("m");
		git(work, "checkout", "-q", "--detach", seed);
		const red = commit("red");
		editShared("side");
		git(work, "merge", "-q", "--no-edit", m);
		const side = git(work, "rev-parse", "HEAD");
		const { merge } = pushMergeOf(side, m);
		expect(remoteGit(work).revertOnLanding(merge, m, "why")).toEqual({
			failed: expect.stringContaining("(conflicts in shared.txt)"),
		});

		const { gh } = stubTracker();
		const r = await runLander(stubRedWhile("red"), "landing", gh.env);

		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toContain(`revert ${red} on landing`);
		expectRedRevertedAndLanded();
	});

	it("reverts the commit a merge on the side brought in, and lands the batch (#3936)", async () => {
		const seed = git(work, "rev-parse", "HEAD");
		const m = commit("m");
		git(work, "checkout", "-q", "--detach", seed);
		const red = commit("red");
		git(work, "checkout", "-q", "--detach", seed);
		editShared("side");
		git(work, "merge", "-q", "--no-edit", red);
		const side = git(work, "rev-parse", "HEAD");
		const { merge } = pushMergeOf(side, m);
		expect(remoteGit(work).revertOnLanding(merge, m, "why")).toEqual({
			failed: expect.stringContaining("(conflicts in shared.txt)"),
		});

		const { gh } = stubTracker();
		const r = await runLander(stubRedWhile("red"), "landing", gh.env);

		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toContain(`revert ${red} on landing`);
		expectRedRevertedAndLanded();
	});

	it("holds, naming the conflict and the merge the search ended at, where a merge on the side adds nothing the bisected parent lacks (#3936)", async () => {
		const seed = git(work, "rev-parse", "HEAD");
		const m = commit("m");
		const main = commit("main");
		git(work, "checkout", "-q", "--detach", seed);
		editShared("side");
		git(work, "merge", "-q", "--no-edit", m);
		const side = git(work, "rev-parse", "HEAD");
		const { merge, tip } = pushMergeOf(side, main);

		const { gh } = stubTracker();
		const r = await runLander(stubRedWhile("m", "side"), "landing", gh.env);

		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toContain(
			`the revert of ${merge.slice(0, 9)} did not land`,
		);
		expect(r.stdout).toContain("(conflicts in shared.txt)");
		expect(r.stdout).toContain(
			`no commit on its merged side to revert instead: its first red commit ${side.slice(0, 9)} is itself a merge with nothing further to search`,
		);
		expect(git(remote, "rev-parse", "landing")).toBe(tip);
		expect(git(remote, "rev-parse", "main")).toBe(main);
	});
});

describe("a culprit whose revert conflicts in an anchors file (#3935)", () => {
	const Anchors = "scripts/instruction-surface-anchors.json";
	const writeAnchors = (row: string, far: string) => {
		fs.mkdirSync(path.join(work, "scripts"), { recursive: true });
		fs.writeFileSync(
			path.join(work, Anchors),
			`${JSON.stringify({ row, b: 0, c: 0, d: 0, e: 0, f: 0, far }, null, "\t")}\n`,
		);
	};

	/**
	 * `main` on `m`, and on `landing` a merge of a red side commit moving two
	 * far-apart rows, then `then` and a later commit moving the first row again,
	 * so that side commit's revert conflicts on the first row alone.
	 */
	const pushRedSide = (then?: () => void) => {
		writeAnchors("seed", "seed");
		fs.writeFileSync(path.join(work, "shared.txt"), "seed\n");
		const base = commit("base");
		const m = commit("m");
		git(work, "checkout", "-q", "--detach", base);
		writeAnchors("culprit", "culprit");
		fs.writeFileSync(path.join(work, "shared.txt"), "culprit\n");
		const red = commit("red");
		git(work, "checkout", "-q", "--detach", m);
		git(work, "merge", "-q", "--no-edit", red);
		writeAnchors("later", "culprit");
		then?.();
		const tip = commit("later");
		git(work, "push", "-q", "origin", `${m}:main`, `${tip}:landing`);
		return { m, red, tip };
	};

	it("reverts it and lands, each conflicted hunk keeping landing's side and the rest of the file reverted", async () => {
		const { red } = pushRedSide();
		const { gh } = stubTracker();
		const r = await runLander(stubRedWhile("red"), "landing", gh.env);

		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toContain(`revert ${red} on landing`);
		const landed = git(remote, "rev-parse", "main");
		expect(git(remote, "rev-parse", "landing")).toBe(landed);
		expect(git(remote, "log", "-1", "--format=%s", landed)).toBe(
			'Revert "red"',
		);
		expect(git(remote, "log", "-1", "--format=%b", landed)).toContain(
			`Conflicts in ${Anchors} kept this branch's side`,
		);
		const files = git(remote, "ls-tree", "--name-only", landed).split("\n");
		expect(files).not.toContain("red.txt");
		expect(git(remote, "show", `${landed}:shared.txt`)).toBe("seed");
		expect(
			JSON.parse(git(remote, "show", `${landed}:${Anchors}`)),
		).toMatchObject({ row: "later", far: "seed" });
	});

	it("holds, naming the files, where the revert conflicts in another file too", async () => {
		const { m, tip } = pushRedSide(() =>
			fs.writeFileSync(path.join(work, "shared.txt"), "later\n"),
		);
		const { gh } = stubTracker();
		const r = await runLander(stubRedWhile("red"), "landing", gh.env);

		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toContain(`(conflicts in ${Anchors}, shared.txt)`);
		expect(git(remote, "rev-parse", "landing")).toBe(tip);
		expect(git(remote, "rev-parse", "main")).toBe(m);
	});

	it("fails, naming the file, where the culprit touched only the anchors file, as keeping its hunks reverts nothing", () => {
		writeAnchors("seed", "seed");
		commit("base");
		writeAnchors("culprit", "seed");
		git(work, "commit", "-qam", "only anchors");
		const culprit = git(work, "rev-parse", "HEAD");
		writeAnchors("later", "seed");
		git(work, "commit", "-qam", "later");
		const tip = git(work, "rev-parse", "HEAD");
		git(work, "push", "-q", "origin", `${tip}:landing`);

		expect(remoteGit(work).revertOnLanding(culprit, null, "why")).toEqual({
			failed: expect.stringContaining(`(conflicts in ${Anchors})`),
		});
		expect(git(remote, "rev-parse", "landing")).toBe(tip);
	});
});

it("reverts a merge culprit against the parent the bisect stepped from, undoing the session's side (#2996)", () => {
	const { l, merge } = reconcileMerge();

	const made = remoteGit(work).revertOnLanding(merge, l, "why");

	if (!("sha" in made)) throw new Error(made.failed);
	const files = git(remote, "ls-tree", "--name-only", made.sha).split("\n");
	expect(files).toContain("l.txt");
	expect(files).not.toContain("s.txt");
});
