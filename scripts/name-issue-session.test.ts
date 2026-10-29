// @vitest-environment node
/*
 * name-issue-session.sh names a session after the work it was opened on, so a
 * screenful of parallel background jobs can be told apart without opening each
 * one (mantahostels#998).
 *
 * The guarantee that matters most is not the format but that the format
 * survives a hook killed on its deadline (mantahostels#998), so that case is driven with a
 * `gh` that never returns.
 *
 * Every case supplies its own `gh` at WFC_GH: these must never reach the network,
 * and a test that silently depended on the founder's live issue titles would
 * change its own expectations whenever an issue was retitled.
 *
 * The script runs as a `SessionStart` and `UserPromptSubmit` hook in
 * `.claude/settings.json`: loosen a case and parallel jobs launched together
 * come up unnamed or misnamed, with nothing else to report it.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HOOK = path.resolve(__dirname, "name-issue-session.sh");
const { compactPayloads, compactTranscripts, SUBAGENT_JUST_COMPACTED } =
	require("./lib/compact-payload-fixture") as typeof import("./lib/compact-payload-fixture.js");
const TITLE = "seed-listings — measure first-party source coverage";

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "name-session-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/** A `gh` stub, for WFC_GH. `mode: "slow"` never returns, standing in for the
 * loaded machine that provoked the timeout; `"fail"` is an unauthenticated or
 * deleted-issue lookup.
 *
 * The stub records its own argv: the title is fetched for exactly one of the
 * issues given, and a stub answering every number identically would let
 * `titled by the last` pass the test named for `titled by the first`. */
function stubGh(mode: "ok" | "slow" | "fail"): string {
	const bin = path.join(dir, "bin");
	fs.mkdirSync(bin, { recursive: true });
	const bodies: Record<typeof mode, string> = {
		ok: `printf '%s\\n' ${JSON.stringify(TITLE)}`,
		slow: "sleep 120",
		fail: "exit 1",
	};
	const body = bodies[mode];
	const gh = path.join(bin, "gh");
	fs.writeFileSync(
		gh,
		`#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(argvLog())}\n${body}\n`,
		{ mode: 0o755 },
	);
	return gh;
}

function argvLog(): string {
	return path.join(dir, "gh-argv.log");
}

/** Every argument line the gh stub was called with, in order. */
function ghCalls(): string[] {
	if (!fs.existsSync(argvLog())) return [];
	return fs.readFileSync(argvLog(), "utf8").trim().split("\n").filter(Boolean);
}

interface Run {
	/** The name left on the job record, or undefined if it was never renamed. */
	name?: string;
	nameSource?: string;
	/** The hook must ALWAYS exit 0 — a non-zero exit blocks the prompt. */
	status: number | null;
	stdout: string;
}

/** Run the hook as a background job. `timeoutMs` reproduces the harness killing
 * the hook on its deadline. */
function runHook(
	prompt: string | null,
	opts: {
		gh?: "ok" | "slow" | "fail";
		timeoutMs?: number;
		intent?: string;
		extra?: Record<string, unknown>;
	} = {},
): Run {
	const jobDir = fs.mkdtempSync(path.join(dir, "job-"));
	fs.writeFileSync(
		path.join(jobDir, "state.json"),
		JSON.stringify({
			state: "working",
			...(opts.intent ? { intent: opts.intent } : {}),
		}),
	);

	const gh = stubGh(opts.gh ?? "ok");
	const payload: Record<string, unknown> = {
		session_id: "s1",
		cwd: process.cwd(),
		...opts.extra,
	};
	if (prompt !== null) payload.prompt = prompt;

	const r = spawnSync("bash", [HOOK], {
		input: JSON.stringify(payload),
		encoding: "utf8",
		env: {
			...process.env,
			WFC_GH: gh,
			CLAUDE_JOB_DIR: jobDir,
			// Never the founder's live registry: a job-write failure would send
			// the interactive branch scanning their real sessions.
			CLAUDE_CONFIG_DIR: path.join(dir, "config"),
		},
		timeout: opts.timeoutMs,
		killSignal: "SIGKILL",
	});

	const state = JSON.parse(
		fs.readFileSync(path.join(jobDir, "state.json"), "utf8"),
	);
	return {
		name: state.name,
		nameSource: state.nameSource,
		status: r.status,
		stdout: r.stdout ?? "",
	};
}

