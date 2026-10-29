// @vitest-environment node
/*
 * Pins place-new-issue.sh's asks after a `gh issue create`: placement once per
 * prompt, a type or `takes:` label for every issue, silence where it cannot
 * tell, and never a block (mantahostels#136, mantahostels#314).
 *
 * The hook is driven exactly as Claude Code drives it: a PostToolUse payload on
 * stdin, its output read back as the injected additionalContext. `gh` is stubbed
 * at WFC_GH.
 *
 * The fixture is the real miss (mantahostels#136): a session working mantahostels#130 — itself a
 * `wayfinder:task` child of the mantahostels#96 map — runs `gh issue create` and the new
 * issue lands unlabelled.
 *
 * TMPDIR is redirected per test because the hook rate-limits itself to one
 * injection per prompt with a marker file there; sharing it would make each test
 * depend on the order of the ones before it.
 *
 * It runs as a PostToolUse hook in `.claude/settings.json` on every Bash call:
 * loosen a case and an ad-hoc issue lands unplaced and unlabelled, routing to
 * nobody, or the hook nags on every call or blocks one.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stubGhScript } from "./lib/gh-stub";

const HOOK = path.resolve(__dirname, "place-new-issue.sh");

let dir: string;

interface IssueView {
	title?: string;
	labels?: string[];
}

/**
 * Stub `gh issue view <n> --json …`, one fixture per issue number. An issue
 * absent from the map makes the stub exit non-zero — the "gh cannot answer" path.
 */
const stubGh = (views: Record<number, IssueView>) => {
	for (const [n, v] of Object.entries(views))
		fs.writeFileSync(
			path.join(dir, `issue-${n}.json`),
			JSON.stringify({
				title: v.title ?? `t${n}`,
				labels: (v.labels ?? []).map((name) => ({ name })),
			}),
		);
	return stubGhScript(
		dir,
		`#!/bin/sh\nf="${dir}/issue-$3.json"\n[ -f "$f" ] || exit 1\ncat "$f"\n`,
	).gh;
};

/** A WFC_GH naming no file, where `command -v` fails. */
const noSuchGh = () => path.join(dir, "no-such-gh");

/** A session named after issue <n>, the way name-issue-session.sh writes it. */
const sessionOn = (n: number | null) => {
	const jobDir = path.join(dir, "job");
	fs.mkdirSync(jobDir, { recursive: true });
	fs.writeFileSync(
		path.join(jobDir, "state.json"),
		JSON.stringify({ name: n === null ? "" : `Issue ${n}: something` }),
	);
	return jobDir;
};

