// @vitest-environment node
/*
 * Pins refresh-claims.sh, the PostToolUse-on-Bash recorder (mantahostels#295):
 * it re-records what this session holds after a Bash call, baselines a path the
 * session only Bash-wrote (mantahostels#419) without minting a lock, and never
 * fails the call.
 *
 * It runs after EVERY Bash call in every session, so its fail-open paths matter
 * more than its happy one — a recorder that aborted a Bash call would be worse
 * than no recorder at all.
 *
 * The hook is spawned on a real payload inside an arbiter sandbox, so its
 * records land in a scratch store and never the live one.
 *
 * Loosen a case and a session's own `sed` reads as a clobber at its next write,
 * a Bash-route overwrite goes unbaselined, or a Bash call fails over the hook.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { core, freshSandbox, live, store } from "./lib/arbiter-testkit";

const sb = freshSandbox();
const HOOK = path.join(__dirname, "refresh-claims.sh");
const REL = "scripts/evidence-audit.py";

const run = (payload: string, env: Record<string, string> = {}) =>
	spawnSync(HOOK, [], {
		encoding: "utf8",
		cwd: sb.repo,
		input: payload,
		env: { ...process.env, ...env },
	});

const bashPayload = (sessionId?: string) =>
	JSON.stringify({
		...(sessionId === undefined ? {} : { session_id: sessionId }),
		tool_name: "Bash",
		tool_input: { command: "sed -i s/v1.35/v1.36/ scripts/evidence-audit.py" },
	});

describe("refresh-claims.sh — re-record what this session holds, after a Bash call", () => {
	beforeEach(() => {
		execFileSync("git", ["init", "-q"], { cwd: sb.repo });
		fs.mkdirSync(path.join(sb.repo, "scripts"), { recursive: true });
	});

	const write = (text: string) =>
		fs.writeFileSync(path.join(sb.repo, REL), text);
	const lockOf = () => core.readRecord(store.paths.lock(REL));

	/** A claim on REL with its content recorded, as a tool write would leave it. */
	const claimed = (sessionId: string, text: string) => {
		const me = live(sb, sessionId);
		write(text);
		store.acquire(REL, me);
		store.recordContent(REL, me);
		return me;
	};

	it("refreshes the record, so the session's own sed is not a clobber", () => {
		claimed("alice", "v1.35\n");
		write("v1.36\n");
		expect(store.contentState(REL, lockOf()).state).toBe("changed");

		expect(run(bashPayload("alice")).status).toBe(0);
		expect(store.contentState(REL, lockOf()).state).toBe("same");
	});

	it("leaves a path this session does not hold alone", () => {
		// Refreshing a neighbour's claim would erase the evidence they are owed the
		// moment somebody clobbers their file.
		claimed("bob", "bob's\n");
		write("clobbered\n");

		run(bashPayload("alice"));
		expect(store.contentState(REL, lockOf()).state).toBe("changed");
	});

	it("falls back to CLAUDE_CODE_SESSION_ID where the payload carries no session", () => {
		claimed("alice", "v1.35\n");
		write("v1.36\n");

		expect(
			run(bashPayload(undefined), { CLAUDE_CODE_SESSION_ID: "alice" }).status,
		).toBe(0);
		expect(store.contentState(REL, lockOf()).state).toBe("same");
	});

	describe("it never fails a Bash call", () => {
		it("exits 0 on an empty payload", () => {
			expect(run("").status).toBe(0);
		});

		it("exits 0 on a payload that is not JSON", () => {
			expect(run("not json at all").status).toBe(0);
		});

		it("exits 0 with no session to attribute the call to", () => {
			expect(
				run(bashPayload(undefined), { CLAUDE_CODE_SESSION_ID: "" }).status,
			).toBe(0);
		});

		it("exits 0 with neither node nor jq on PATH, and records nothing", () => {
			claimed("alice", "v1.35\n");
			write("v1.36\n");

			// A PATH carrying the shell and its coreutils but NOT node or jq. Pointing
			// PATH at nothing at all would only prove the shebang cannot find bash —
			// exit 127, before a line of the script runs.
			const bin = path.join(sb.dir, "bin");
			fs.mkdirSync(bin, { recursive: true });
			for (const tool of ["bash", "cat", "dirname", "timeout"]) {
				const real = spawnSync("which", [tool], {
					encoding: "utf8",
				}).stdout.trim();
				if (real) fs.symlinkSync(real, path.join(bin, tool));
			}

			expect(run(bashPayload("alice"), { PATH: bin }).status).toBe(0);
			// Unrefreshed, so the next write reports — failing open here costs a false
			// clobber report, never a lost one.
			expect(store.contentState(REL, lockOf()).state).toBe("changed");
		});
	});
	describe("the tier scan — a baseline for a session holding no claim (mantahostels#419)", () => {
		// The gap mantahostels#364 measured: this hook refreshed only what the session already
		// held, and a session that reached the file from Bash alone holds nothing.
		it("baselines a path this session only ever Bash-wrote", () => {
			live(sb, "alice");
			write("v1.35\n");
			run(bashPayload("alice"));
			expect(store.observationState(REL, "alice").state).toBe("unknown");

			write("v1.36\n"); // the sed no hook sees
			expect(run(bashPayload("alice")).status).toBe(0);
			expect(store.observationState(REL, "alice").state).toBe("same");

			write("clobbered by a route no hook watches\n");
			expect(store.observationState(REL, "alice").state).toBe("changed");
		});

		it("mints no lock, so the scan refuses a neighbour nothing (mantahostels#288)", () => {
			live(sb, "alice");
			run(bashPayload("alice"));
			write("v1.36\n");
			run(bashPayload("alice"));
			expect(store.listLocks()).toEqual([]);
		});

		it("baselines no more than the scan's cap in one call, so a whole-tier move cannot overrun the hook's `timeout 5`", () => {
			// Counted, not timed (#1916): each baseline costs two git processes, and
			// the cap (SCAN_MINT_MAX in lib/arbiter-snapshots.js) keeps one call's
			// count of them under the tier's whole move.
			const rels = Array.from({ length: 60 }, (_, i) => `scripts/gen-${i}.py`);
			const baselined = () =>
				rels.filter(
					(rel) => store.observationState(rel, "alice").state === "same",
				).length;
			live(sb, "alice");
			for (const rel of rels) fs.writeFileSync(path.join(sb.repo, rel), "v1\n");
			run(bashPayload("alice"));
			for (const rel of rels) fs.writeFileSync(path.join(sb.repo, rel), "v2\n");

			expect(run(bashPayload("alice")).status).toBe(0);
			const first = baselined();
			expect(first).toBeGreaterThan(0);
			expect(first).toBeLessThan(rels.length);
			run(bashPayload("alice"));
			expect(baselined()).toBe(2 * first);
		});
	});
});
