// @vitest-environment node
/*
 * Pins that check-stale-suite-queue.js reports a suite-queue marker whose
 * waiter is gone, never removes one, and stays silent on a marker it cannot
 * judge.
 *
 * Drives the real script as a subprocess, TMPDIR pointed at a sandbox so a
 * real machine's own `/tmp` is never read or written — the way
 * `npm run status` runs it, matching check-stranded-file-claims.test.ts and
 * check-ghost-jobs.test.ts, this family's two models.
 *
 * Two properties carry the ruling (mantahostels#2034 — the sweep exists only to report,
 * never to act): it never removes a marker under any flag, and a marker this
 * sweep cannot judge (unparseable, an unreadable directory) is silence or SKIP
 * rather than a finding — reporting one as stale on a guess is exactly the
 * failure mode that would let this sweep eject a legitimate waiter.
 *
 * It reports through `npm run status`: loosen a case and a dead waiter's
 * marker sits unreported in the queue directory, or a live waiter loses its
 * place.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.join(__dirname, "check-stale-suite-queue.js");

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-queue-sweep-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/** A marker on disk, in the shape queueJoin writes. */
function marker(pid: number, extra: Record<string, unknown> = {}) {
	const file = path.join(dir, `wfc-suite-queue-${pid}.json`);
	fs.writeFileSync(
		file,
		JSON.stringify({ pid, at: Date.now(), start: 0, ...extra }),
	);
	return file;
}

const run = (args: string[] = []) =>
	spawnSync(process.execPath, [SCRIPT, ...args], {
		encoding: "utf8",
		env: { ...process.env, GITHUB_ACTIONS: "", TMPDIR: dir },
	});

const report = (r: { stdout: string; stderr: string }) => r.stdout + r.stderr;

describe("what it reports", () => {
	it("names a marker whose pid does not exist", () => {
		// 2**30 is never a real pid on this machine.
		marker(2 ** 30);

		const r = run();
		const out = report(r);
		expect(out).toContain("STALE-QUEUE-MARKER");
		expect(out).toContain(`wfc-suite-queue-${2 ** 30}.json`);
		// WARN, never FAIL: nothing here is refused.
		expect(r.status).toBe(0);
	});

	it("says nothing about a marker whose pid is this very process", () => {
		marker(process.pid);

		const r = run();
		expect(report(r)).not.toContain("STALE-QUEUE-MARKER");
		expect(report(r)).toContain("OK:");
	});

	it("names a marker whose pid is alive but whose start time no longer matches", () => {
		// This process's own pid has a real, non-zero start time; recording a
		// different one makes it read as reused.
		marker(process.pid, { start: 1 });

		const out = report(run());
		expect(out).toContain("STALE-QUEUE-MARKER");
		expect(out).toContain(String(process.pid));
	});

	it("does not judge a marker with no start recorded, even against a dead pid's own reuse", () => {
		// start: 0 is silently absent from the reuse test — only liveness judges
		// this one, and it IS dead, so it should still be reported.
		const file = marker(2 ** 30, { start: 0 });

		expect(report(run())).toContain(file);
	});

	it("ignores a file that does not match the queue-marker naming", () => {
		fs.writeFileSync(path.join(dir, "unrelated.json"), "{}");

		expect(report(run())).toContain("OK:");
	});

	it("skips a marker that will not parse, rather than raising a finding", () => {
		fs.writeFileSync(
			path.join(dir, "wfc-suite-queue-99999999.json"),
			"not json",
		);

		const out = report(run());
		expect(out).not.toContain("STALE");
		expect(out).toContain("OK:");
	});

	it("skips a marker whose pid is not a number", () => {
		fs.writeFileSync(
			path.join(dir, "wfc-suite-queue-x.json"),
			JSON.stringify({ pid: "not-a-number" }),
		);

		expect(report(run())).toContain("OK:");
	});

	/* The drift mantahostels#2034's own review caught: queueTurn requires a numeric `at`
	 * and an earlier draft of this sweep did not, so a marker with none was
	 * reported stale here under advice queueTurn would not honour on that
	 * same marker (queueTurn skips it outright). The walk is shared now
	 * (lib/suite-queue.js's readMarkers), so this asserts the shared answer. */
	it("skips a marker with a numeric pid and no numeric at, matching queueTurn", () => {
		fs.writeFileSync(
			path.join(dir, "wfc-suite-queue-11.json"),
			JSON.stringify({ pid: 11 }),
		);

		expect(report(run())).toContain("OK:");
	});

	it("SKIPs, rather than reporting an all-clear, when the queue directory cannot be read at all", () => {
		fs.rmSync(dir, { recursive: true, force: true });

		const out = report(run());
		expect(out).toContain("SKIP:");
		expect(out).not.toContain("OK:");
	});
});

describe("it never removes a marker (mantahostels#2034)", () => {
	it("leaves a stale marker on disk byte-for-byte", () => {
		const file = marker(2 ** 30);
		const before = fs.readFileSync(file, "utf8");

		expect(report(run())).toContain("STALE-QUEUE-MARKER");

		expect(fs.existsSync(file)).toBe(true);
		expect(fs.readFileSync(file, "utf8")).toBe(before);
	});

	it("has no flag that deletes anything", () => {
		const file = marker(2 ** 30);

		for (const flag of ["--sweep", "--fix", "--force", "--clean"]) run([flag]);

		expect(fs.existsSync(file)).toBe(true);
	});

	/* The way out, not just the fact of a finding — a reader who only sees
	 * "STALE-QUEUE-MARKER" and no next step reaches for `rm` on a marker that
	 * might still be a live waiter's. */
	it("names the way out on a hand run: nothing removed, who does, when to act by hand", () => {
		marker(2 ** 30);

		const out = report(run());
		expect(out).toContain("Nothing was removed");
		expect(out).toContain("next `--queue` suite clears it");
		expect(out).toContain("Delete by hand only if you are certain");
	});

	it("suppresses the way-out advice under --notify, where the itemised list already carries it", () => {
		marker(2 ** 30);

		const out = run(["--notify"]).stdout;
		expect(out).toContain("STALE-QUEUE-MARKER (1) standing");
		expect(out).not.toContain("Nothing was removed");
	});
});

describe("--notify", () => {
	it("prints nothing at all when every marker is live", () => {
		marker(process.pid);

		const r = run(["--notify"]);
		expect(r.stdout.trim()).toBe("");
		expect(r.status).toBe(0);
	});

	it("prints the standing count on a stale marker, exiting 0", () => {
		marker(2 ** 30);

		const r = run(["--notify"]);
		expect(r.stdout).toContain("STALE-QUEUE-MARKER (1) standing");
		expect(r.status).toBe(0);
	});
});