const run = ({
	created = 137,
	command = 'gh issue create --title "x" --body "y"',
	views = {},
	session = 130 as number | null,
	promptId = Math.random().toString(36).slice(2),
	noGh = false,
	env = {},
}: {
	/** An array is one Bash call that created several issues, in that order. */
	created?: number | number[];
	command?: string;
	views?: Record<number, IssueView>;
	session?: number | null;
	promptId?: string;
	noGh?: boolean;
	env?: Record<string, string>;
} = {}) => {
	const gh = noGh ? noSuchGh() : stubGh(views);
	const payload = JSON.stringify({
		tool_name: "Bash",
		tool_input: { command },
		tool_output: (Array.isArray(created) ? created : [created])
			.map((n) => `https://github.com/o/r/issues/${n}`)
			.join("\n"),
		prompt_id: promptId,
		session_id: "sid",
	});
	const r = spawnSync("bash", [HOOK], {
		input: payload,
		encoding: "utf8",
		env: {
			...process.env,
			WFC_GH: gh,
			TMPDIR: dir,
			CLAUDE_JOB_DIR: sessionOn(session),
			...env,
		},
	});
	const stdout = r.stdout ?? "";
	let context = "";
	try {
		context = JSON.parse(stdout).hookSpecificOutput.additionalContext;
	} catch {
		context = "";
	}
	return { status: r.status ?? -1, stdout, context };
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "place-issue-test-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("placement prompt", () => {
	it("asks where the new issue belongs, naming the session's issue", () => {
		const r = run({ views: { 137: {}, 130: { labels: ["wayfinder:task"] } } });
		expect(r.status).toBe(0);
		expect(r.context).toContain("#137");
		expect(r.context).toContain("#130");
		expect(r.context).toContain("link-sub-issue.sh");
	});

	it("reads an interactive session's name from CLAUDE_CONFIG_DIR's registry, not $HOME/.claude's (#2095)", () => {
		const sessions = path.join(dir, "config", "sessions");
		fs.mkdirSync(sessions, { recursive: true });
		fs.writeFileSync(
			path.join(sessions, "12345.json"),
			JSON.stringify({ sessionId: "sid", name: "Issue 130: something" }),
		);
		const r = run({
			views: { 137: {}, 130: { labels: ["wayfinder:task"] } },
			env: {
				CLAUDE_JOB_DIR: path.join(dir, "no-job"),
				CLAUDE_CONFIG_DIR: path.join(dir, "config"),
				HOME: path.join(dir, "home"),
			},
		});
		expect(r.context).toContain("#130");
	});

	it("injects nothing on a command that is not `gh issue create`", () => {
		const r = run({ command: "grep -r 'gh issue create' scripts/" });
		expect(r.stdout.trim()).toBe("");
	});

	it("puts the placement question only once per prompt", () => {
		const promptId = "same-prompt";
		const views = { 137: {}, 138: {}, 130: { labels: ["wayfinder:task"] } };
		expect(run({ promptId, created: 137, views }).context).toContain(
			"Place it before anything else",
		);
		expect(run({ promptId, created: 138, views }).context).not.toContain(
			"Place it before anything else",
		);
	});

	it("names the first issue of a multi-issue call as the one to place", () => {
		const r = run({ created: [137, 138], views: { 137: {}, 138: {} } });
		expect(r.context).toContain("You created #137");
		expect(r.context).not.toContain("You created #138");
	});
});

describe("takes: is asked per issue, not per prompt", () => {
	it("asks for the second issue created in the same prompt", () => {
		const promptId = "batch-prompt";
		const views = { 137: {}, 138: {}, 130: { labels: ["wayfinder:task"] } };
		expect(run({ promptId, created: 137, views }).context).toContain(
			"#137 carries no takes:",
		);
		const second = run({ promptId, created: 138, views });
		expect(second.context).toContain("#138 carries no takes:");
	});

	it("asks for every issue when one call created several", () => {
		const r = run({ created: [137, 138], views: { 137: {}, 138: {} } });
		expect(r.context).toContain("#137 carries no takes:");
		expect(r.context).toContain("#138 carries no takes:");
	});

	it("stays silent on a later call whose issue is already labelled", () => {
		const promptId = "quiet-prompt";
		const views = { 137: {}, 138: { labels: ["takes:implement"] } };
		run({ promptId, created: 137, views });
		expect(run({ promptId, created: 138, views }).stdout.trim()).toBe("");
	});

	/*
	 * The cap bounds gh calls, not the asks: an issue it did not look up is still
	 * named rather than dropped.
	 */
	it("names issues past the lookup cap without claiming to know their labels", () => {
		const r = run({
			created: [137, 138, 139, 140, 141],
			views: { 137: {}, 138: {}, 139: {}, 140: {}, 141: {} },
		});
		expect(r.context).toContain("#137 carries no takes:");
		expect(r.context).toContain("Also created by this call: #139, #140, #141");
	});

	/*
	 * `gh issue create && gh issue comment 900` puts a comment permalink in the
	 * same output. Collecting every `/issues/N` match reads that as a second
	 * issue this call created, and nags for a label on an issue it did not touch.
	 */
	it("ignores a comment permalink in the same output", () => {
		const gh = stubGh({ 137: {}, 900: {} });
		const payload = JSON.stringify({
			tool_name: "Bash",
			tool_input: { command: "gh issue create -t x && gh issue comment 900" },
			tool_output:
				"https://github.com/o/r/issues/137\nhttps://github.com/o/r/issues/900#issuecomment-3182746",
			prompt_id: "permalink",
			session_id: "sid",
		});
		const r = spawnSync("bash", [HOOK], {
			input: payload,
			encoding: "utf8",
			env: {
				...process.env,
				WFC_GH: gh,
				TMPDIR: dir,
				CLAUDE_JOB_DIR: sessionOn(130),
			},
		});
		const context = JSON.parse(r.stdout ?? "{}").hookSpecificOutput
			.additionalContext;
		expect(context).toContain("#137 carries no takes:");
		expect(context).not.toContain("#900");
	});
});

