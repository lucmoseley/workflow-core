// @vitest-environment node
/*
 * scripts/queue-lander.js end to end, and lib/queue-lander-adapters.js's git
 * and files, against lib/lander-testkit.ts's real bare remote and clone
 * (#4485, spec #4458).
 *
 * Loosen it and two queue refs no longer land as one merged batch or in the
 * order they were pushed, a lone ref gains a merge commit, an anchors file
 * both refs touched stops the batch though its driver settles it, a ref
 * pushed while its batch was tested is deleted unlanded, a broken git object
 * is read again unrepaired, a live queue lander's lock is taken by a
 * second one or its launcher, a verdict, batch or drop written to disk is lost to the
 * next run, or a ref conflicting with `main` stops the queue, goes unkept
 * under `dropped/<name>` or unticketed; or a red batch's culprit is not
 * isolated on `lander/iso-<k>` and dropped with its evidence, a collision is
 * not settled by serial landing, or a failure `main` shares holds the batch
 * on a local tester or goes without its base-red ticket, or a push `main`
 * refuses reads as a fault or one `main` moved under reads as a refusal.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	commit,
	git,
	landerSandbox,
	markers,
	remote,
	runLander,
	stubRedWhile,
	stubTester,
	stubTracker,
	tmp,
	work,
} from "./lib/lander-testkit";
import { redPathAtRest } from "./lib/queue-lander.js";
import {
	batchRecord,
	dropRecord,
	queueGit,
	queueLogger,
	verdictLedger,
} from "./lib/queue-lander-adapters.js";
import { logEnqueue, queueLogFile } from "./lib/queue-log.js";
import { runInProcess } from "./lib/run-in-process.js";
import { shellQuote } from "./lib/sh-quote.js";

landerSandbox();

// Required, not imported: an ESM import of lib/queue-lander.js would load a
// second copy of TransientFault, which queueGit's throw is not.
const { TransientFault } = createRequire(__filename)("./lib/queue-lander.js");

const START_LANDER = path.resolve(__dirname, "start-lander.js");
const ANCHORS = ".claude/guard-registry-anchors.json";

/** A commit on `from`, after `write` where given, pushed as `queue/<name>`, returning its sha. */
const pushQueue = (name: string, from: string, write?: () => void) => {
	git(work, "checkout", "-q", "--detach", from);
	write?.();
	const sha = commit(name);
	git(work, "push", "-q", "origin", `${sha}:refs/heads/queue/${name}`);
	return sha;
};

/** A commit on `from` with committer time `date`, pushed as `queue/<name>`. */
const pushQueueAt = (name: string, from: string, date: string) => {
	git(work, "checkout", "-q", "--detach", from);
	fs.writeFileSync(path.join(work, `${name}.txt`), name);
	git(work, "add", "-A");
	execFileSync(
		"git",
		["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", name],
		{ cwd: work, env: { ...process.env, GIT_COMMITTER_DATE: date } },
	);
	const sha = git(work, "rev-parse", "HEAD");
	git(work, "push", "-q", "origin", `${sha}:refs/heads/queue/${name}`);
	return sha;
};

const remoteHeads = () =>
	git(remote, "for-each-ref", "--format=%(refname)", "refs/heads/");