/** The name the hook left, for the cases that only care about that. */
function runJob(
	prompt: string,
	opts: { gh?: "ok" | "slow" | "fail"; timeoutMs?: number } = {},
): string | undefined {
	return runHook(prompt, opts).name;
}

describe("the six commands each get their verb and their issues", () => {
	it.each([
		["/wayfinder 962", `Wayfinder 962: ${TITLE}`],
		["/to-spec 836", `Spec 836: ${TITLE}`],
		["/to-tickets 900", `Tickets 900: ${TITLE}`],
		["/implement 982", `Implement 982: ${TITLE}`],
		["/triage 958", `Triage 958: ${TITLE}`],
	])("%s", (prompt, expected) => {
		expect(runJob(prompt)).toBe(expected);
	});

	it("accepts #n and a full issue URL as the same reference", () => {
		expect(runJob("/wayfinder #962")).toBe(`Wayfinder 962: ${TITLE}`);
		expect(runJob("/wayfinder https://github.com/owner/repo/issues/962")).toBe(
			`Wayfinder 962: ${TITLE}`,
		);
	});
});

describe("every issue handed to the session is enumerated before the colon", () => {
	it("keeps all of them, in the order given, titled by the first", () => {
		expect(runJob("/implement 969, 973 together")).toBe(
			`Implement 969, 973: ${TITLE}`,
		);
	});

	it("does not drop the leading issues", () => {
		const name = runJob("/implement 851, 901 together");
		expect(name).toContain("851");
		expect(name).toContain("901");
	});

	it("de-duplicates a repeated reference rather than listing it twice", () => {
		expect(runJob("/wayfinder 962, 962, 908")).toBe(
			`Wayfinder 962, 908: ${TITLE}`,
		);
	});
});

describe("/pick-next is named by when it ran", () => {
	it("stamps the time and keeps the goal", () => {
		const name = runJob("/pick-next find more issues to run alongside");
		expect(name).toMatch(
			/^Pick-next: \d{4}-\d{2}-\d{2} \d{2}:\d{2} find more issues to run alongside$/,
		);
	});

	it("stamps the time even with no goal given", () => {
		expect(runJob("/pick-next")).toMatch(
			/^Pick-next: \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
		);
	});

	it("needs no gh at all — it names nothing by an issue", () => {
		expect(runJob("/pick-next", { gh: "fail" })).toMatch(/^Pick-next: /);
	});
});

describe("the name is written before the title is fetched", () => {
	it("survives the hook being killed mid-lookup", () => {
		const name = runJob("/implement 969, 973 together", {
			gh: "slow",
			timeoutMs: 3000,
		});
		expect(name).toBe("Implement 969, 973");
	});

	it("keeps the formatted name when the lookup fails outright", () => {
		expect(runJob("/wayfinder 962", { gh: "fail" })).toBe("Wayfinder 962");
	});

	it("marks the job record as deliberately named, so the auto-namer leaves it", () => {
		const r = runHook("/wayfinder 962", { gh: "slow", timeoutMs: 3000 });
		expect(r.nameSource).toBe("user");
	});
});

describe("the hook never blocks the prompt", () => {
	it.each([
		["names a session", "/wayfinder 962", "ok"],
		["cannot reach gh", "/wayfinder 962", "fail"],
		["is given no issue", "/implement", "ok"],
		["is handed prose", "please look at 962", "ok"],
	])("exits 0 when it %s", (_case, prompt, gh) => {
		expect(runHook(prompt, { gh: gh as "ok" | "fail" }).status).toBe(0);
	});

	it("says the name only as a systemMessage, never as bare stdout", () => {
		// On UserPromptSubmit, plain stdout is injected into the model's context.
		const r = runHook("/wayfinder 962");
		expect(JSON.parse(r.stdout.trim())).toEqual({
			systemMessage: `Session named — Wayfinder 962: ${TITLE}`,
		});
	});

	it("reports a failed title lookup rather than passing it off silently", () => {
		const r = runHook("/wayfinder 962", { gh: "fail" });
		expect(r.stdout).toContain("Wayfinder 962 (title lookup failed)");
	});
});

describe("the title fetched is the first issue's", () => {
	it("looks up only the leading issue, not the last one given", () => {
		runHook("/implement 851, 901 together");
		expect(ghCalls()).toHaveLength(1);
		expect(ghCalls()[0]).toContain("851");
		expect(ghCalls()[0]).not.toContain("901");
	});

	it("routes the lookup to the repo a full URL names", () => {
		runHook("/wayfinder https://github.com/owner/repo/issues/962");
		expect(ghCalls()[0]).toContain("--repo owner/repo");
	});
});