describe("label prompt", () => {
	it("asks for a wayfinder:<type> when the session's issue sits under a map", () => {
		const r = run({ views: { 137: {}, 130: { labels: ["wayfinder:task"] } } });
		expect(r.context).toContain("wayfinder:<type>");
		expect(r.context).toContain("gh issue edit 137 --add-label");
	});

	it("asks for kind:ticket when the session's issue is a spec", () => {
		const r = run({ views: { 137: {}, 130: { labels: ["kind:spec"] } } });
		expect(r.context).toContain("kind:ticket");
		expect(r.context).not.toContain("wayfinder:<type>");
	});

	// A child of a ticket is not itself required to be one.
	it("stays silent when the session's issue is itself a kind:ticket", () => {
		const r = run({ views: { 137: {}, 130: { labels: ["kind:ticket"] } } });
		expect(r.context).not.toContain("carries no label");
	});

	/*
	 * The family is decided before the already-labelled check, so a label from
	 * the wrong family does not count as an answer.
	 */
	it("still asks for a type when the new issue carries only a kind: label", () => {
		const r = run({
			views: {
				137: { labels: ["kind:ticket"] },
				130: { labels: ["wayfinder:task"] },
			},
		});
		expect(r.context).toContain("wayfinder:<type>");
	});

	it("stays silent on a brief filed under a map, which takes no type (#578)", () => {
		const r = run({
			views: {
				137: { labels: ["kind:brief"] },
				130: { labels: ["wayfinder:map"] },
			},
		});
		expect(r.context).not.toContain("wayfinder:<type>");
	});

	it("stays silent when the new issue was created with a label", () => {
		const r = run({
			views: {
				137: { labels: ["wayfinder:grilling"] },
				130: { labels: ["wayfinder:task"] },
			},
		});
		expect(r.context).toContain("#137"); // placement still asked
		expect(r.context).not.toContain("carries no label");
	});

	// A roadmap card's issue takes no kind: and no wayfinder: type.
	it("stays silent on a `<card-id> — ` title", () => {
		const r = run({
			views: {
				137: { title: "id-match — Build the hostel ID-matching layer" },
				130: { labels: ["wayfinder:task"] },
			},
		});
		expect(r.context).not.toContain("carries no label");
	});

	it("stays silent when the session's issue fixes no family", () => {
		const r = run({ views: { 137: {}, 130: { labels: ["Tech & Stack"] } } });
		expect(r.context).not.toContain("carries no label");
	});

	it("stays silent when there is no session issue to infer from", () => {
		const r = run({ session: null, views: { 137: {} } });
		expect(r.context).toContain("#137");
		expect(r.context).not.toContain("carries no label");
	});

	/*
	 * gh unreachable must not read as "you forgot a label" — the hook never
	 * looked.
	 */
	it("stays silent on the label when gh cannot answer", () => {
		const r = run({ views: {} });
		expect(r.status).toBe(0);
		expect(r.context).toContain("#137");
		expect(r.context).not.toContain("carries no label");
	});
});

/*
 * The takes: ask is unconditional — an issue born outside a map needs one as
 * much as one born inside it, which is the gap the wayfinder:/kind: prompts
 * above leave open.
 */
