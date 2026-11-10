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
 * under `dropped/<name>` or unticketed, or one a merge gate refuses is
 * ticketed with the gate's first line in place of its findings; or a red batch's culprit is not
 * isolated alone and dropped with its evidence, a collision is
 * not settled by serial landing, or a failure `main` shares holds the batch
 * on a local tester or goes without its base-red ticket, or a push `main`
 * refuses reads as a fault or one `main` moved under reads as a refusal.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	build,
	hooksWiring,
	ownClaims,
	region,
	removeTemps,
	reviewIn,
	run as runRegistry,
	SELF_PLUGIN_HOOKS,
} from "./lib/guard-registry-testkit";
import { dropRecord, pipelineRecord } from "./lib/lander-records.js";
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
	queueGit,
	queueLogger,
	refusedRecord,
	verdictLedger,
} from "./lib/queue-lander-adapters.js";
import { logEnqueue, queueLogFile } from "./lib/queue-log.js";
import { runInProcess } from "./lib/run-in-process.js";
import { shellQuote } from "./lib/sh-quote.js";

landerSandbox();
afterEach(removeTemps);

// Required, not imported: an ESM import would load a second copy of
// TransientFault or PushRefused, which queueGit's throw is not.
const { TransientFault } = createRequire(__filename)("./lib/queue-lander.js");
const { PushRefused } = createRequire(__filename)("./lib/network-fault.js");

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
		/* The command tester judges in place: no lander ref fires a run nobody
		 * reads (#4906). */
		expect(remoteHeads()).not.toContain("refs/heads/lander/");
		expect(
			fs.readFileSync(path.join(markers(), ".landing-green-ledger"), "utf8"),
		).toContain(main);
	});

	/**
	 * Stub hooks in the work repo's hooks directory, each logging its
	 * arguments; `preCommit` runs after pre-commit's log line.
	 */
	const stubHooks = (names: string[], preCommit = "") => {
		const hooks = path.resolve(
			work,
			git(work, "rev-parse", "--git-common-dir"),
			"hooks",
		);
		const log = path.join(hooks, "calls.log");
		fs.mkdirSync(hooks, { recursive: true });
		for (const hook of names)
			fs.writeFileSync(
				path.join(hooks, hook),
				`#!/bin/sh\necho "${hook} $*" >> '${log}'\n${hook === "pre-commit" ? preCommit : ""}`,
				{ mode: 0o755 },
			);
		return () => fs.readFileSync(log, "utf8").trim().split("\n");
	};

	/* Pre-commit's body on the batch pass alone, called with no argument. */
	const onBatchPass = (body: string) =>
		`case "$*" in --gates=*) ;; *) ${body} ;; esac\n`;

	it("runs the merge gate set on each member's merge and the batch set once, and no post-commit hook (#4545)", async () => {
		const seed = git(work, "rev-parse", "HEAD");
		pushQueue("a", seed);
		pushQueue("b", seed);
		const calls = stubHooks(["pre-commit", "commit-msg", "post-commit"]);

		const r = await runLander(stubTester(0));

		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toContain("exit no queue ref waits");
		expect(calls()).toEqual([
			"pre-commit --gates=merge",
			"pre-commit --gates=merge",
			"pre-commit",
		]);
	});

	it("runs the batch gate set where the Actions run repeats the rest, and every gate where it does not (#4545)", () => {
		const seed = git(work, "rev-parse", "HEAD");
		const members = [
			{ name: "a", sha: pushQueue("a", seed), pushedAt: 1 },
			{ name: "b", sha: pushQueue("b", seed), pushedAt: 2 },
		];
		const calls = stubHooks(["pre-commit"]);

		queueGit(work, undefined, undefined, { ciRepeats: true }).mergeMembers(
			seed,
			members,
		);
		expect(calls().at(-1)).toBe("pre-commit --gates=batch");
		queueGit(work).mergeMembers(seed, members);
		expect(calls().at(-1)).toBe("pre-commit");
	});

	it("gives the merges to `started` before the batch's gates where the Actions run repeats the rest, and never where it does not (#4573)", () => {
		const seed = git(work, "rev-parse", "HEAD");
		const members = [
			{ name: "a", sha: pushQueue("a", seed), pushedAt: 1 },
			{ name: "b", sha: pushQueue("b", seed), pushedAt: 2 },
		];
		const calls = stubHooks(
			["pre-commit"],
			'case "$*" in --gates=batch) echo fixed > fix.txt && git add fix.txt ;; esac\n',
		);
		const started: { sha: string; before: string[] }[] = [];
		const record = (at: string) => started.push({ sha: at, before: calls() });

		const merged = queueGit(work, undefined, undefined, {
			ciRepeats: true,
		}).mergeMembers(seed, members, false, record);

		expect(started).toHaveLength(1);
		expect(started[0]?.before).toEqual([
			"pre-commit --gates=merge",
			"pre-commit --gates=merge",
		]);
		const sha = merged.kind === "merged" ? merged.sha : "";
		git(work, "fetch", "-q", work, sha);
		expect(git(work, "rev-parse", `${sha}^`)).toBe(started[0]?.sha);
		queueGit(work).mergeMembers(seed, members, false, record);
		expect(started).toHaveLength(1);
	});

	it("gives `started` only the whole batch's merges, not each member's re-merge after its gates refuse (#4573)", () => {
		const seed = git(work, "rev-parse", "HEAD");
		const members = [
			{ name: "b", sha: pushQueue("b", seed), pushedAt: 1 },
			{ name: "a", sha: pushQueue("a", seed), pushedAt: 2 },
		];
		stubHooks(
			["pre-commit"],
			'case "$*" in --gates=batch) [ -f b.txt ] && exit 1 ;; esac\n',
		);
		const started: string[] = [];

		expect(
			queueGit(work, undefined, undefined, { ciRepeats: true }).mergeMembers(
				seed,
				members,
				false,
				(sha) => started.push(sha),
			),
		).toMatchObject({ kind: "refused", name: "b" });
		expect(started).toHaveLength(1);
	});

	it("names the member the batch's gates refuse alone, not the last one the refusal fell on (#4545)", () => {
		const seed = git(work, "rev-parse", "HEAD");
		const members = [
			{ name: "b", sha: pushQueue("b", seed), pushedAt: 1 },
			{ name: "a", sha: pushQueue("a", seed), pushedAt: 2 },
		];
		stubHooks(["pre-commit"], onBatchPass("[ -f b.txt ] && exit 1"));

		expect(queueGit(work).mergeMembers(seed, members)).toMatchObject({
			kind: "refused",
			name: "b",
		});
	});

	it("commits what the batch's gates stage on top of the merges, as a member's commit took its hook's edits (#4545)", () => {
		const seed = git(work, "rev-parse", "HEAD");
		const members = [
			{ name: "a", sha: pushQueue("a", seed), pushedAt: 1 },
			{ name: "b", sha: pushQueue("b", seed), pushedAt: 2 },
		];
		stubHooks(
			["pre-commit"],
			onBatchPass("echo fixed > fix.txt && git add fix.txt"),
		);

		const merged = queueGit(work).mergeMembers(seed, members);

		expect(merged.kind).toBe("merged");
		const sha = merged.kind === "merged" ? merged.sha : "";
		git(work, "fetch", "-q", work, sha);
		expect(git(work, "log", "-1", "--format=%s", sha)).toBe(
			"Take the batch's gate fixes",
		);
		expect(git(work, "show", `${sha}:fix.txt`)).toBe("fixed");
		expect(git(work, "log", "-1", "--format=%s", `${sha}^`)).toMatch(
			/^Merge queue\/b /,
		);
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
		pipelineRecord(path.join(markers(), ".queue-lander-batch.json")).write({
			line: [
				{
					slot: 0,
					members: [{ name: "a", sha: a, pushedAt: 1 }],
					deferred: [],
					dropped: [],
					onto: seed,
					integration: a,
					phase: "testing",
					...redPathAtRest(),
				},
			],
			search: null,
			depth: 2,
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

	it("lands two refs that changed different libraries of one guard-registry row in one batch, the row carried (#4514)", async () => {
		const guard = "scripts/guard-pair.sh";
		const fixture = build({
			claude: region(
				"- Pairs hold. **Enforced** (#4514): `scripts/guard-pair.sh` denies it.",
			),
			files: {
				[guard]:
					'#!/bin/sh\nsource "$(dirname "$0")/lib/a.sh"\nsource "$(dirname "$0")/lib/b.sh"\nexit 2\n',
				"scripts/lib/a.sh": "a() { :; }\n",
				"scripts/lib/b.sh": "b() { :; }\n",
				[SELF_PLUGIN_HOOKS]: hooksWiring(guard),
			},
		});
		fs.cpSync(fixture, work, { recursive: true });
		const review = () => reviewIn(work, [guard], ownClaims(work));
		review();
		const base = commit("registry");
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
		const a = pushQueue("a", base, () => {
			fs.writeFileSync(
				path.join(work, "scripts/lib/a.sh"),
				"a() { exit 1; }\n",
			);
			review();
		});
		const b = pushQueue("b", base, () => {
			fs.writeFileSync(
				path.join(work, "scripts/lib/b.sh"),
				"b() { exit 1; }\n",
			);
			review();
		});
		const hooks = path.resolve(
			work,
			git(work, "rev-parse", "--git-common-dir"),
			"hooks",
		);
		fs.mkdirSync(hooks, { recursive: true });
		fs.writeFileSync(
			path.join(hooks, "pre-commit"),
			"#!/bin/sh\nWFC_RULES_DIR= WFC_RULES_FALLBACK_DIR= CLAUDE_CODE_SESSION_ID=lander WFC_ANCHOR_LOCKS='[]' exec node scripts/check-guard-registry.js --against HEAD\n",
			{ mode: 0o755 },
		);

		const r = await runLander(stubTester(0));

		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).not.toContain("drop-member");
		expect(r.stdout).toContain("exit no queue ref waits");
		const main = git(remote, "rev-parse", "main");
		expect(git(remote, "merge-base", "--is-ancestor", a, main)).toBe("");
		expect(git(remote, "merge-base", "--is-ancestor", b, main)).toBe("");
		git(work, "checkout", "-q", "--detach", main);
		const stale = runRegistry(work).json.warnings.filter(
			(w) => w.guard === guard,
		);
		expect(stale).toEqual([]);
	});

	describe("a batch tree judged whole on its guard-registry faults (#4807)", () => {
		const guard = "scripts/guard-pair.sh";
		/** `main` holding `guard`'s row stale: its guard changed, unanchored. */
		const staleMain = () => {
			const fixture = build({
				claude: region(
					"- Pairs hold. **Enforced** (#4807): `scripts/guard-pair.sh` denies it.",
				),
				files: {
					[guard]: "#!/bin/sh\nexit 2\n",
					[SELF_PLUGIN_HOOKS]: hooksWiring(guard),
				},
			});
			fs.cpSync(fixture, work, { recursive: true });
			reviewIn(work, [guard], ownClaims(work));
			commit("registry");
			fs.writeFileSync(path.join(work, guard), "#!/bin/sh\nexit 3\n");
			const main = commit("expire the row");
			git(work, "push", "-q", "origin", `${main}:main`);
			return main;
		};
		const member = (name: string, sha: string) => ({ name, sha, pushedAt: 1 });

		it("holds a batch whose only stale row main holds too as stale-base, naming the row, for a lone member and a merged batch alike", () => {
			const main = staleMain();
			const a = pushQueue("a", main);
			const b = pushQueue("b", main);
			const g = queueGit(work);

			for (const members of [
				[member("a", a)],
				[member("a", a), member("b", b)],
			]) {
				const r = g.mergeMembers(main, members);
				expect(r.kind).toBe("stale-base");
				if (r.kind !== "stale-base") continue;
				expect(r.onto).toBe(main);
				expect(r.rows).toEqual([expect.stringContaining(guard)]);
			}
		});

		it("refuses a batch adding a stale row a clean main lacks, naming its member", () => {
			const main = staleMain();
			const clean = pushQueue("fix", main, () =>
				reviewIn(work, [guard], ownClaims(work)),
			);
			git(work, "push", "-q", "origin", `${clean}:main`);
			const a = pushQueue("a", clean, () =>
				fs.writeFileSync(path.join(work, guard), "#!/bin/sh\nexit 4\n"),
			);

			const r = queueGit(work).mergeMembers(clean, [member("a", a)]);
			expect(r).toMatchObject({ kind: "refused", name: "a" });
			expect(r.kind === "refused" && r.reason).toContain(guard);
		});

		it("merges a batch carrying the re-anchor", () => {
			const main = staleMain();
			const fix = pushQueue("fix", main, () =>
				reviewIn(work, [guard], ownClaims(work)),
			);

			expect(queueGit(work).mergeMembers(main, [member("fix", fix)])).toEqual({
				kind: "merged",
				sha: fix,
			});
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
		expect(ticket.title).toBe("Fix queue/a, dropped by the queue lander: a");
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

	it("drops a ref whose merge a gate refuses with the gate's verdict lines and its end, not its first line, and lands the other", async () => {
		const seed = git(work, "rev-parse", "HEAD");
		const a = pushQueue("a", seed, () =>
			fs.writeFileSync(path.join(work, "gated.txt"), "a\n"),
		);
		const b = pushQueue("b", seed);
		const hook = path.join(git(work, "rev-parse", "--git-common-dir"), "hooks");
		fs.mkdirSync(path.resolve(work, hook), { recursive: true });
		fs.writeFileSync(
			path.resolve(work, hook, "pre-commit"),
			[
				"#!/bin/sh",
				"[ -e gated.txt ] || exit 0",
				"echo 'OK: a linked worktree' >&2",
				"echo 'not carried gated.txt — both sides changed lib.js.' >&2",
				'for i in $(seq 41); do echo "rule: $i" >&2; done',
				"printf '\\033[31mSTALE-PROSE\\033[0m gated.txt\\n' >&2",
				"echo 'run: re-anchor gated.txt' >&2",
				"exit 1",
				"",
			].join("\n"),
			{ mode: 0o755 },
		);
		const { gh, readStore } = stubTracker();

		const r = await runLander(stubTester(0), "landing", gh.env);

		expect(r.status, r.stderr).toBe(0);
		expect(git(remote, "rev-parse", "dropped/a")).toBe(a);
		expect(
			git(
				remote,
				"merge-base",
				"--is-ancestor",
				b,
				git(remote, "rev-parse", "main"),
			),
		).toBe("");
		const [drop] = dropRecord(
			path.join(markers(), ".queue-lander-drops.json"),
		).read();
		expect(drop.cause).toEqual({
			kind: "refused",
			name: "a",
			reason: expect.stringMatching(
				/^\[…\]\nnot carried gated\.txt — both sides changed lib\.js\.\n\[…\]\nrule: 4\n[\s\S]*\nrule: 41\nSTALE-PROSE gated\.txt\nrun: re-anchor gated\.txt$/,
			),
		});
		const [ticket] = readStore();
		expect(ticket.body).toContain(
			"its merge was refused, the refusal's verdict lines and its end:\n\n```text\n[…]\nnot carried gated.txt — both sides changed lib.js.\n[…]\nrule: 4\n",
		);
	});

	it("lands a batch red only where main is red too, filing the base-red ticket, ledgering the batch's runs by their pass and keeping the base check on the batch record", async () => {
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
		]);
		/* Red, the batch left the line as the search, which keeps it. */
		const { search } = JSON.parse(
			fs.readFileSync(path.join(markers(), ".queue-lander-batch.json"), "utf8"),
		);
		expect(search.bases).toEqual([
			{
				sha: seed,
				files: ["scripts/x.test.ts"],
				verdict: { kind: "red", files: ["scripts/x.test.ts"] },
			},
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

	it("returns the remote's refusal of a push to main though its pre-push hook quoted a network fault (#4513)", () => {
		const a = commit("a");
		fs.writeFileSync(
			path.join(work, ".git", "hooks", "pre-push"),
			"#!/bin/sh\necho 'test said: Connection reset' >&2\n",
			{ mode: 0o755 },
		);
		fs.writeFileSync(
			path.join(remote, "hooks", "pre-receive"),
			"#!/bin/sh\necho 'GH013: rule violations' >&2\nexit 1\n",
			{ mode: 0o755 },
		);

		expect(queueGit(work).pushMain(a)).toMatch(/^! \[remote rejected\] .*main/);
	});

	it("throws a push whose hook quoted a network fault as a refusal, never a fault to retry (#4513)", () => {
		const a = commit("a");
		fs.writeFileSync(
			path.join(work, ".git", "hooks", "pre-push"),
			"#!/bin/sh\necho 'test said: Connection reset' >&2\nexit 1\n",
			{ mode: 0o755 },
		);

		let thrown: unknown;
		try {
			queueGit(work).pushMain(a);
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeInstanceOf(PushRefused);
		expect((thrown as { stderr: string }).stderr).toContain("Connection reset");
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

	it("merges a lone member descending from main as a new commit where asked fresh, never its own sha", () => {
		const seed = git(work, "rev-parse", "HEAD");
		const a = pushQueue("a", seed);
		const g = queueGit(work);
		g.refs();
		const member = { name: "a", sha: a, pushedAt: 1 };

		expect(g.mergeMembers(seed, [member])).toEqual({ kind: "merged", sha: a });
		const fresh = g.mergeMembers(seed, [member], true);

		expect(fresh.kind).toBe("merged");
		const sha = fresh.kind === "merged" ? fresh.sha : "";
		expect(sha).not.toBe(a);
		expect(git(work, "rev-parse", `${sha}^2`)).toBe(a);
		expect(git(work, "rev-parse", `${sha}^1`)).toBe(seed);
	});

	describe("a generated-only file (#4541)", () => {
		const genFile = "gen.list";
		const generated = new Map([[genFile, { generator: "gen.js" }]]);
		const txtsAt = (sha: string) =>
			git(work, "ls-tree", "-r", "--name-only", sha)
				.split("\n")
				.filter((f) => f.endsWith(".txt"));
		/** gen.js bodies writing genFile from the index's `.txt` files: their names, or their count. */
		const tracked = `require("node:child_process").execFileSync("git", ["ls-files", "*.txt"], { encoding: "utf8" }).split("\\n").filter(Boolean).sort()`;
		const listing = `require("node:fs").writeFileSync("${genFile}", ${tracked}.join("\\n") + "\\n");`;
		const counting = `require("node:fs").writeFileSync("${genFile}", ${tracked}.length + "\\n");`;
		const runGen = () =>
			expect(
				runInProcess(path.join(work, "gen.js"), [], { cwd: work }).status,
			).toBe(0);
		/** A commit holding gen.js as `body` and genFile as it writes. */
		const seeded = (body: string) => {
			fs.writeFileSync(path.join(work, "gen.js"), body);
			fs.writeFileSync(path.join(work, "seed-gen.txt"), "seed-gen");
			git(work, "add", "-A");
			runGen();
			return commit("seed-gen");
		};
		/** A queue ref adding `<name>.txt` and `extra`'s writes, genFile as gen.js then writes it. */
		const pushGenerated = (name: string, from: string, extra?: () => void) =>
			pushQueue(name, from, () => {
				extra?.();
				fs.writeFileSync(path.join(work, `${name}.txt`), name);
				git(work, "add", "-A");
				runGen();
			});
		const clash = (body: string) => () =>
			fs.writeFileSync(path.join(work, "clash.md"), body);
		const members = (a: string, b: string) => [
			{ name: "a", sha: a, pushedAt: 1 },
			{ name: "b", sha: b, pushedAt: 2 },
		];
		const genAt = (sha: string) =>
			`${git(work, "show", `${sha}:${genFile}`)}\n`;
		const merge = (seed: string, a: string, b: string) => {
			const g = queueGit(work, undefined, generated);
			g.refs();
			return g.mergeMembers(seed, members(a, b));
		};
		const landed = (r: ReturnType<typeof merge>) => {
			expect(r.kind).toBe("merged");
			return r.kind === "merged" ? r.sha : "";
		};

		beforeEach(() => {
			vi.stubEnv("WFC_PLUGIN_ROOT", "");
		});
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it("lands a merge whose text-merged copy is clean but stale", () => {
			const seed = seeded(counting);
			const a = pushGenerated("a", seed);
			const b = pushGenerated("b", seed);
			expect(genAt(a)).toBe(genAt(b));

			const sha = landed(merge(seed, a, b));

			expect(genAt(sha)).toBe(`${Number(genAt(a)) + 1}\n`);
		});

		it("lands a merge whose only conflict is the generated file", () => {
			const seed = seeded(listing);
			const a = pushGenerated("a", seed);
			const b = pushGenerated("b", seed);

			const sha = landed(merge(seed, a, b));

			expect(genAt(sha)).toBe(`${txtsAt(sha).sort().join("\n")}\n`);
			expect(txtsAt(sha)).toEqual(expect.arrayContaining(["a.txt", "b.txt"]));
		});

		it("renders with the merged tree's generator, a member's change to it included", () => {
			const seed = seeded(listing);
			const a = pushGenerated("a", seed, () =>
				fs.writeFileSync(path.join(work, "gen.js"), counting),
			);
			const b = pushGenerated("b", seed);

			const sha = landed(merge(seed, a, b));

			expect(genAt(sha)).toBe(`${txtsAt(sha).length}\n`);
		});

		it("still drops a merge conflicting in any other file, naming that file", () => {
			const seed = seeded(listing);
			const a = pushQueue("a", seed, clash("one"));
			const b = pushQueue("b", seed, clash("two"));

			expect(merge(seed, a, b)).toEqual({
				kind: "conflict",
				name: "b",
				files: ["clash.md"],
			});
		});

		it("drops a merge conflicting in the generated file and another, naming both", () => {
			const seed = seeded(listing);
			const a = pushGenerated("a", seed, clash("one"));
			const b = pushGenerated("b", seed, clash("two"));

			expect(merge(seed, a, b)).toEqual({
				kind: "conflict",
				name: "b",
				files: ["clash.md", genFile],
			});
		});

		it("drops a merge whose member deleted the generated file, rather than render it back", () => {
			const seed = seeded(listing);
			const a = pushGenerated("a", seed);
			const b = pushQueue("b", seed, () => fs.rmSync(path.join(work, genFile)));

			expect(merge(seed, a, b)).toEqual({
				kind: "conflict",
				name: "b",
				files: [genFile],
			});
		});
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

	it("reads back a verdict and a refusal another instance wrote", () => {
		const verdicts = path.join(markers(), "v.jsonl");
		fs.mkdirSync(markers(), { recursive: true });
		const LedgeredAt = "2026-11-06T12:00:00.000Z";
		vi.stubEnv("WFC_NOW", LedgeredAt);
		verdictLedger(verdicts).add("s1", ["b.ts", "a.ts"], {
			kind: "red",
			files: ["a.ts"],
		});
		/* A red its own run retried keeps the mark, or the lander re-runs it
		 * a second time (#4545). */
		verdictLedger(verdicts).add("s3", [], {
			kind: "red",
			files: ["a.ts"],
			retried: true,
		});
		/* A tree no run fired for keeps the mark, or its drop's fix ticket
		 * reads as a red naming no file (#4571). */
		verdictLedger(verdicts).add("s4", [], {
			kind: "red",
			files: [],
			noRun: true,
		});
		/* A red at the type-check keeps its errors, or its drop's fix ticket
		 * reads as a red naming no file (#4800). */
		verdictLedger(verdicts).add("s5", [], {
			kind: "red",
			files: [],
			typecheck: ["a.js(1,1): error TS1: x"],
		});
		/* A red keeps its CI run and its failing tests' errors, and a named
		 * green its run, or a drop's fix ticket cites neither (#4857). */
		const cited = {
			kind: "red" as const,
			files: ["a.ts"],
			run: 31,
			failures: [
				{ file: "a.ts", test: "a > b", message: "expected 1", signature: "s" },
				{ file: "a.ts", test: "a > c" },
			],
		};
		verdictLedger(verdicts).add("s7", [], cited);
		verdictLedger(verdicts).add("s7", ["a.ts"], { kind: "green", named: 32 });
		verdictLedger(verdicts).add("s1", [], { kind: "green", run: 7 });
		/* A green its in-job retry reached keeps the files it cleared, the
		 * batch's flakes (#4558). */
		verdictLedger(verdicts).add("s6", [], {
			kind: "green",
			run: 8,
			cleared: ["a.ts"],
		});
		verdictLedger(verdicts).add("s1", ["a.ts"], { kind: "green" }, 2);
		const noFile = {
			kind: "red" as const,
			files: [],
			jobs: ["Lint and types"],
		};
		verdictLedger(verdicts).add("s1", [], noFile, 0);
		expect(
			verdictLedger(verdicts).get("s1", ["a.ts", "b.ts"])?.verdict,
		).toEqual({
			kind: "red",
			files: ["a.ts"],
		});
		expect(verdictLedger(verdicts).get("s1", [])?.verdict).toEqual({
			kind: "green",
			run: 7,
		});
		expect(verdictLedger(verdicts).get("s6", [])?.verdict).toEqual({
			kind: "green",
			run: 8,
			cleared: ["a.ts"],
		});
		expect(verdictLedger(verdicts).get("s3", [])?.verdict).toEqual({
			kind: "red",
			files: ["a.ts"],
			retried: true,
		});
		expect(verdictLedger(verdicts).get("s7", [])?.verdict).toEqual(cited);
		expect(verdictLedger(verdicts).get("s7", ["a.ts"])?.verdict).toEqual({
			kind: "green",
			named: 32,
		});
		expect(verdictLedger(verdicts).get("s4", [])?.verdict).toEqual({
			kind: "red",
			files: [],
			noRun: true,
		});
		expect(verdictLedger(verdicts).get("s5", [])?.verdict).toEqual({
			kind: "red",
			files: [],
			typecheck: ["a.js(1,1): error TS1: x"],
		});
		/* Its time read back, as a no-run red stands only so long, and a row
		 * with none readable as the epoch (#4572). */
		expect(verdictLedger(verdicts).get("s4", [])?.at).toBe(
			Date.parse(LedgeredAt),
		);
		fs.appendFileSync(
			verdicts,
			`${JSON.stringify({ sha: "s5", files: [], verdict: { kind: "green" } })}\n`,
		);
		expect(verdictLedger(verdicts).get("s5", [])).toEqual({
			verdict: { kind: "green" },
			at: 0,
		});
		expect(verdictLedger(verdicts).get("s2", [])).toBeNull();
		expect(verdictLedger(verdicts).get("s1", ["a.ts"])).toBeNull();
		expect(verdictLedger(verdicts).get("s1", ["a.ts"], 2)?.verdict).toEqual({
			kind: "green",
		});
		expect(verdictLedger(verdicts).get("s1", [], 0)?.verdict).toEqual(noFile);
		const refused = refusedRecord(path.join(markers(), "r.jsonl"));
		refused.add("s1", "GH013: rule violations");
		expect(refusedRecord(path.join(markers(), "r.jsonl")).refusalOf("s1")).toBe(
			"GH013: rule violations",
		);
		expect(refused.refusalOf("s2")).toBeNull();
	});
});

describe("the red path", () => {
	it("isolates each member alone, drops the one red alone twice with its fix ticket, and lands the other", async () => {
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
		const [ticket] = readStore();
		expect(ticket.title).toBe("Fix queue/b, dropped by the queue lander: b");
		const iso = /as ([0-9a-f]{40}), it failed these files twice/.exec(
			ticket.body,
		)?.[1];
		expect(git(work, "merge-base", "--is-ancestor", b, iso ?? "")).toBe("");
		expect(remoteHeads()).not.toContain("refs/heads/lander/");
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