describe("issues are enumerated however the founder separated them", () => {
	it.each([
		["/implement 969, 973 together", "Implement 969, 973"],
		["/implement 969 and 973 together", "Implement 969, 973"],
		["/implement 969 & 973", "Implement 969, 973"],
		["/implement 969 + 973", "Implement 969, 973"],
		["/implement #969, #973", "Implement 969, 973"],
	])("%s", (prompt, stem) => {
		expect(runJob(prompt)).toBe(`${stem}: ${TITLE}`);
	});
});

describe("a reference keeps its ordinary sentence punctuation", () => {
	it("reads an issue followed by a colon", () => {
		expect(runJob("/wayfinder 962: the seeding question")).toBe(
			`Wayfinder 962: ${TITLE}`,
		);
	});

	it("reads a permalink carrying a comment fragment", () => {
		// The form GitHub's "copy link" produces.
		expect(
			runJob(
				"/wayfinder https://github.com/owner/repo/issues/962#issuecomment-5365681768",
			),
		).toBe(`Wayfinder 962: ${TITLE}`);
	});
});

describe("the command is found at a word boundary, not as a substring", () => {
	it("takes the argument after the real command, not after a path", () => {
		expect(runJob("read docs/implement-notes then /implement 851")).toBe(
			`Implement 851: ${TITLE}`,
		);
	});
});

describe("references are read from the front of the argument only", () => {
	it("names nothing when the argument is prose that happens to contain a number", () => {
		expect(
			runJob("/wayfinder I read this in the last 30 days"),
		).toBeUndefined();
	});

	it("names nothing when the command is given no issue at all", () => {
		expect(runJob("/implement")).toBeUndefined();
	});

	it("ignores a prompt that names none of the six commands", () => {
		expect(runJob("please look at issue 962")).toBeUndefined();
	});
});

describe("a resume is named from the job record's intent", () => {
	it("names the session on SessionStart, where no prompt is submitted", () => {
		// This route only fires on a RESUME (mantahostels#998).
		const r = runHook(null, { intent: "/wayfinder 962" });
		expect(r.name).toBe(`Wayfinder 962: ${TITLE}`);
		expect(r.status).toBe(0);
	});
});

// A subagent's compaction fires SessionStart:compact under its parent's
// session id, and would rename the parent from inside the subagent (#1785).
describe("a compaction renames from the job's intent", () => {
	const atCompaction = (
		agentId?: string,
		ages?: { parentAgeS: number; subagentAgesS: number[] },
	) => {
		const { sessionStart } = compactPayloads({
			sessionId: "s1",
			transcriptPath: ages
				? compactTranscripts(dir, { sessionId: "s1", ...ages })
				: path.join(dir, "t.jsonl"),
			cwd: process.cwd(),
			agentId,
		});
		return runHook(null, { intent: "/wayfinder 962", extra: sessionStart });
	};

	it("names the parent from the job's intent after its own compaction", () => {
		expect(atCompaction().name).toBe(`Wayfinder 962: ${TITLE}`);
	});

	it("renames nothing where the payload carries a subagent's agent_id", () => {
		const r = atCompaction("a21cf96dcd1d42038");
		expect([r.name, r.stdout, r.status]).toEqual([undefined, "", 0]);
	});

	// Until the harness sends agent_id there (#1837).
	it("renames nothing where a subagent's transcript is fresher than the parent's stale one", () => {
		const r = atCompaction(undefined, SUBAGENT_JUST_COMPACTED);
		expect([r.name, r.stdout, r.status]).toEqual([undefined, "", 0]);
	});
});

describe("an interactive session is found in the registry CLAUDE_CONFIG_DIR names", () => {
	it("writes to the live registry, not a hard-coded ~/.claude", () => {
		const cfg = path.join(dir, "config");
		const sessions = path.join(cfg, "sessions");
		fs.mkdirSync(sessions, { recursive: true });
		const reg = path.join(sessions, "12345.json");
		fs.writeFileSync(
			reg,
			JSON.stringify({ sessionId: "s1", name: "old", nameSource: "auto" }),
		);

		const env = {
			...process.env,
			WFC_GH: stubGh("ok"),
			CLAUDE_CONFIG_DIR: cfg,
		};
		delete (env as Record<string, string | undefined>).CLAUDE_JOB_DIR;
		spawnSync("bash", [HOOK], {
			input: JSON.stringify({
				session_id: "s1",
				prompt: "/triage 958",
				cwd: process.cwd(),
			}),
			env,
		});

		const written = JSON.parse(fs.readFileSync(reg, "utf8"));
		expect(written.name).toBe(`Triage 958: ${TITLE}`);
		// An absent nameSource is how /rename marks a deliberate name.
		expect(written.nameSource).toBeUndefined();
	});
});