describe("takes: prompt", () => {
	it("asks for a takes: when the session's issue fixes no family", () => {
		const r = run({ views: { 137: {}, 130: { labels: ["Tech & Stack"] } } });
		expect(r.context).toContain("carries no takes: label");
		expect(r.context).toContain("gh issue edit 137 --add-label takes:<value>");
	});

	it("asks for a takes: when there is no session issue at all", () => {
		const r = run({ session: null, views: { 137: {} } });
		expect(r.context).toContain("carries no takes: label");
	});

	/*
	 * An ask that omits a value sends the reader to a set that does not cover
	 * their issue. The set itself is owned by docs/agents/triage-labels.md
	 * §`takes:`.
	 */
	it("names every takes: value the reader may pick", () => {
		const r = run({ views: { 137: {} } });
		for (const v of [
			"takes:wayfinder",
			"takes:to-spec",
			"takes:to-tickets",
			"takes:implement",
			"takes:triage",
			"takes:human",
			"takes:children",
		])
			expect(r.context).toContain(v);
	});

	it("stays silent when the new issue already carries one", () => {
		const r = run({ views: { 137: { labels: ["takes:implement"] } } });
		expect(r.context).toContain("#137"); // placement still asked
		expect(r.context).not.toContain("carries no takes: label");
	});

	it("asks conditionally, not accusingly, when gh cannot answer", () => {
		const r = run({ views: {} });
		expect(r.context).toContain("If #137 carries no takes: label yet");
	});

	it("never blocks the call", () => {
		expect(run({ views: { 137: {} } }).status).toBe(0);
	});

	it("still asks, and does not error, with no gh at all", () => {
		const r = run({ views: { 137: {} }, noGh: true });
		expect(r.status).toBe(0);
		expect(r.context).toContain("If #137 carries no takes: label yet");
	});
});