describe("a run", () => {
	it("lands two queue refs onto main as one merged batch, ledgers it green and deletes both refs", async () => {
		const seed = git(work, "rev-parse", "HEAD");
		const a = pushQueue("a", seed);
		const b = pushQueue("b", seed);

		const r = await runLander(stubTester(0));

		expect(r.status).toBe(0);
		expect(r.stdout).toContain("exit no queue ref waits");
		const main = git(remote, "rev-parse", "main");
		expect(git(remote, "rev-list", "--count", `${seed}..${main}`)).toBe("4");
		expect(git(remote, "merge-base", "--is-ancestor", a, main)).toBe("");
		expect(git(remote, "merge-base", "--is-ancestor", b, main)).toBe("");
		expect(
			git(remote, "rev-list", "--first-parent", `${seed}..${main}`).split("\n"),
		).toHaveLength(2);
		expect(remoteHeads()).not.toContain("refs/heads/queue/");
		expect(git(remote, "rev-parse", "lander/batch")).toBe(main);
		expect(
			fs.readFileSync(path.join(markers(), ".landing-green-ledger"), "utf8"),
		).toContain(main);
	});

	it("lands a lone queue ref that descends from main as pushed, with no merge commit", async () => {
		const a = pushQueue("a", git(work, "rev-parse", "HEAD"));

		const r = await runLander(stubTester(0));

		expect(r.status).toBe(0);
		expect(git(remote, "rev-parse", "main")).toBe(a);
	});

	it("merges refs in the order the queue log says they were pushed, not by their committer times", async () => {
		const seed = git(work, "rev-parse", "HEAD");
		const a = pushQueueAt("a", seed, "2026-11-02T00:00:00Z");
		const b = pushQueueAt("b", seed, "2026-11-01T00:00:00Z");
		fs.mkdirSync(markers(), { recursive: true });
		const log = queueLogFile(work);
		const at = Date.now();
		logEnqueue(log, { ref: "refs/heads/queue/a", sha: a, at: at - 2000 });
		logEnqueue(log, { ref: "refs/heads/queue/b", sha: b, at: at - 1000 });

		const r = await runLander(stubTester(0));

		expect(r.stdout).toContain("exit no queue ref waits");
		const merges = git(
			remote,
			"log",
			"--first-parent",
			"--format=%s",
			`${seed}..main`,
		).split("\n");
		expect(merges[0]).toMatch(/^Merge queue\/b /);
		expect(merges[1]).toMatch(/^Merge queue\/a /);
	});

	it("lands a lone ref that descends from a main that moved since its batch was taken, with no merge commit", async () => {
		const seed = git(work, "rev-parse", "HEAD");
		const moved = commit("moved");
		git(work, "push", "-q", "origin", `${moved}:main`);
		const a = pushQueue("a", moved);
		fs.mkdirSync(markers(), { recursive: true });
		batchRecord(path.join(markers(), ".queue-lander-batch.json")).write({
			members: [{ name: "a", sha: a, pushedAt: 1 }],
			deferred: [],
			dropped: [],
			onto: seed,
			integration: a,
			phase: "testing",
			...redPathAtRest(),
		});

		const r = await runLander(stubTester(0));

		expect(r.stdout).toContain(`merge-members onto ${moved.slice(0, 9)}`);
		expect(git(remote, "rev-parse", "main")).toBe(a);
	});

	it("settles a conflict in the anchors file with the registry merge driver and lands both refs", async () => {
		const seed = git(work, "rev-parse", "HEAD");
		fs.mkdirSync(path.join(work, ".claude"), { recursive: true });
		const writeANCHORS = (rows: Record<string, string>) =>
			fs.writeFileSync(
				path.join(work, ANCHORS),
				`${JSON.stringify(rows, null, "\t")}\n`,
			);
		writeANCHORS({ "x.js": "0000" });
		const base = commit("anchors");
		git(work, "push", "-q", "origin", `${base}:main`);
		fs.writeFileSync(
			path.join(work, ".git", "info", "attributes"),
			`${ANCHORS} merge=registry-anchors\n`,
		);
		git(
			work,
			"config",
			"merge.registry-anchors.driver",
			`node ${shellQuote(path.resolve(__dirname, "merge-registry-anchors.js"))} %O %A %B`,
		);
		pushQueue("a", base, () =>
			writeANCHORS({ "a.js": "aaaa", "x.js": "0000" }),
		);
		pushQueue("b", base, () =>
			writeANCHORS({ "b.js": "bbbb", "x.js": "0000" }),
		);
		expect(seed).not.toBe(base);

		const r = await runLander(stubTester(0));

		expect(r.stdout).toContain("exit no queue ref waits");
		const main = git(remote, "rev-parse", "main");
		expect(JSON.parse(git(remote, "show", `${main}:${ANCHORS}`))).toEqual({
			"a.js": "aaaa",
			"b.js": "bbbb",
			"x.js": "0000",
		});
	});

	it("drops a ref conflicting with main to dropped/<name>, files its fix ticket and lands the other, logging each", async () => {
		const seed = git(work, "rev-parse", "HEAD");
		const shared = path.join(work, "shared.txt");
		fs.writeFileSync(shared, "main\n");
		const main = commit("main");
		git(work, "push", "-q", "origin", `${main}:main`);
		const a = pushQueue("a", seed, () => fs.writeFileSync(shared, "a\n"));
		const b = pushQueue("b", seed);
		fs.mkdirSync(markers(), { recursive: true });
		const log = queueLogFile(work);
		const at = Date.now();
		logEnqueue(log, { ref: "refs/heads/queue/a", sha: a, at: at - 2000 });
		logEnqueue(log, { ref: "refs/heads/queue/b", sha: b, at: at - 1000 });
		const { gh, readStore } = stubTracker();

		const r = await runLander(stubTester(0), "landing", gh.env);

		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toContain(
			`drop-member queue/a@${a.slice(0, 9)} as dropped/a`,
		);
		expect(r.stdout).toContain("exit no queue ref waits");
		expect(git(remote, "rev-parse", "dropped/a")).toBe(a);
		expect(remoteHeads()).not.toContain("refs/heads/queue/");
		const landed = git(remote, "rev-parse", "main");
		expect(git(remote, "merge-base", "--is-ancestor", b, landed)).toBe("");
		expect(
			spawnSync("git", ["merge-base", "--is-ancestor", a, landed], {
				cwd: remote,
			}).status,
		).toBe(1);
		const [ticket] = readStore();
		expect(ticket.title).toBe(
			`Fix queue/a at ${a.slice(0, 9)}, dropped by the queue lander: a`,
		);
		expect(ticket.labels.map((l: { name: string }) => l.name)).toEqual(
			expect.arrayContaining(["takes:implement", "kind:ticket"]),
		);
		expect(ticket.body).toContain(a);
		expect(ticket.body).toContain("- `shared.txt`");
		expect(ticket.body).toContain("`dropped/a`");
		const drops = dropRecord(
			path.join(markers(), ".queue-lander-drops.json"),
		).read();
		expect(drops.map((d) => [d.ref, d.ticket])).toEqual([
			["dropped/a", ticket.number],
		]);
		const rows = fs
			.readFileSync(log, "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l))
			.filter((row) => row.event !== "enqueue")
			.map((row) => `${row.event} ${row.ref.slice("refs/heads/".length)}`);
		expect(rows).toEqual([
			"take queue/a",
			"take queue/b",
			"drop queue/a",
			"land queue/b",
		]);
	});

	it("lands a batch red only where main is red too, filing the base-red ticket and ledgering each run by its pass", async () => {
		const seed = git(work, "rev-parse", "HEAD");
		pushQueue("a", seed);
		pushQueue("b", seed);
		const { gh, readStore } = stubTracker();

		const r = await runLander(
			stubTester(1, "scripts/x.test.ts\n"),
			"landing",
			gh.env,
		);

		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toContain(`file-base-red main@${seed.slice(0, 9)}`);
		const main = git(remote, "rev-parse", "main");
		expect(git(remote, "rev-list", "--count", `${seed}..${main}`)).toBe("4");
		const [ticket] = readStore();
		expect(ticket.title).toBe(
			"`main` is red: failures the queue lander blames on no member",
		);
		expect(ticket.body).toContain(`- Main: \`${seed}\``);
		const rows = fs
			.readFileSync(
				path.join(markers(), ".queue-lander-verdicts.jsonl"),
				"utf8",
			)
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(rows.map((row) => [row.sha, row.files, row.pass])).toEqual([
			[main, [], undefined],
			[main, ["scripts/x.test.ts"], 2],
			[seed, ["scripts/x.test.ts"], 0],
		]);
	});
});

describe("the adapters", () => {
	it("compare-and-deletes a queue ref only at the sha it was given, keeping one that moved", () => {
		const seed = git(work, "rev-parse", "HEAD");
		const a1 = pushQueue("a", seed);
		const a2 = commit("a2");
		git(work, "push", "-q", "origin", `${a2}:refs/heads/queue/a`);
		const g = queueGit(work);

		expect(g.deleteRef("queue/a", a1)).toBe(false);
		expect(git(remote, "rev-parse", "queue/a")).toBe(a2);
		expect(g.deleteRef("queue/a", a2)).toBe(true);
		expect(remoteHeads()).not.toContain("queue/a");
	});

	it("returns the remote's refusal of a push to main, as a ruleset's, and throws on a main that moved under it", () => {
		const seed = git(work, "rev-parse", "HEAD");
		const a = commit("a");
		const hook = path.join(remote, "hooks", "pre-receive");
		fs.writeFileSync(
			hook,
			"#!/bin/sh\necho 'GH013: rule violations' >&2\nexit 1\n",
			{
				mode: 0o755,
			},
		);
		const g = queueGit(work);

		expect(g.pushMain(a)).toMatch(/^! \[remote rejected\] .*main/);
		expect(git(remote, "rev-parse", "main")).toBe(seed);
		fs.rmSync(hook);
		const b = commit("b");
		expect(g.pushMain(b)).toBeNull();
		git(work, "checkout", "-q", "--detach", seed);
		const c = commit("c");
		expect(() => g.pushMain(c)).toThrow();
		expect(git(remote, "rev-parse", "main")).toBe(b);
	});

	it("throws on a push to main GitHub refused on its own internal fault, for the run to retry, rather than returning it as a refusal (#4497)", () => {
		const a = commit("a");
		const hook = path.join(work, ".git", "hooks", "pre-push");
		fs.writeFileSync(
			hook,
			"#!/bin/sh\necho ' ! [remote rejected] HEAD -> main (fatal error in commit_refs_rules)' >&2\nexit 1\n",
			{ mode: 0o755 },
		);

		expect(() => queueGit(work).pushMain(a)).toThrow(
			/fatal error in commit_refs_rules/,
		);
	});

	it("creates a dropped ref, takes it made already at the same sha, refuses it at another, and lists it", () => {
		const seed = git(work, "rev-parse", "HEAD");
		const a = commit("a");
		git(work, "push", "-q", "origin", `${a}:refs/heads/queue/a`);
		const g = queueGit(work);

		g.createRef("dropped/a", a);
		g.createRef("dropped/a", a);
		expect(() => g.createRef("dropped/a", seed)).toThrow(/stale info/);
		expect(git(remote, "rev-parse", "dropped/a")).toBe(a);
		expect(g.refs().dropped).toEqual([{ ref: "dropped/a", sha: a }]);
	});

	it("throws a merge that times out as a transient fault, for the run to retry, never a refusal that drops it", () => {
		const seed = git(work, "rev-parse", "HEAD");
		const a = pushQueue("a", seed);
		const b = pushQueue("b", seed);
		const g = queueGit(work, 1);
		g.refs();

		expect(() =>
			g.mergeMembers(seed, [
				{ name: "a", sha: a, pushedAt: 1 },
				{ name: "b", sha: b, pushedAt: 2 },
			]),
		).toThrow(TransientFault);
	});

	it("logs a land or drop row a crash repeats once, and a take row each time", () => {
		fs.mkdirSync(markers(), { recursive: true });
		const logQueue = queueLogger(work);
		const m = { name: "a", sha: "a1" };

		for (const event of [
			"take",
			"land",
			"land",
			"take",
			"drop",
			"drop",
		] as const)
			logQueue(event, m);

		const rows = fs
			.readFileSync(queueLogFile(work), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l).event);
		expect(rows).toEqual(["take", "land", "take", "drop"]);
	});

	it("lists each queue ref with its logged push time, its committer time where the log names none at its sha", () => {
		const seed = git(work, "rev-parse", "HEAD");
		const a = pushQueue("a", seed);
		const b = pushQueue("b", seed);
		const other = commit("other");
		git(work, "push", "-q", "origin", `${other}:main`);
		fs.mkdirSync(markers(), { recursive: true });
		const log = queueLogFile(work);
		const at = Date.now();
		logEnqueue(log, { ref: "refs/heads/queue/a", sha: a, at });
		logEnqueue(log, { ref: "refs/heads/queue/b", sha: a, at: at + 1000 });

		const { main, queue } = queueGit(work).refs();

		expect(main).toBe(other);
		expect(queue).toEqual([
			{ name: "a", sha: a, pushedAt: at },
			{
				name: "b",
				sha: b,
				pushedAt: Number(git(work, "log", "-1", "--format=%ct", b)) * 1000,
			},
		]);
	});

	it("removes an empty loose object and fetches it again, so the step's retry reads it whole", () => {
		const seed = git(work, "rev-parse", "HEAD");
		const elsewhere = path.join(tmp, "elsewhere");
		git(tmp, "clone", "-q", remote, elsewhere);
		fs.writeFileSync(path.join(elsewhere, "a.txt"), "a");
		git(elsewhere, "add", "-A");
		git(
			elsewhere,
			"-c",
			"user.email=t@t",
			"-c",
			"user.name=t",
			"commit",
			"-qm",
			"a",
		);
		const a = git(elsewhere, "rev-parse", "HEAD");
		git(elsewhere, "push", "-q", "origin", `${a}:refs/heads/queue/a`);
		const g = queueGit(work);
		g.refs();
		const object = path.join(
			work,
			".git",
			"objects",
			a.slice(0, 2),
			a.slice(2),
		);
		fs.chmodSync(object, 0o644);
		fs.writeFileSync(object, "");
		const member = { name: "a", sha: a, pushedAt: 1 };

		expect(() => g.mergeMembers(seed, [member])).toThrow(
			/^a broken git object, removed and fetched again: /,
		);

		expect(g.mergeMembers(seed, [member])).toEqual({ kind: "merged", sha: a });
	});

	it("reads back a verdict and a batch another instance wrote, and a torn record as none", () => {
		const verdicts = path.join(markers(), "v.jsonl");
		const batch = path.join(markers(), "b.json");
		fs.mkdirSync(markers(), { recursive: true });
		verdictLedger(verdicts).add("s1", ["b.ts", "a.ts"], {
			kind: "red",
			files: ["a.ts"],
		});
		verdictLedger(verdicts).add("s1", [], { kind: "green", run: 7 });
		verdictLedger(verdicts).add("s1", ["a.ts"], { kind: "green" }, 2);
		const noFile = {
			kind: "red" as const,
			files: [],
			jobs: ["Lint and types"],
		};
		verdictLedger(verdicts).add("s1", [], noFile, 0);
		const b = {
			members: [{ name: "a", sha: "s0", pushedAt: 1 }],
			deferred: ["b"],
			dropped: [],
			onto: "m0",
			integration: "s1",
			phase: "serial" as const,
			ahead: ["a"],
			blame: { files: ["a.ts"], base: [], members: ["a"] },
			isolated: [{ name: "a", sha: "s0", iso: "i0" }],
			serial: { landed: [], step: { name: "a", sha: "t0", onto: "m0" } },
			hold: {
				kind: "base" as const,
				main: "m0",
				files: ["a.ts"],
				ticket: 90,
			},
		};
		batchRecord(batch).write(b);

		expect(verdictLedger(verdicts).get("s1", ["a.ts", "b.ts"])).toEqual({
			kind: "red",
			files: ["a.ts"],
		});
		expect(verdictLedger(verdicts).get("s1", [])).toEqual({
			kind: "green",
			run: 7,
		});
		expect(verdictLedger(verdicts).get("s2", [])).toBeNull();
		expect(verdictLedger(verdicts).get("s1", ["a.ts"])).toBeNull();
		expect(verdictLedger(verdicts).get("s1", ["a.ts"], 2)).toEqual({
			kind: "green",
		});
		expect(verdictLedger(verdicts).get("s1", [], 0)).toEqual(noFile);
		expect(batchRecord(batch).read()).toEqual(b);
		fs.writeFileSync(batch, JSON.stringify({ ...b, phase: "parked" }));
		expect(batchRecord(batch).read()).toBeNull();
		fs.writeFileSync(
			batch,
			JSON.stringify({ ...b, hold: { kind: "refused", main: "m0" } }),
		);
		expect(batchRecord(batch).read()).toBeNull();
		fs.writeFileSync(batch, '{"members": [');
		expect(batchRecord(batch).read()).toBeNull();

		const drops = path.join(markers(), "d.json");
		const d = {
			name: "a",
			sha: "s0",
			ref: "dropped/a",
			onto: "m0",
			cause: { kind: "conflict" as const, name: "a", files: ["x.txt"] },
			ticket: null,
			at: 1,
		};
		const red = {
			...d,
			cause: { kind: "red" as const, name: "a", files: ["x.ts"], iso: "i0" },
		};
		const collision = {
			...d,
			cause: {
				kind: "collision" as const,
				name: "a",
				files: [],
				step: "t0",
				after: ["b"],
			},
		};
		dropRecord(drops).write([
			d,
			red,
			collision,
			{ ...d, ref: 3 } as never,
			{ ...red, cause: { ...red.cause, iso: 4 } } as never,
		]);
		expect(dropRecord(drops).read()).toEqual([d, red, collision]);
		fs.writeFileSync(drops, "[{");
		expect(dropRecord(drops).read()).toEqual([]);
	});
});

