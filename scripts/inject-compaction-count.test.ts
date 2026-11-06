// @vitest-environment node
/*
 * inject-compaction-count.test.ts — the compact-time autocompaction count
 * (#1148), driven as the harness drives it: a PreCompact payload, then a
 * SessionStart:compact one.
 *
 * Both hooks and the ceiling guard's Stop run in process over a transcript
 * written to a temp dir, so the count is read off real `compact_boundary`
 * records and the set the guard settles is the one the hook wrote.
 *
 * The hook is registered on `PreCompact` and `SessionStart` in
 * .claude/settings.json: break a case here and a session is told a wrong
 * compaction count, or none, and judges its own ceiling on it.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const require_ = createRequire(__filename);
const { markersDir } = require_("./lib/marker-root.js");
const { compactPayloads, compactTranscripts, SUBAGENT_JUST_COMPACTED } =
	require_("./lib/compact-payload-fixture.js");

const HOOK = path.join(__dirname, "inject-compaction-count.js");
const GUARD = path.join(__dirname, "guard-session-ceiling.js");

let dir: string;
const sid = "11111111-2222-3333-4444-555555555555";

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "compaction-count-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const transcriptFile = () => path.join(dir, `${sid}.jsonl`);
const boundary = (uuid: string, trigger = "auto") => ({
	type: "system",
	subtype: "compact_boundary",
	uuid,
	isSidechain: false,
	compactMetadata: { trigger },
});
const usage = {
	type: "assistant",
	requestId: "req_1",
	message: { usage: { input_tokens: 28_000 } },
};
const writeTranscript = (records: object[]) =>
	fs.writeFileSync(
		transcriptFile(),
		records.map((r) => `${JSON.stringify(r)}\n`).join(""),
	);
const compactionSet = () =>
	path.join(markersDir(dir), `.session-ceiling-compactions-${sid}`);
const setKeys = () =>
	fs.readFileSync(compactionSet(), "utf8").trim().split("\n");

const sandboxEnv = () => ({
	...process.env,
	CLAUDE_CONFIG_DIR: dir,
	CLAUDE_PROJECT_DIR: dir,
	WFC_REPO_ROOT: dir,
	WFC_DISPATCH_ROOT: dir,
});

const exec = (script: string, payload: object) => {
	const r = runInProcess(script, [], {
		stdin: JSON.stringify({
			session_id: sid,
			transcript_path: transcriptFile(),
			...payload,
		}),
		env: sandboxEnv(),
	});
	expect(r.status).toBe(0);
	return r.stdout;
};

const preCompact = (trigger: string) =>
	exec(HOOK, { hook_event_name: "PreCompact", trigger });
/** What the model is told after a compaction, or "" for silence. */
const afterCompact = (source = "compact", extra: object = {}) => {
	const out = exec(HOOK, {
		hook_event_name: "SessionStart",
		source,
		...extra,
	});
	return out
		? JSON.parse(out).hookSpecificOutput.additionalContext
		: (out as string);
};

describe("after an autocompaction", () => {
	it("tells the model the count, earlier boundaries in the transcript included, and the set agrees", () => {
		writeTranscript([boundary("c1"), usage]);
		preCompact("auto");
		const told = afterCompact();
		expect(told).toContain("This session has autocompacted 2 times");
		expect(told).toContain("start no new unit after it.");
		expect(told).not.toContain("successor");
		expect(setKeys()).toHaveLength(2);
	});

	it("says 1 time on the first", () => {
		writeTranscript([usage]);
		preCompact("auto");
		expect(afterCompact()).toContain("autocompacted 1 time.");
	});

	/* Its boundary reaches the transcript only after the hook has run, so the
	 * guard's next Stop is where the set swaps the pending key for it. */
	it("keeps the same count once the ceiling guard's Stop has read the new boundary", () => {
		writeTranscript([boundary("c1"), usage]);
		preCompact("auto");
		afterCompact();
		writeTranscript([boundary("c1"), boundary("c2"), usage]);
		exec(GUARD, { hook_event_name: "Stop", last_assistant_message: "x" });
		expect(setKeys()).toEqual(["c1", "c2"]);
	});

	it("speaks where PreCompact carried no trigger, as autocompactions counts that boundary", () => {
		writeTranscript([usage]);
		exec(HOOK, { hook_event_name: "PreCompact" });
		expect(afterCompact()).toContain("autocompacted 1 time.");
	});

	it("speaks once per compaction, the trigger being spent", () => {
		writeTranscript([usage]);
		preCompact("auto");
		afterCompact();
		expect(afterCompact()).toBe("");
	});
});