describe("a backgrounded create, whose output carries no issue number", () => {
	/** Drives the hook with an arbitrary tool_output, which `run` cannot express. */
	const runWithOutput = (command: string, toolOutput: string) => {
		const gh = stubGh({});
		const r = spawnSync("bash", [HOOK], {
			input: JSON.stringify({
				tool_name: "Bash",
				tool_input: { command },
				tool_output: toolOutput,
				prompt_id: Math.random().toString(36).slice(2),
				session_id: "sid",
			}),
			encoding: "utf8",
			env: {
				...process.env,
				WFC_GH: gh,
				TMPDIR: dir,
				CLAUDE_JOB_DIR: sessionOn(130),
			},
		});
		const stdout = r.stdout ?? "";
		let context = "";
		try {
			context = JSON.parse(stdout).hookSpecificOutput.additionalContext;
		} catch {
			context = "";
		}
		return { status: r.status ?? -1, stdout, context };
	};

	/** The verbatim tool_result the harness returns for a backgrounded call. */
	const jobStub =
		"Command running in background with ID: bzyjmqn6o. Output is being written to: /tmp/claude-1000/x/tasks/bzyjmqn6o.output. You will be notified when it completes.";

	/** The real mantahostels#442 command. */
	const backgroundedCreate =
		'cat "$CLAUDE_JOB_DIR/tmp/pre.md" | gh issue create --repo o/r --title "t" --body-file - --assignee @me 2>&1 | tail -3';

	it("asks for a takes: label even though it cannot name the issue", () => {
		const r = runWithOutput(backgroundedCreate, jobStub);
		expect(r.status).toBe(0);
		expect(r.context).toContain("takes:");
		expect(r.context).toContain("cannot see which issue it made");
	});

	it("asks for placement too, which was lost in the same silence", () => {
		const r = runWithOutput(backgroundedCreate, jobStub);
		expect(r.context).toContain("link-sub-issue.sh");
		expect(r.context).toContain("sits outside every map");
	});

	it("offers every takes: value, since it cannot infer one either", () => {
		const r = runWithOutput(backgroundedCreate, jobStub);
		for (const v of [
			"takes:wayfinder",
			"takes:to-spec",
			"takes:to-tickets",
			"takes:implement",
			"takes:triage",
			"takes:human",
			"takes:children",
		])
			expect(r.context).toContain(v);
	});

	// It has no number, so it must not invent one — a `mantahostels#137` here would send the
	// reader to label an unrelated issue. The emptiness check is what keeps this
	// from passing vacuously on a revert.
	it("names no issue number at all, while still saying something", () => {
		const r = runWithOutput(backgroundedCreate, jobStub);
		expect(r.context).not.toBe("");
		expect(r.context).not.toMatch(/#\d+/);
	});

	it("points at the job output file as where the number is", () => {
		const r = runWithOutput(backgroundedCreate, jobStub);
		expect(r.context).toContain("output file");
	});

	/*
	 * "No number found" now injects, so the command-shape test in front of it is
	 * the only thing keeping the hook quiet on every non-creating Bash call.
	 */
	it("stays silent on a command that creates nothing", () => {
		expect(runWithOutput("ls -la", "a.txt b.txt").stdout.trim()).toBe("");
		expect(runWithOutput("npm run test", "42 passed").stdout.trim()).toBe("");
	});

	it("stays silent on a command that merely mentions the string", () => {
		const r = runWithOutput(
			"grep -r 'gh issue create' scripts/",
			"scripts/x.sh",
		);
		expect(r.stdout.trim()).toBe("");
	});

	/* Placement obeys ONCE PER PROMPT; the takes: ask does not. */
	it("asks for placement once per prompt, but for a label every time", () => {
		const promptId = "shared-prompt";
		const call = () => {
			const gh = stubGh({});
			const r = spawnSync("bash", [HOOK], {
				input: JSON.stringify({
					tool_name: "Bash",
					tool_input: { command: backgroundedCreate },
					tool_output: jobStub,
					prompt_id: promptId,
					session_id: "sid",
				}),
				encoding: "utf8",
				env: {
					...process.env,
					WFC_GH: gh,
					TMPDIR: dir,
					CLAUDE_JOB_DIR: sessionOn(130),
				},
			});
			try {
				return JSON.parse(r.stdout ?? "").hookSpecificOutput.additionalContext;
			} catch {
				return "";
			}
		};
		const first = call();
		expect(first).toContain("Place it too");
		expect(first).toContain("takes:");

		const second = call();
		expect(second).not.toContain("Place it too");
		expect(second).toContain("takes:");
	});

	/*
	 * A create that failed, and `--help`, both yield no issue URL too, and
	 * nagging there sends the reader after a number that was never minted. The
	 * job stub is the discriminator.
	 */
	it("stays silent on a create that failed rather than backgrounded", () => {
		const r = runWithOutput(
			'gh issue create --title "x" --body "y"',
			"error fetching labels: non-200 OK status code: 503 Service Unavailable",
		);
		expect(r.stdout.trim()).toBe("");
	});

	it("stays silent on `gh issue create --help`", () => {
		const r = runWithOutput(
			"gh issue create --help",
			"Create an issue on GitHub.\n\nUSAGE\n  gh issue create [flags]",
		);
		expect(r.stdout.trim()).toBe("");
	});

	it("still names the number when the output does carry one", () => {
		const r = runWithOutput(
			backgroundedCreate,
			"https://github.com/o/r/issues/137",
		);
		expect(r.context).toContain("#137");
		expect(r.context).not.toContain("cannot see which issue it made");
	});
});

describe("in a plugin install (#1010)", () => {
	it("names the link script and the tracker rules at the plugin root", () => {
		const core = path.join(dir, "core");
		fs.mkdirSync(path.join(core, "scripts"), { recursive: true });
		fs.mkdirSync(path.join(core, "docs", "agents"), { recursive: true });
		fs.writeFileSync(path.join(core, "scripts", "link-sub-issue.sh"), "");
		fs.writeFileSync(path.join(core, "docs", "agents", "issue-tracker.md"), "");
		const r = run({ env: { WFC_SCRIPT_ROOT: core } });
		expect(r.context).toContain(`${core}/scripts/link-sub-issue.sh <parent>`);
		expect(r.context).toContain(`Rules: ${core}/docs/agents/issue-tracker.md`);
	});

	it("leaves a checkout's text as it was", () => {
		const r = run();
		expect(r.context).toContain("To link: scripts/link-sub-issue.sh <parent>");
		expect(r.context).toContain("Rules: docs/agents/issue-tracker.md");
	});
});
