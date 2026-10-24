// @vitest-environment node
/*
 * Pins the delivery script's requests source (#855): a release request against a
 * file this session holds, in the write path's wording and said once with it.
 *
 * The requests are made through the real arbiter in an arbiter-testkit
 * sandbox, then the script runs in process as the holder, so the wording and
 * the said-once markers are the arbiter's own rather than a fixture's copy.
 *
 * The `wfc-delivery` mod runs this source at each turn: loosen a case and a
 * holder that has moved on never hears a request, or hears it twice in the
 * hour, or reads an unreadable store as nothing asked.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	SCRIPT as ARBITER,
	freshSandbox,
	registerSession,
	store,
} from "./lib/arbiter-testkit";
import { runInProcess } from "./lib/run-in-process";

const DELIVER = path.resolve(__dirname, "deliver-to-session.js");

const sb = freshSandbox();

const node = (script: string, args: string[], session: string) =>
	spawnSync(process.execPath, [script, ...args], {
		encoding: "utf8",
		cwd: sb.repo,
		env: { ...process.env, CLAUDE_CODE_SESSION_ID: session },
	});

const deliver = (session = "holder") => {
	const r = runInProcess(DELIVER, ["--requests"], {
		env: { ...process.env, CLAUDE_CODE_SESSION_ID: session },
		cwd: sb.repo,
	});
	return { status: r.status, stdout: r.stdout };
};
const arbiter = (session: string, ...args: string[]) =>
	node(ARBITER, args, session);
const inRepo = (rel: string) => path.join(sb.repo, rel);

/** `holder` holds docs/a.md, and `mine` has asked for it. */
const asked = (why = "the B5 entry") => {
	registerSession(sb, "holder", process.pid);
	expect(arbiter("holder", "claim", inRepo("docs/a.md")).status).toBe(0);
	registerSession(sb, "mine", process.ppid);
	const r = arbiter("mine", "request", inRepo("docs/a.md"), why);
	expect(r.status).toBe(0);
	return r.stdout;
};

describe("deliver-to-session --requests (#855)", () => {
	it("tells the requester the holder hears it at its next turn too", () => {
		expect(asked()).toContain(
			"or at its next turn, where the delivery mod runs",
		);
	});

	it("prints a request against a held file in the write path's wording", () => {
		asked();
		const r = deliver();
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/^▸ release-request\n/);
		expect(r.stdout).toContain(
			'Another session is waiting on a file this one holds:\n  mine asked for docs/a.md, 0m ago: "the B5 entry"',
		);
		expect(r.stdout).toContain("decline <path>");
	});

	it("is not told again at the holder's next write, within the hour", () => {
		asked();
		expect(deliver().stdout).toContain("waiting on a file");
		const write = arbiter("holder", "claim", inRepo("docs/a.md"));
		expect(write.status).toBe(0);
		expect(write.stderr).not.toContain("waiting on a file");
	});

	it("prints nothing for a request the holder's write already told it", () => {
		asked();
		const write = arbiter("holder", "claim", inRepo("docs/a.md"));
		expect(write.stderr).toContain("waiting on a file");
		const r = deliver();
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
	});

	it("prints it once across runs", () => {
		asked();
		expect(deliver().stdout).toContain("waiting on a file");
		expect(deliver().stdout).toBe("");
	});

	it("is silent on a declined request", () => {
		asked();
		expect(
			arbiter("holder", "decline", inRepo("docs/a.md"), "mid-edit").status,
		).toBe(0);
		expect(deliver().stdout).toBe("");
	});

	it("is silent on this session's own request", () => {
		registerSession(sb, "holder", process.pid);
		expect(arbiter("holder", "claim", inRepo("docs/a.md")).status).toBe(0);
		store.recordRequest(
			"docs/a.md",
			store.identify("holder"),
			"holder",
			"mine",
		);
		expect(deliver().stdout).toBe("");
	});

	it("prints nothing to a session that holds nothing asked for", () => {
		asked();
		registerSession(sb, "other", process.pid);
		expect(deliver("other").stdout).toBe("");
	});

	it("says an unreadable claim store is unknown, never an empty all-clear", () => {
		asked();
		const dir = store.paths.locksDir();
		fs.rmSync(dir, { recursive: true, force: true });
		fs.writeFileSync(dir, "not a directory");
		const r = deliver();
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			"whether another session has asked for a file this one holds is unknown — not nothing",
		);
		expect(r.stdout).toContain("node scripts/check-guard-errors.js");
		expect(deliver().stdout).toBe("");
	});

	it("names the guard-error checker by its plugin-root path in an install (#1289)", () => {
		asked();
		const dir = store.paths.locksDir();
		fs.rmSync(dir, { recursive: true, force: true });
		fs.writeFileSync(dir, "not a directory");
		const root = path.join(sb.repo, "plugins", "wfc");
		const r = runInProcess(DELIVER, ["--requests"], {
			env: {
				...process.env,
				CLAUDE_CODE_SESSION_ID: "holder",
				WFC_SCRIPT_ROOT: root,
			},
			cwd: sb.repo,
		});
		expect(r.stdout).toContain(
			`See: node ${root}/scripts/check-guard-errors.js`,
		);
	});
});