describe("the red path", () => {
	it("isolates each member on lander/iso-<k>, drops the one red alone twice with its fix ticket, and lands the other", async () => {
		const seed = git(work, "rev-parse", "HEAD");
		const a = pushQueue("a", seed);
		const b = pushQueue("b", seed);
		fs.mkdirSync(markers(), { recursive: true });
		const log = queueLogFile(work);
		const at = Date.now();
		logEnqueue(log, { ref: "refs/heads/queue/a", sha: a, at: at - 2000 });
		logEnqueue(log, { ref: "refs/heads/queue/b", sha: b, at: at - 1000 });
		const { gh, readStore } = stubTracker();

		const r = await runLander(stubRedWhile("b"), "landing", gh.env);

		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toContain("exit no queue ref waits");
		expect(git(remote, "rev-parse", "main")).toBe(a);
		expect(git(remote, "rev-parse", "dropped/b")).toBe(b);
		const iso = git(remote, "rev-parse", "lander/iso-1");
		expect(git(remote, "merge-base", "--is-ancestor", b, iso)).toBe("");
		const [ticket] = readStore();
		expect(ticket.title).toBe(
			`Fix queue/b at ${b.slice(0, 9)}, dropped by the queue lander: b`,
		);
		expect(ticket.body).toContain(`as ${iso}, it failed these files twice`);
		expect(ticket.body).toContain("- `scripts/b.test.ts`");
	});

	it("settles a collision by landing the members in push order, dropping the one whose step brings the failure back", async () => {
		const seed = git(work, "rev-parse", "HEAD");
		const a = pushQueue("a", seed);
		const b = pushQueue("b", seed);
		fs.mkdirSync(markers(), { recursive: true });
		const log = queueLogFile(work);
		const at = Date.now();
		logEnqueue(log, { ref: "refs/heads/queue/a", sha: a, at: at - 2000 });
		logEnqueue(log, { ref: "refs/heads/queue/b", sha: b, at: at - 1000 });
		const { gh, readStore } = stubTracker();

		const r = await runLander(stubRedWhile("b", "a"), "landing", gh.env);

		expect(r.status, r.stderr).toBe(0);
		expect(git(remote, "rev-parse", "main")).toBe(a);
		expect(git(remote, "rev-parse", "dropped/b")).toBe(b);
		expect(remoteHeads()).not.toContain("refs/heads/queue/");
		const [ticket] = readStore();
		expect(ticket.body).toContain("each member of its batch passed alone");
		expect(ticket.body).toContain("after `queue/a` landed");
	});
});

describe("the lock", () => {
	it("keeps a second queue lander and its launcher off while a live one holds the pidfile", async () => {
		const holder = spawn("sh", ["-c", "sleep 60", "queue-lander.js"], {
			stdio: "ignore",
		});
		try {
			fs.mkdirSync(markers(), { recursive: true });
			fs.writeFileSync(path.join(markers(), ".lander.pid"), `${holder.pid}\n`);

			const run = await runLander(stubTester(0));
			const start = runInProcess(START_LANDER, [], {
				cwd: work,
				env: {
					...process.env,
					WFC_MODULES: "landing",
					CLAUDE_PROJECT_DIR: work,
				},
			});

			expect(run.stdout).toContain("exit another lander holds the lock");
			expect(start.stdout).toContain(
				`SKIP: a lander is already running (pid ${holder.pid})`,
			);
		} finally {
			holder.kill();
		}
	});
});
