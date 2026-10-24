// @vitest-environment node
/*
 * Pins that a session is handed each report its own start produced exactly
 * once, never another's or an off-list producer's, and that an unreadable
 * report or store is said rather than read as nothing due.
 *
 * The delivery script driven through its CLI over a sandboxed store (#853),
 * with `CLAUDE_CONFIG_DIR` and `CLAUDE_PROJECT_DIR` in a temp directory so no
 * live session's reports are read or spent.
 *
 * The `wfc-delivery` mod runs it every 30 s in a live session: loosen a case
 * and a red CI report is withheld or repeated, or the next session start's
 * replay loses what it should still show.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";

const require_ = createRequire(__filename);
// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
const notify: any = require_("./lib/notify-report.js");
// biome-ignore lint/suspicious/noExplicitAny: as above
const store: any = require_("./lib/arbiter-store.js");
// biome-ignore lint/suspicious/noExplicitAny: as above
const { projectSlug }: any = require_("./lib/project-slug.js");
// biome-ignore lint/suspicious/noExplicitAny: as above
const { hostRoot }: any = require_("./lib/host-root.js");

const SCRIPT = path.resolve(__dirname, "deliver-to-session.js");
const REPLAY = path.resolve(__dirname, "replay-notify-reports.js");

let dir = "";
const savedEnv = { ...process.env };

const run = (script: string, args: string[], session: string | null) => {
	const env = { ...process.env };
	if (session) env.CLAUDE_CODE_SESSION_ID = session;
	else delete env.CLAUDE_CODE_SESSION_ID;
	const r = runInProcess(script, args, {
		env,
		cwd: path.resolve(__dirname, ".."),
	});
	return { status: r.status, out: r.stdout, err: r.stderr };
};

const deliver = (session: string | null = "mine") =>
	run(SCRIPT, ["--reports"], session);

/**
 * A FAIL report from `checker`; a `null` owner is an unowned report, written
 * before owners existed or by a run with no session.
 */
const report = (checker: string, text: string, owner: string | null) =>
	notify.writeReport(checker, { outcome: "FAIL", text, owner });

/** Every file in the store but the delivery ledger, with its bytes. */
const replayState = () =>
	Object.fromEntries(
		fs
			.readdirSync(notify.base())
			.filter((f: string) => f !== "delivered")
			.map((f: string) => [
				f,
				fs.readFileSync(path.join(notify.base(), f), "utf8"),
			]),
	);

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "deliver-to-session-"));
	process.env.CLAUDE_CONFIG_DIR = path.join(dir, "claude");
	process.env.CLAUDE_PROJECT_DIR = path.join(dir, "repo");
	delete process.env.WFC_CLAUDE_CONFIG_A;
	delete process.env.WFC_CLAUDE_CONFIG_B;
	delete process.env.WFC_CLAUDE_CONFIG_C;
	delete process.env.WFC_NOTIFY_PERSIST;
	fs.mkdirSync(process.env.CLAUDE_PROJECT_DIR, { recursive: true });
	fs.mkdirSync(notify.base(), { recursive: true });
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	process.env = { ...savedEnv };
});