describe("a long title is truncated rather than filling the list column", () => {
	/** Drive the hook with a gh that returns this exact title. */
	function withTitle(title: string, env: Record<string, string> = {}): string {
		const gh = path.join(dir, "gh-long");
		fs.writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' '${title}'\n`, {
			mode: 0o755,
		});
		const jobDir = fs.mkdtempSync(path.join(dir, "job-trunc-"));
		fs.writeFileSync(
			path.join(jobDir, "state.json"),
			JSON.stringify({ state: "working" }),
		);
		spawnSync("bash", [HOOK], {
			input: JSON.stringify({
				session_id: "s1",
				prompt: "/wayfinder 962",
				cwd: process.cwd(),
			}),
			env: {
				...process.env,
				...env,
				WFC_GH: gh,
				CLAUDE_JOB_DIR: jobDir,
				CLAUDE_CONFIG_DIR: path.join(dir, "config"),
			},
		});
		return JSON.parse(fs.readFileSync(path.join(jobDir, "state.json"), "utf8"))
			.name;
	}

	it("caps the name at 90 characters with an ellipsis", () => {
		const name = withTitle("x".repeat(300));
		expect([...name].length).toBe(90);
		expect(name.endsWith("…")).toBe(true);
	});

	it("counts characters, not bytes, even under a byte-oriented locale", () => {
		// Slicing bytes can cut an em dash in half and produce a name that is
		// not valid UTF-8.
		const name = withTitle("—".repeat(300), { LC_ALL: "C" });
		expect([...name].length).toBe(90);
		expect(Buffer.from(name, "utf8").toString("utf8")).toBe(name);
		expect(name.endsWith("…")).toBe(true);
	});
});

/*
 * In an adopter the commands arrive namespaced — `/workflow-core:pick-next`,
 * the spelling Claude Code's menu produces for a plugin command (#201).
 */
describe("the plugin namespace on a command is optional (#201)", () => {
	it.each([
		["/workflow-core:wayfinder 962", `Wayfinder 962: ${TITLE}`],
		["/workflow-core:to-spec 962", `Spec 962: ${TITLE}`],
		["/workflow-core:to-tickets 962", `Tickets 962: ${TITLE}`],
		["/workflow-core:implement 962", `Implement 962: ${TITLE}`],
		["/workflow-core:triage 962", `Triage 962: ${TITLE}`],
	])("names %s as the bare spelling would", (prompt, expected) => {
		expect(runJob(prompt)).toBe(expected);
	});

	it("names a namespaced /pick-next, the invocation that exposed this", () => {
		expect(runJob("/workflow-core:pick-next", { gh: "fail" })).toMatch(
			/^Pick-next: \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
		);
	});

	it("reads the issues after the prefix, not the prefix itself", () => {
		expect(runJob("/workflow-core:implement 17 and 19")).toBe(
			`Implement 17, 19: ${TITLE}`,
		);
	});

	/* `workflow-core` is the PLUGIN's name, set in plugin.json by whoever ships
	 * the plugin, so a hardcoded prefix would fix this repo and no fork. */
	it("accepts any plugin name as the prefix", () => {
		expect(runJob("/my-fork:wayfinder 962")).toBe(`Wayfinder 962: ${TITLE}`);
	});

	/* A background job reads its command off the record's `intent`, not off a
	 * submitted prompt, so a prompt-only case leaves that path uncovered. */
	it("names a background job whose intent carries the namespaced command", () => {
		expect(
			runHook(null, { intent: "/workflow-core:pick-next", gh: "fail" }).name,
		).toMatch(/^Pick-next: \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
	});

	it("still refuses a command that is only part of a longer word", () => {
		expect(runJob("/workflow-core:implementation 962")).toBeUndefined();
	});

	it("still takes the argument after the real command, not after a path", () => {
		expect(runJob("read docs/implement-notes then /implement 851")).toBe(
			`Implement 851: ${TITLE}`,
		);
	});
});
