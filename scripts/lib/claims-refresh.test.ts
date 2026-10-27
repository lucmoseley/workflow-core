// @vitest-environment node
/*
 * Pins lib/claims-refresh.js, the PostToolUse-on-Bash recorder core
 * (mantahostels#295): it re-records what this session holds after a Bash call,
 * baselines a path the session only Bash-wrote (mantahostels#419) without
 * minting a lock, and says nothing.
 *
 * It runs after EVERY Bash call in every session. The core runs in process
 * through the dispatcher, inside an arbiter sandbox, so its records land in a
 * scratch store and never the live one; the entry's fail-open on an empty or
 * unparseable payload is scripts/guard-dispatch.test.ts's boundary set.
 *
 * Loosen a case and a session's own `sed` reads as a clobber at its next write,
 * or a Bash-route overwrite goes unbaselined.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { core, freshSandbox, live, store } from "./arbiter-testkit";
import { runCore } from "./guard-core-testkit";

const sb = freshSandbox();
const REL = "scripts/evidence-audit.py";

const run = (sessionId?: string, env: Record<string, string> = {}) =>
	runCore(
		"refresh-claims",
		{
			...(sessionId === undefined ? {} : { session_id: sessionId }),
			tool_name: "Bash",
			tool_input: {
				command: "sed -i s/v1.35/v1.36/ scripts/evidence-audit.py",
			},
		},
		{ root: sb.repo, env, event: "PostToolUse" },
	);

describe("refresh-claims — re-record what this session holds, after a Bash call", () => {
	beforeEach(() => {
		execFileSync("git", ["init", "-q"], { cwd: sb.repo });
		fs.mkdirSync(path.join(sb.repo, "scripts"), { recursive: true });
	});

	const write = (text: string) =>
		fs.writeFileSync(path.join(sb.repo, REL), text);
	const readLock = () => core.readRecord(store.paths.lock(REL));

	/** A claim on REL with its content recorded, as a tool write would leave it. */
	const claimed = (sessionId: string, text: string) => {
		const me = live(sb, sessionId);
		write(text);
		store.acquire(REL, me);
		store.recordContent(REL, me);
		return me;
	};

	it("refreshes the record, so the session's own sed is not a clobber, and says nothing", () => {
		claimed("alice", "v1.35\n");
		write("v1.36\n");
		expect(store.contentState(REL, readLock()).state).toBe("changed");

		expect(run("alice")).toEqual({ output: null, logs: [] });
		expect(store.contentState(REL, readLock()).state).toBe("same");
	});

	it("leaves a path this session does not hold alone", () => {
		// Refreshing a neighbour's claim would erase the evidence they are owed the
		// moment somebody clobbers their file.
		claimed("bob", "bob's\n");
		write("clobbered\n");

		run("alice");
		expect(store.contentState(REL, readLock()).state).toBe("changed");
	});

	it("falls back to CLAUDE_CODE_SESSION_ID where the payload carries no session", () => {
		claimed("alice", "v1.35\n");
		write("v1.36\n");

		run(undefined, { CLAUDE_CODE_SESSION_ID: "alice" });
		expect(store.contentState(REL, readLock()).state).toBe("same");
	});

	it("records nothing with no session to attribute the call to", () => {
		claimed("alice", "v1.35\n");
		write("v1.36\n");

		expect(run(undefined, { CLAUDE_CODE_SESSION_ID: "" }).output).toBeNull();
		// Unrefreshed, so the next write reports — failing open here costs a false
		// clobber report, never a lost one.
		expect(store.contentState(REL, readLock()).state).toBe("changed");
	});

	describe("the tier scan — a baseline for a session holding no claim (mantahostels#419)", () => {
		// The gap mantahostels#364 measured: this hook refreshed only what the session already
		// held, and a session that reached the file from Bash alone holds nothing.
		it("baselines a path this session only ever Bash-wrote", () => {
			live(sb, "alice");
			write("v1.35\n");
			run("alice");
			expect(store.observationState(REL, "alice").state).toBe("unknown");

			write("v1.36\n"); // the sed no hook sees
			run("alice");
			expect(store.observationState(REL, "alice").state).toBe("same");

			write("clobbered by a route no hook watches\n");
			expect(store.observationState(REL, "alice").state).toBe("changed");
		});

		it("refreshes a baseline the scan minted on a deny-tier path, so the session's second sed is no clobber either", () => {
			// A deny-tier path takes an unlocked observation only on the Bash route.
			const doc = "docs/notes.md";
			const sed = (text: string) => {
				fs.writeFileSync(path.join(sb.repo, doc), text);
				run("alice");
			};
			live(sb, "alice");
			fs.mkdirSync(path.join(sb.repo, "docs"), { recursive: true });
			sed("v1.35\n");
			sed("v1.36\n");
			sed("v1.37\n"); // the second sed, on a path the scan now covers
			expect(store.observationState(doc, "alice").state).toBe("same");
		});

		it("mints no lock, so the scan refuses a neighbour nothing (mantahostels#288)", () => {
			live(sb, "alice");
			run("alice");
			write("v1.36\n");
			run("alice");
			expect(store.listLocks()).toEqual([]);
		});

		it("baselines no more than the scan's cap in one call, so a whole-tier move cannot overrun the hook's timeout", () => {
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
			run("alice");
			for (const rel of rels) fs.writeFileSync(path.join(sb.repo, rel), "v2\n");

			run("alice");
			const first = baselined();
			expect(first).toBeGreaterThan(0);
			expect(first).toBeLessThan(rels.length);
			run("alice");
			expect(baselined()).toBe(2 * first);
		});
	});
});
