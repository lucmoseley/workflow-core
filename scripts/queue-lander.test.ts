// @vitest-environment node
/*
 * scripts/queue-lander.js end to end, and lib/queue-lander-adapters.js's git
 * and files, against lib/lander-testkit.ts's real bare remote and clone
 * (#4485, spec #4458).
 *
 * Loosen it and two queue refs no longer land as one merged batch, an anchors
 * file both refs touched stops the batch though its driver settles it, a ref
 * pushed while its batch was tested is deleted unlanded, or a verdict or batch
 * written to disk is lost to the next run.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	commit,
	git,
	landerSandbox,
	markers,
	remote,
	runLanderScript,
	stubTester,
	work,
} from "./lib/lander-testkit";
import {
	batchRecord,
	queueGit,
	verdictLedger,
} from "./lib/queue-lander-adapters.js";
import { shellQuote } from "./lib/sh-quote.js";

landerSandbox();

const QUEUE_LANDER = path.resolve(__dirname, "queue-lander.js");
const Anchors = ".claude/guard-registry-anchors.json";

/** A commit on `from`, after `write` where given, pushed as `queue/<name>`, returning its sha. */
const pushQueue = (name: string, from: string, write?: () => void) => {
	git(work, "checkout", "-q", "--detach", from);
	write?.();
	const sha = commit(name);
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

		const r = await runLanderScript(QUEUE_LANDER, stubTester(0));

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

		const r = await runLanderScript(QUEUE_LANDER, stubTester(0));

		expect(r.status).toBe(0);
		expect(git(remote, "rev-parse", "main")).toBe(a);
	});

	it("settles a conflict in the anchors file with the registry merge driver and lands both refs", async () => {
		const seed = git(work, "rev-parse", "HEAD");
		fs.mkdirSync(path.join(work, ".claude"), { recursive: true });
		const writeAnchors = (rows: Record<string, string>) =>
			fs.writeFileSync(
				path.join(work, Anchors),
				`${JSON.stringify(rows, null, "\t")}\n`,
			);
		writeAnchors({ "x.js": "0000" });
		const base = commit("anchors");
		git(work, "push", "-q", "origin", `${base}:main`);
		fs.writeFileSync(
			path.join(work, ".git", "info", "attributes"),
			`${Anchors} merge=registry-anchors\n`,
		);
		git(
			work,
			"config",
			"merge.registry-anchors.driver",
			`node ${shellQuote(path.resolve(__dirname, "merge-registry-anchors.js"))} %O %A %B`,
		);
		pushQueue("a", base, () =>
			writeAnchors({ "a.js": "aaaa", "x.js": "0000" }),
		);
		pushQueue("b", base, () =>
			writeAnchors({ "b.js": "bbbb", "x.js": "0000" }),
		);
		expect(seed).not.toBe(base);

		const r = await runLanderScript(QUEUE_LANDER, stubTester(0));

		expect(r.stdout).toContain("exit no queue ref waits");
		const main = git(remote, "rev-parse", "main");
		expect(JSON.parse(git(remote, "show", `${main}:${Anchors}`))).toEqual({
			"a.js": "aaaa",
			"b.js": "bbbb",
			"x.js": "0000",
		});
	});

	it("lands nothing on a red batch, ledgering its verdict for the next run", async () => {
		const seed = git(work, "rev-parse", "HEAD");
		pushQueue("a", seed);
		pushQueue("b", seed);

		const r = await runLanderScript(
			QUEUE_LANDER,
			stubTester(1, "scripts/x.test.ts\n"),
		);

		expect(r.stdout).toMatch(
			/exit the batch \w+ is red on scripts\/x\.test\.ts: the red path is unbuilt \(#4485\)/,
		);
		expect(git(remote, "rev-parse", "main")).toBe(seed);
		const again = await runLanderScript(QUEUE_LANDER, stubTester(0));
		expect(again.stdout).toContain("the red path is unbuilt");
		expect(again.stdout).not.toContain("test-sha");
	});
});

describe("the adapters", () => {
	it("compare-and-deletes a queue ref only at the sha it was given, keeping one that moved", () => {
		const seed = git(work, "rev-parse", "HEAD");
		const a1 = pushQueue("a", seed);
		const a2 = commit("a2");
		git(work, "push", "-q", "origin", `${a2}:refs/heads/queue/a`);
		const g = queueGit(work);

		expect(g.deleteRef("a", a1)).toBe(false);
		expect(git(remote, "rev-parse", "queue/a")).toBe(a2);
		expect(g.deleteRef("a", a2)).toBe(true);
		expect(remoteHeads()).not.toContain("queue/a");
	});

	it("lists each queue ref with its sha, committer time and whether it descends from main", () => {
		const seed = git(work, "rev-parse", "HEAD");
		const a = pushQueue("a", seed);
		const other = commit("other");
		git(work, "push", "-q", "origin", `${other}:main`);

		const { main, queue } = queueGit(work).refs();

		expect(main).toBe(other);
		expect(queue).toEqual([
			{
				name: "a",
				sha: a,
				pushedAt: Number(git(work, "log", "-1", "--format=%ct", a)) * 1000,
				onMain: false,
			},
		]);
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
		const b = {
			members: [{ name: "a", sha: "s0", pushedAt: 1 }],
			onto: "m0",
			integration: "s1",
			phase: "testing" as const,
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
		expect(batchRecord(batch).read()).toEqual(b);
		fs.writeFileSync(batch, '{"members": [');
		expect(batchRecord(batch).read()).toBeNull();
	});
});
