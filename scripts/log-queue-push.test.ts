// @vitest-environment node
/*
 * scripts/log-queue-push.js, its .husky/pre-push limb and lib/queue-log.js's
 * read (#4485, spec #4458), on lib/lander-testkit.ts's clone.
 *
 * Loosen it and a queue ref's push goes unlogged, a deletion or another
 * remote's push is logged as one, or a ref's push time is read off a row for
 * a sha it no longer holds, and the queue lander merges out of push order.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { landerSandbox, markers, remote, work } from "./lib/lander-testkit";
import { logEnqueue, queueLogFile, readEnqueueTimes } from "./lib/queue-log.js";
import { runInProcess } from "./lib/run-in-process.js";

landerSandbox();

const ROOT = path.resolve(__dirname, "..");
const LOG_PUSH = path.join(ROOT, "scripts", "log-queue-push.js");
const ZERO = "0".repeat(40);
const A = "a".repeat(40);
const B = "b".repeat(40);
/* Inside the log's retention, which prunes by the real clock. */
const AT = new Date(Date.now() - 60_000).toISOString();

const refLine = (sha: string, ref: string) => `HEAD ${sha} ${ref} ${ZERO}\n`;

const logPush = (stdin: string, remoteName = "origin", modules = "landing") =>
	runInProcess(LOG_PUSH, [remoteName], {
		cwd: work,
		env: { ...process.env, WFC_MODULES: modules, WFC_NOW: AT },
		stdin,
	});

const pushedAt = (ref: string, sha: string) =>
	readEnqueueTimes(queueLogFile(work))(ref, sha);

describe("the pre-push limb", () => {
	it("logs each queue ref a push to the remote updates, at push time, and no deletion or other ref", () => {
		const r = logPush(
			refLine(A, "refs/heads/queue/a") +
				refLine(ZERO, "refs/heads/queue/b") +
				refLine(B, "refs/heads/main"),
		);

		expect(r.status, r.stderr).toBe(0);
		expect(pushedAt("refs/heads/queue/a", A)).toBe(Date.parse(AT));
		expect(pushedAt("refs/heads/queue/b", ZERO)).toBeNull();
		expect(pushedAt("refs/heads/main", B)).toBeNull();
	});

	it("logs nothing for a push to another remote or with the landing module off", () => {
		expect(logPush(refLine(A, "refs/heads/queue/a"), "upstream").status).toBe(
			0,
		);
		expect(
			logPush(refLine(A, "refs/heads/queue/a"), "origin", "suites").status,
		).toBe(0);

		expect(fs.existsSync(queueLogFile(work))).toBe(false);
	});

	it("is wired into .husky/pre-push, which logs a queue push and passes it", () => {
		const r = spawnSync(
			"sh",
			[path.join(ROOT, ".husky", "pre-push"), "origin", remote],
			{
				cwd: work,
				input: refLine(A, "refs/heads/queue/a"),
				encoding: "utf8",
				env: {
					...process.env,
					WFC_MODULES: "landing",
					WFC_PLUGIN_ROOT: ROOT,
					WFC_NOW: AT,
				},
			},
		);

		expect(r.status, r.stderr).toBe(0);
		expect(pushedAt("refs/heads/queue/a", A)).toBe(Date.parse(AT));
	});
});

describe("the read", () => {
	it("reads a ref's newest push at the sha it holds, and none at a sha no row names", () => {
		const file = queueLogFile(work);
		fs.mkdirSync(markers(), { recursive: true });
		const ref = "refs/heads/queue/a";
		logEnqueue(file, { ref, sha: A, at: Date.parse(AT) });
		logEnqueue(file, { ref, sha: B, at: Date.parse(AT) + 1000 });
		logEnqueue(file, { ref, sha: A, at: Date.parse(AT) + 2000 });

		expect(pushedAt(ref, A)).toBe(Date.parse(AT) + 2000);
		expect(pushedAt(ref, B)).toBe(Date.parse(AT) + 1000);
		expect(pushedAt("refs/heads/queue/b", A)).toBeNull();
		expect(pushedAt(ref, "c".repeat(40))).toBeNull();
	});
});
