// @vitest-environment node

import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshSandbox, live, readLockAt, store } from "./arbiter-testkit";
import { defineTemplate, emptyRepoTemplate } from "./git-fixture";
import { runCore, splitCheckout } from "./guard-core-testkit";

const sb = freshSandbox();
const sandboxRepo = defineTemplate((dir) => {
	emptyRepoTemplate(dir);
	fs.mkdirSync(path.join(dir, "docs"));
});
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
		sandboxRepo.instantiate(sb.repo);
		fs.mkdirSync(path.join(sb.repo, "scripts"), { recursive: true });
	});

	const write = (text: string) =>
		fs.writeFileSync(path.join(sb.repo, REL), text);
	const readLock = () => readLockAt(store.paths.lock(REL));

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
		expect(store.contentState(REL, readLock()).state).toBe("changed");
	});

	describe("the tier scan — a baseline for a session holding no claim (mantahostels#419)", () => {
		it("baselines a path this session only ever Bash-wrote", () => {
			live(sb, "alice");
			write("v1.35\n");
			run("alice");
			expect(store.observationState(REL, "alice").state).toBe("unknown");

			write("v1.36\n");
			run("alice");
			expect(store.observationState(REL, "alice").state).toBe("same");

			write("clobbered by a route no hook watches\n");
			expect(store.observationState(REL, "alice").state).toBe("changed");
		});

		it("refreshes a baseline the scan minted on a deny-tier path, so the session's second sed is no clobber either", () => {
			const doc = "docs/notes.md";
			const sed = (text: string) => {
				fs.writeFileSync(path.join(sb.repo, doc), text);
				run("alice");
			};
			live(sb, "alice");
			fs.mkdirSync(path.join(sb.repo, "docs"), { recursive: true });
			sed("v1.35\n");
			sed("v1.36\n");
			sed("v1.37\n");
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

describe("a Bash call from a session in its own worktree (#4242)", () => {
	let at: { main: string; worktree: string };
	const split = freshSandbox((fresh) => {
		at = splitCheckout(path.join(fresh.dir, "split"));
		vi.stubEnv("CLAUDE_PROJECT_DIR", at.worktree);
		vi.stubEnv("WFC_REPO_ROOT", at.main);
		vi.stubEnv("WFC_DISPATCH_ROOT", at.main);
		fs.mkdirSync(path.join(at.main, "scripts"));
	});

	it("refreshes the session's claim in the main checkout's store", () => {
		const file = path.join(at.main, REL);
		fs.writeFileSync(file, "v1.35\n");
		const me = live(split, "alice");
		store.acquire(REL, me);
		store.recordContent(REL, me);
		fs.writeFileSync(file, "v1.36\n");
		const lock = () => readLockAt(store.paths.lock(REL));
		expect(store.contentState(REL, lock()).state).toBe("changed");
		const r = runCore(
			"refresh-claims",
			{
				session_id: "alice",
				tool_name: "Bash",
				tool_input: { command: "true" },
			},
			{ root: at.main, worktree: at.worktree, event: "PostToolUse" },
		);
		expect(r).toEqual({ output: null, logs: [] });
		expect(store.contentState(REL, lock()).state).toBe("same");
	});
});