describe("owned reports", () => {
	it("prints a report this session's start produced once, then not again", () => {
		report("ci-status", "FAIL: the sweep is red on main\n", "mine");
		report("reap-finished-sessions", "Stopped 1 finished session\n", "mine");

		const first = deliver();
		expect(first.status).toBe(0);
		expect(first.out).toContain("▸ ci-status\nFAIL: the sweep is red on main");
		expect(first.out).toContain(
			"▸ reap-finished-sessions\nStopped 1 finished session",
		);

		expect(deliver().out).toBe("");
	});

	it("prints a changed text from the same producer, once", () => {
		report("ci-status", "FAIL: red\n", "mine");
		deliver();
		report("ci-status", "FAIL: red at a later commit\n", "mine");
		expect(deliver().out).toContain("FAIL: red at a later commit");
		expect(deliver().out).toBe("");
	});

	it("never prints an unowned report, another session's, or a producer off the allow-list", () => {
		report("ci-status", "FAIL: written before owners existed\n", null);
		report("reap-finished-sessions", "Stopped another's session\n", "theirs");
		report("jev-flags", "a Jev flag owned by this session\n", "mine");

		const mine = deliver();
		expect(mine.status).toBe(0);
		expect(mine.out).toBe("");
		const theirs = deliver("theirs").out;
		expect(theirs).toContain("Stopped another's session");
		expect(theirs).not.toContain("written before owners existed");
	});

	it("prints each repo's repo-checks report this session launched, never another session's (#1553)", () => {
		report("repo-checks.o.a", "REPO-CHECKS (1) — drift gained\n", "mine");
		report("repo-checks.o.b", "REPO-CHECKS (1) — labels gained\n", "theirs");

		const { status, out } = deliver();
		expect(status).toBe(0);
		expect(out).toContain("▸ repo-checks.o.a\nREPO-CHECKS (1) — drift gained");
		expect(out).not.toContain("labels gained");
		expect(deliver().out).toBe("");
	});

	it("prints nothing for an empty report, or with no session to own one", () => {
		report("ci-status", "", "mine");
		expect(deliver()).toMatchObject({ status: 0, out: "" });
		report("ci-status", "FAIL: red\n", "mine");
		expect(deliver(null).out).toBe("");
	});

	it("leaves the replay's shown records, stamps and output as they were", () => {
		report("ci-status", "FAIL: the sweep is red on main\n", "mine");
		const before = replayState();
		const pristine = path.join(dir, "pristine");
		fs.cpSync(notify.base(), pristine, { recursive: true });

		expect(deliver()).toMatchObject({
			status: 0,
			out: expect.stringContaining("FAIL: the sweep is red on main"),
		});
		expect(replayState()).toEqual(before);

		// The next session start is shown what it would have been with no delivery.
		const after = run(REPLAY, ["--notify"], "next").out;
		fs.rmSync(notify.base(), { recursive: true });
		fs.cpSync(pristine, notify.base(), { recursive: true });
		expect(after).toContain("FAIL: the sweep is red on main");
		expect(after).toBe(run(REPLAY, ["--notify"], "next").out);
	});

	it("says an unparseable report is unknown once, never an all-clear", () => {
		fs.writeFileSync(notify.reportFile("ci-status"), "{ torn");

		const first = deliver();
		expect(first.status).toBe(0);
		expect(first.out).toContain(
			"ci-status's persisted report could not be read, so whether it is one this session's start produced is unknown — not nothing",
		);
		expect(first.out).toContain("node scripts/replay-notify-reports.js");
		expect(deliver().out).toBe("");
	});

	it("says the store is unreadable once, never an empty all-clear", () => {
		/* A file wherever the store could resolve, so notify.base() falls back to
		 * the pinned path and readdir fails with ENOTDIR (mantahostels#174). */
		const slug = projectSlug(hostRoot());
		fs.rmSync(notify.base(), { recursive: true, force: true });
		for (const p of [
			path.join(store.stateDir(), "notify-reports"),
			...store
				.configDirs()
				.map((c: string) => path.join(c, "projects", slug, "notify-reports")),
		]) {
			fs.mkdirSync(path.dirname(p), { recursive: true });
			fs.writeFileSync(p, "not a directory");
		}

		const first = deliver();
		expect(first.status).toBe(0);
		expect(first.out).toContain(
			"the notify-reports store could not be read, so whether a report from this session's start is waiting is unknown — not nothing",
		);
		expect(deliver().out).toBe("");
	});
});

describe("the command line", () => {
	it("prints the store paths the mod stats", () => {
		const paths = JSON.parse(run(SCRIPT, ["--paths"], null).out);
		expect(paths).toEqual({
			notifyReports: notify.base(),
			requests: store.paths.requestsDir(),
			locks: store.paths.locksDir(),
		});
	});

	it("refuses no source and an unknown flag, naming the flags it takes", () => {
		for (const args of [[], ["--everything"]]) {
			const r = run(SCRIPT, args, "mine");
			expect(r.status).toBe(2);
			expect(r.err).toContain(
				"usage: node scripts/deliver-to-session.js --reports | --requests | --ci | --paths",
			);
		}
	});
});
