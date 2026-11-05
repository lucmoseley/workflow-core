// @vitest-environment node
/*
 * scripts/lander.js end to end (#2402, #2404): a run's wiring of landing,
 * holding and filing, against lib/lander-testkit.ts's real-git sandbox. Its
 * conflicted-revert runs are lander-conflicts.test.ts's; remoteGit's own
 * cases are lib/lander-remote-git.test.ts's.
 *
 * Loosen it and a lander run can leave `main` behind a green `landing`, move
 * `main` backwards, run with no heartbeat for the stall check to read, or let
 * one red commit hold back the green ones around it.
 *
 * Over the 10 s file budget: each case is a real lander run, and the red
 * ones bisect and revert: 78 forks in the three-commit red run (#4326's profile).
 */
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { stubGhScript } from "./lib/gh-stub.js";
import {
	commit,
	git,
	landerSandbox,
	levelled,
	markers,
	remote,
	runLander,
	stubRedWhile,
	stubTester,
	stubTracker,
	tmp,
	work,
	writeTrackerConfig,
} from "./lib/lander-testkit";
import { shellQuote } from "./lib/sh-quote.js";

landerSandbox();

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

it("starts a quiet levelling pass in the checkout once it moves main (#4248)", async () => {
	commit("work");
	git(work, "push", "-q", "origin", "HEAD:landing");

	const r = await runLander(stubTester(0));

	expect(r.status, r.stderr).toBe(0);
	await expect
		.poll(() =>
			fs.existsSync(levelled()) ? fs.readFileSync(levelled(), "utf8") : "",
		)
		.toBe(`${fs.realpathSync(work)} --quiet\n`);
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
	writeTrackerConfig();

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