/* Harness 2.1.301 sends a subagent's compaction with its parent's session id and
 * no agent_id, so the hook counts it as the parent's (#1785). */
describe("a subagent's compaction leaves the parent's count as it was", () => {
	const subagent = () =>
		compactPayloads({
			sessionId: sid,
			transcriptPath: transcriptFile(),
			cwd: dir,
		});
	const subagentCompacts = () => {
		const { preCompact: pre, sessionStart: start } = subagent();
		exec(HOOK, pre);
		exec(HOOK, start);
	};

	it("leaves the parent's count unchanged once the parent's next Stop has run", () => {
		writeTranscript([boundary("c1"), usage]);
		exec(GUARD, { hook_event_name: "Stop", last_assistant_message: "x" });
		subagentCompacts();
		subagentCompacts();
		exec(GUARD, { hook_event_name: "Stop", last_assistant_message: "x" });
		expect(setKeys()).toEqual(["c1"]);
	});

	it("is not counted in what the parent is told at its own next compaction", () => {
		writeTranscript([boundary("c1"), usage]);
		subagentCompacts();
		subagentCompacts();
		preCompact("auto");
		expect(afterCompact()).toContain("autocompacted 2 times.");
		expect(setKeys()).toHaveLength(2);
	});

	it("leaves the set as it was where the payload carries agent_id", () => {
		writeTranscript([boundary("c1"), usage]);
		exec(GUARD, { hook_event_name: "Stop", last_assistant_message: "x" });
		const { preCompact: pre, sessionStart: start } = compactPayloads({
			sessionId: sid,
			transcriptPath: transcriptFile(),
			cwd: dir,
			agentId: "a1b2c3d4e5f6a7b8c",
		});
		exec(HOOK, pre);
		expect(exec(HOOK, start)).toBe("");
		expect(setKeys()).toEqual(["c1"]);
	});

	// Until the harness sends agent_id there (#1837).
	it("says nothing and leaves the set where a subagent's transcript is fresher than the parent's stale one", () => {
		writeTranscript([boundary("c1"), usage]);
		exec(GUARD, { hook_event_name: "Stop", last_assistant_message: "x" });
		compactTranscripts(dir, { sessionId: sid, ...SUBAGENT_JUST_COMPACTED });
		const { preCompact: pre, sessionStart: start } = subagent();
		exec(HOOK, pre);
		expect(exec(HOOK, start)).toBe("");
		expect(setKeys()).toEqual(["c1"]);
	});
});

/* The claim the session took with claim-issue.js, recorded in the sandbox's
 * store as the hook will read it. */
const claim = (issue: number) => {
	const saved = process.env;
	process.env = sandboxEnv();
	try {
		require_("./lib/arbiter-issue-claims.js").claimIssue(issue, {
			sessionId: sid,
		});
	} finally {
		process.env = saved;
	}
};
const stateFile = (issue: number) =>
	path.join(dir, ".claude", "tmp", "build-state", `${issue}.json`);
const writeStateFile = (issue: number) => {
	fs.mkdirSync(path.dirname(stateFile(issue)), { recursive: true });
	fs.writeFileSync(stateFile(issue), "{}");
};
/** What the model is told at the `n`th autocompaction. */
const toldAt = (n: number) => {
	writeTranscript([
		...Array.from({ length: n - 1 }, (_, i) => boundary(`c${i}`)),
		usage,
	]);
	preCompact("auto");
	return afterCompact();
};

describe("what to do next, by count and build state file (#4410)", () => {
	it.each([1, 9])(
		"at %i, re-reads the state file, the issue and git, and carries on",
		(n) => {
			claim(77);
			writeStateFile(77);
			const told = toldAt(n);
			expect(told).toContain(`autocompacted ${n} time${n === 1 ? "" : "s"}.`);
			expect(told).toContain(
				`Re-read the build state file ${stateFile(77)}, issue #77, and \`git log\` and \`git diff\``,
			);
			expect(told).toContain("the summary is only a hint");
			expect(told).toContain(
				"Carry on with the unit in flight, and start no new unit after it.",
			);
			expect(told).not.toContain("backstop");
		},
	);

	it.each([1, 9])(
		"at %i with no state file, re-reads the issue and git alone",
		(n) => {
			claim(77);
			const told = toldAt(n);
			expect(told).toContain("Re-read issue #77, and `git log`");
			expect(told).not.toContain("state file");
		},
	);

	it("names the claimed issue that has a state file over a newer claim without one", () => {
		claim(77);
		writeStateFile(77);
		const t = Date.now();
		while (Date.now() <= t + 1);
		claim(78);
		expect(toldAt(1)).toContain(
			`Re-read the build state file ${stateFile(77)}, issue #77,`,
		);
	});

	it("names the issue generically where the session holds no claim", () => {
		expect(toldAt(1)).toContain("Re-read the issue you are working, and");
	});

	it.each([10, 12])(
		"at %i, hands off at the backstop with the state file",
		(n) => {
			claim(77);
			writeStateFile(77);
			const told = toldAt(n);
			expect(told).toContain(`autocompacted ${n} times.`);
			expect(told).toContain(
				`That is the backstop (10): commit what exists, update the build state file ${stateFile(77)}, comment the unfinished state on issue #77 with a \`**Compactions:** ${n} (session ${sid})\` line, leave it open, and end.`,
			);
			expect(told).not.toContain("Carry on");
		},
	);

	it.each([10, 12])(
		"at %i with no state file, hands off with no state-file step",
		(n) => {
			claim(77);
			const told = toldAt(n);
			expect(told).toContain(
				"commit what exists, comment the unfinished state on issue #77",
			);
			expect(told).not.toContain("state file");
		},
	);

	it("stays silent on a manual compaction at the backstop", () => {
		claim(77);
		writeStateFile(77);
		writeTranscript([
			...Array.from({ length: 11 }, (_, i) => boundary(`c${i}`)),
			usage,
		]);
		preCompact("manual");
		expect(afterCompact()).toBe("");
	});
});

describe("silence", () => {
	it("is kept after a manual /compact, which adds nothing to the set", () => {
		writeTranscript([boundary("c1"), usage]);
		preCompact("manual");
		expect(afterCompact()).toBe("");
		expect(fs.existsSync(compactionSet())).toBe(false);
	});

	it("is kept after a manual /compact whose PreCompact overwrote an unfinished auto one's trigger", () => {
		writeTranscript([usage]);
		preCompact("auto");
		preCompact("manual");
		expect(afterCompact()).toBe("");
	});

	it("is kept on a startup source, even with an auto trigger left behind", () => {
		writeTranscript([usage]);
		preCompact("auto");
		expect(afterCompact("startup")).toBe("");
		expect(fs.existsSync(compactionSet())).toBe(false);
	});

	it("is kept where no PreCompact ran", () => {
		writeTranscript([usage]);
		expect(afterCompact()).toBe("");
	});

	it("is kept for a subagent's payload", () => {
		writeTranscript([usage]);
		preCompact("auto");
		expect(afterCompact("compact", { agent_id: "a1" })).toBe("");
	});

	it("is kept where the transcript cannot be found", () => {
		preCompact("auto");
		expect(
			exec(HOOK, {
				hook_event_name: "SessionStart",
				source: "compact",
				transcript_path: path.join(dir, "absent.jsonl"),
				session_id: "00000000-0000-0000-0000-000000000000",
			}),
		).toBe("");
	});

	it("is kept on an unparseable payload", () => {
		const r = runInProcess(HOOK, [], {
			stdin: "not json",
			env: { ...process.env, WFC_REPO_ROOT: dir, CLAUDE_PROJECT_DIR: dir },
		});
		expect([r.status, r.stdout]).toEqual([0, ""]);
	});
});
