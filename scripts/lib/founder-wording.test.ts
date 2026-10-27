// @vitest-environment node
/*
 * lib/founder-wording.js hands a session a pattern's text — the recurrence
 * checks or the plain-words re-pitch — when the founder's prompt matches its
 * wording or the session loads its skill, and stays silent otherwise (spec
 * #628, #514, #642).
 *
 * Every prompt below is a paraphrase, never the founder's own words (#496).
 *
 * Module cases, run in process over the production ports
 * (lib/founder-wording-host.js) against a throwaway git host: the prompt
 * route through `decidePrompt`, the Skill route through
 * lib/guard-core-testkit.ts as the dispatcher runs it, its latch under the
 * case's host, and the prompt route's entry, scripts/inject-founder-wording.js,
 * through runInProcess with its own config dir, so a fail-open never reaches
 * the founder's own log. The dispatcher's hook line and stdin are
 * scripts/guard-dispatch.test.ts's boundary set.
 *
 * Break a case here and a returning fault is diagnosed from scratch without
 * the earlier fix, or the guard fires on a subagent report that merely quotes
 * its phrases (#652).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCore } from "./guard-core-testkit";
import { readGuardErrorsLog } from "./guard-errors-log";
import { kitContextFake } from "./kit-context-fake";
import { runInProcess } from "./run-in-process";

const { decidePrompt } = require("./founder-wording.js") as {
	decidePrompt: (
		prompt: string,
		ctx: Record<string, unknown>,
	) => { context: string } | null;
};
const { buildHostPorts } = require("./founder-wording-host.js") as {
	buildHostPorts: (root: string) => {
		corpus: () => { trackers: string[]; ownMissing: boolean };
		skillFile: (name: string) => string | null;
	};
};
const { CONTRACT, UPSTREAM_TRACKER } = require("./workflow-core-config.js");

const ENTRY = path.resolve(__dirname, "../inject-founder-wording.js");
const SKILL_FILE = path.resolve(
	__dirname,
	"../../.claude/skills/wait-what/SKILL.md",
);

let host: string;
let config: string;
let logs: string[];

beforeEach(() => {
	host = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "recur-")));
	config = fs.mkdtempSync(path.join(os.tmpdir(), "recur-config-"));
	execFileSync("git", ["init", "-q", host]);
	logs = [];
});

afterEach(() => {
	fs.rmSync(host, { recursive: true, force: true });
	fs.rmSync(config, { recursive: true, force: true });
});

function declare(body: Record<string, unknown> | string) {
	fs.mkdirSync(path.join(host, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(host, ".claude/workflow-core.json"),
		typeof body === "string" ? body : JSON.stringify(body),
	);
}

const addOrigin = () =>
	execFileSync("git", [
		"-C",
		host,
		"remote",
		"add",
		"origin",
		"git@github.com:owner/hostel.git",
	]);

/** The prompt route's context, or undefined where it says nothing. */
function injected(
	prompt: string,
	ports: Record<string, unknown> = {},
): string | undefined {
	const d = decidePrompt(
		prompt,
		kitContextFake({
			...buildHostPorts(host),
			log: (what: string) => {
				logs.push(what);
			},
			...ports,
		}),
	);
	return d === null ? undefined : d.context;
}

/** The context a Skill load injects, or undefined where the core said nothing. */
function skillInjected(skill: string, session = "s1"): string | undefined {
	const { output, logs: said } = runCore(
		"inject-founder-wording",
		{
			session_id: session,
			hook_event_name: "PreToolUse",
			tool_name: "Skill",
			tool_input: { skill },
		},
		{ root: host },
	);
	logs.push(...said);
	if (output === null) return;
	expect(output.permissionDecision).toBeUndefined();
	return output.additionalContext;
}

/** One run of the prompt route's entry: its exit, its hook output. */
function entry(stdin: string) {
	const r = runInProcess(ENTRY, [], {
		cwd: host,
		stdin,
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: host,
			CLAUDE_CONFIG_DIR: config,
		},
	});
	const out = r.stdout.trim();
	return {
		status: r.status,
		out: out ? JSON.parse(out).hookSpecificOutput : null,
		stderr: r.stderr,
	};
}

const promptPayload = (prompt: string) =>
	JSON.stringify({
		session_id: "s1",
		hook_event_name: "UserPromptSubmit",
		prompt,
	});

const RECURRENCE = "A FAULT BELIEVED FIXED MAY BE BACK";
const PREFIX =
	"Applies only if this fault, or one like it, was fixed or ticketed before; otherwise ignore.";
const FRAMING =
	"The founder's message asks for a simpler re-pitch of your last reply (`/wait-what`, fired by their wording). Apply this before anything else:";

const readSkillBody = () =>
	fs
		.readFileSync(SKILL_FILE, "utf8")
		.replace(/^---\n[\s\S]*?\n---\n/, "")
		.trim();

describe("each phrase family fires on a paraphrased complaint", () => {
	it.each([
		["I thought we'd already solved the stale lock problem"],
		["Thought we had fixed the duplicate comment bug last week"],
		["this is the third time the digest has drifted"],
		["this keeps happening whenever the suite runs"],
		["you made the same mistake with the pathspec"],
		["How many times does the badge need re-rendering?"],
		["I already asked for the header to be trimmed"],
		["we're going in circles on the release note"],
		["still seeing the orphaned claim after the reap"],
	])("%s", (prompt) => {
		expect(injected(prompt)).toContain(RECURRENCE);
	});
});

describe("paraphrased near-misses stay silent", () => {
	it.each([
		["how do we stop the lock going stale again?"],
		["I'm still not ready to decide on the pricing tier"],
		["the perpetual backlog of card edits needs a sweep"],
		["the second-hand timer in the benchmark is off"],
		["hi already told the team"],
		["the deploy is still broken after the rollback"],
	])("%s", (prompt) => {
		expect(injected(prompt)).toBeUndefined();
	});
});

describe("a `/diagnosing-bugs` prompt fires", () => {
	it("fires on the bare and the plugin-qualified command", () => {
		expect(injected("/diagnosing-bugs the flaky arbiter test")).toContain(
			"four checks",
		);
		expect(injected("/workflow-core:diagnosing-bugs")).toContain("four checks");
	});

	it("stays silent where the command is not at the start of the prompt", () => {
		expect(injected("should I run /diagnosing-bugs on this")).toBeUndefined();
	});
});

it("is not latched: two matching prompts in one session both fire", () => {
	expect(injected("second time the badge broke")).toBeDefined();
	expect(injected("the claim guard denial keeps happening")).toBeDefined();
});

describe("the corpus in the text", () => {
	it("names a declared corpus tracker by tracker, in order", () => {
		declare({ corpus: ["z/last", "a/first", "m/middle"] });
		expect(injected("second time this week")).toContain(
			"(`z/last`, `a/first`, `m/middle`)",
		);
	});

	it("falls back to the own tracker plus upstream where undeclared", () => {
		addOrigin();
		declare({});
		const text = injected("second time this week");
		expect(text).toContain(`(\`owner/hostel\`, \`${UPSTREAM_TRACKER}\`)`);
		expect(text).not.toContain("`corpus`");
	});

	it("names the `corpus` key where no own tracker resolves", () => {
		declare({});
		const text = injected("second time this week");
		expect(text).toContain(
			`(\`${UPSTREAM_TRACKER}\`; this repo's own is missing — declare \`corpus\` in \`.claude/workflow-core.json\`)`,
		);
	});

	it("names no missing own tracker where a rejected corpus falls back to own + upstream", () => {
		addOrigin();
		declare({ corpus: "owner/x" });
		const text = injected("second time this week");
		expect(text).toContain(`(\`owner/hostel\`, \`${UPSTREAM_TRACKER}\`)`);
		expect(text).not.toContain("`corpus`");
	});

	it("names an unreadable config, and no tracker, and records it", () => {
		declare("{ nope");
		const text = injected("second time this week");
		expect(text).toContain(
			"(none: `.claude/workflow-core.json` does not read — fix it so `corpus` resolves)",
		);
		expect(logs).toContain(
			"corpus route could not read the config — recurrence checks name no tracker",
		);
	});

	it("names the `corpus` key, and no tracker, where none resolves", () => {
		declare({ corpus: [] });
		const text = injected("second time this week");
		expect(text).toContain(
			"(none resolves here — declare `corpus` in `.claude/workflow-core.json`)",
		);
		expect(text).not.toContain("@CORPUS@");
	});
});

describe("loading the `diagnosing-bugs` skill", () => {
	it("fires with the conditional prefix above the check text", () => {
		const text = skillInjected("diagnosing-bugs");
		expect(text?.split("\n")[0]).toBe(PREFIX);
		expect(text).toContain(RECURRENCE);
	});

	it("fires on the namespace-qualified name", () => {
		expect(skillInjected("workflow-core:diagnosing-bugs")).toContain(PREFIX);
	});

	it("is silent on a second load in the same session, and fires in another", () => {
		expect(skillInjected("diagnosing-bugs")).toBeDefined();
		expect(skillInjected("workflow-core:diagnosing-bugs")).toBeUndefined();
		expect(skillInjected("diagnosing-bugs", "s2")).toBeDefined();
	});

	it.each([
		["code-review"],
		["diagnosing-bugs-extra"],
		["x:diagnosing-bugs:y"],
		["notdiagnosing-bugs"],
		["tdd"],
	])("is silent on %s", (skill) => {
		expect(skillInjected(skill)).toBeUndefined();
	});

	it("emits the same fragment as the prompt route, below the prefix", () => {
		const prompt = injected("second time this week");
		expect(skillInjected("diagnosing-bugs")).toBe(`${PREFIX}\n${prompt}`);
	});
});

describe("the re-pitch pattern", () => {
	it.each([
		["could you put that in simpler terms"],
		["say it again, simple and concise"],
		["rewrite it in simple English please"],
		["give it to me in concise language"],
		["no jargon this time"],
		["plain and simple English, please"],
		["say it in plain English"],
		["the answer is still way too long"],
		["your options are confusing"],
		["the wording is unclear"],
		["I'm not sure what you’re asking"],
		["I don't understand the question"],
		["what are we actually deciding here?"],
		["what exactly do you need from me"],
		["explain again, I missed it"],
		["you're not making any sense"],
		["you've lost me"],
		["can you expand the question"],
		["the trade-off is still not explained"],
	])("fires on %s", (prompt) => {
		expect(injected(prompt)).toBe(`${FRAMING}\n${readSkillBody()}`);
	});

	it.each([
		["the email is long-winded"],
		["that text is full of jargon"],
		["walk me through it in simple steps"],
		["ship the landing page copy"],
		["simplest fix is to drop the column"],
	])("stays silent on %s", (prompt) => {
		expect(injected(prompt)).toBeUndefined();
	});

	it.each([
		["/wait-what"],
		["/wait-what that was confusing, simpler please"],
		["/workflow-core:wait-what simpler"],
	])("stays silent on a prompt starting %s", (prompt) => {
		expect(injected(prompt)).toBeUndefined();
	});

	it("is not latched: two matching prompts in one session both fire", () => {
		expect(injected("simpler please")).toContain(FRAMING);
		expect(injected("you've lost me")).toContain(FRAMING);
	});

	it("reads the skill beside the plugin's own scripts, not the host's tree", () => {
		expect(buildHostPorts(host).skillFile("wait-what")).toBe(
			fs.readFileSync(SKILL_FILE, "utf8"),
		);
		expect(buildHostPorts(host).skillFile("no-such-skill")).toBeNull();
	});

	it("joins both texts in one envelope, recurrence first", () => {
		const text = injected("second time this broke — explain it simpler");
		const recurrence = injected("second time this broke");
		expect(text).toBe(`${recurrence}\n\n${FRAMING}\n${readSkillBody()}`);
	});

	it("records a missing skill file and still emits a recurrence match", () => {
		const missing = { skillFile: () => null };
		expect(injected("simpler please", missing)).toBeUndefined();
		const text = injected(
			"second time this broke — explain it simpler",
			missing,
		);
		expect(text).toContain(RECURRENCE);
		expect(text).not.toContain(FRAMING);
		expect(logs).toContain(
			"wait-what skill file unreadable or empty — re-pitch not injected",
		);
	});

	it("has no Skill route", () => {
		expect(skillInjected("wait-what")).toBeUndefined();
	});
});

describe("a harness-delivered prompt quoting the phrases stays silent (#652)", () => {
	it.each([
		[
			"<task-notification>\n<summary>Command killed: echo 'second time, explain it simpler'</summary>\n</task-notification>",
		],
		// A hand-back as the hook receives it, and as the transcript stores it.
		[
			'<agent-message from="reviewer">\n  The re-pitch fires on "you\'ve lost me" and on "keeps happening".\n</agent-message>',
		],
		[
			'Another Claude session sent a message:\n<agent-message from="reviewer">The re-pitch fires on "you\'ve lost me".</agent-message>',
		],
		["<local-command-stdout>this keeps happening</local-command-stdout>"],
		["<bash-stdout>simpler please</bash-stdout>"],
		["<bash-stderr>second time it failed</bash-stderr>"],
		["Stop hook feedback: the answer is too long"],
	])("stays silent on %s", (prompt) => {
		expect(injected(prompt)).toBeUndefined();
	});

	// The core mirrors lib/tool-calls-since.js's HARNESS_TEXT and
	// lib/transcript.js's STOP_FEEDBACK; a frame added there and not here
	// fails this.
	it("stays silent on every frame the transcript reader treats as the harness's", () => {
		const read = (lib: string) =>
			fs.readFileSync(path.resolve(__dirname, lib), "utf8");
		const frames = read("tool-calls-since.js").match(
			/HARNESS_TEXT =\s*\/\^\\s\*\(\?:([^)]*)\)\//,
		)?.[1];
		const stop = read("transcript.js").match(
			/STOP_FEEDBACK = \/\^\\s\*([^/]*)\//,
		)?.[1];
		expect(frames).toBeDefined();
		expect(stop).toBeDefined();
		for (const frame of [...(frames ?? "").split("|"), stop ?? ""]) {
			expect(injected(`${frame} simpler please`), frame).toBeUndefined();
		}
	});

	it("still fires where the founder's own prompt only mentions a frame", () => {
		expect(
			injected("simpler please — what was that <task-notification> about?"),
		).toContain(FRAMING);
	});
});

describe("the prompt route's entry", () => {
	it("hands the text as UserPromptSubmit additionalContext, on exit 0", () => {
		expect(entry(promptPayload("simpler please"))).toMatchObject({
			status: 0,
			out: {
				hookEventName: "UserPromptSubmit",
				additionalContext: `${FRAMING}\n${readSkillBody()}`,
			},
		});
	});

	it("says nothing on a prompt matching no pattern", () => {
		expect(entry(promptPayload("ship the landing page copy"))).toEqual({
			status: 0,
			out: null,
			stderr: "",
		});
	});

	it("keeps a rejected config value's warning off stderr, reading the default", () => {
		addOrigin();
		declare({ corpus: "owner/x" });
		const r = entry(promptPayload("second time this week"));
		expect(r.out?.additionalContext).toContain("`owner/hostel`");
		expect(r.stderr).toBe("");
	});

	describe("a host listing the guard under `disabled`", () => {
		it.each([
			["the prompt route", "second time this week"],
			["the re-pitch pattern", "simpler please"],
		])("gets nothing on %s", (_route, prompt) => {
			declare({ contract: CONTRACT, disabled: ["inject-founder-wording"] });
			expect(entry(promptPayload(prompt))).toMatchObject({
				status: 0,
				out: null,
			});
		});

		it("still fires where the list names another hook", () => {
			declare({ contract: CONTRACT, disabled: ["guard-branch.sh"] });
			expect(entry(promptPayload("simpler please")).out).not.toBeNull();
		});
	});

	describe("fails open, silently and on the record, on", () => {
		it.each([
			["a non-JSON payload", "not json at all", /did not parse as JSON/],
			["a malformed payload", '{"prompt": "second time', /did not parse/],
			["a payload with no prompt", '{"session_id":"s1"}', /no prompt/],
		])("%s", (_name, input, record) => {
			expect(entry(input)).toMatchObject({ status: 0, out: null });
			expect(readGuardErrorsLog(config)).toMatch(record);
		});

		it("an empty payload, unrecorded", () => {
			expect(entry("")).toMatchObject({ status: 0, out: null });
			expect(readGuardErrorsLog(config)).toBe("");
		});
	});
});

describe("cases a mutant must not survive", () => {
	it("records an unreadable recurrence fragment and still emits the re-pitch", () => {
		const text = injected("second time this broke — explain it simpler", {
			ruleText: () => {
				throw new Error("store broke");
			},
		});
		expect(text).toBe(`${FRAMING}\n${readSkillBody()}`);
		expect(logs).toContain(
			"recurrence-checks fragment unreadable — recurrence checks not injected",
		);
	});

	it("puts the corpus where the fragment's @CORPUS@ stands, once, and a `$&` literally", () => {
		const text = injected("second time", {
			ruleText: () => "before (@CORPUS@) after",
			corpus: () => ({ trackers: ["a/$&"], ownMissing: false }),
		});
		expect(text).toBe("before (`a/$&`) after");
	});

	it("is case-blind on the phrases and the command", () => {
		expect(injected("SIMPLER PLEASE")).toContain(FRAMING);
		expect(injected("/Diagnosing-Bugs now")).toContain(RECURRENCE);
		expect(injected("/WAIT-WHAT simpler")).toBeUndefined();
	});

	it("needs a word boundary before a phrase, not after the frame's leading space", () => {
		expect(injected("unsimpler")).toBeUndefined();
		expect(injected("(simpler)")).toContain(FRAMING);
		expect(injected("   <bash-stdout>simpler</bash-stdout>")).toBeUndefined();
		expect(injected("x <bash-stdout>simpler")).toContain(FRAMING);
	});

	it("reads a command only where whitespace or the end follows it", () => {
		expect(injected("/diagnosing-bugsx")).toBeUndefined();
		expect(injected("  /diagnosing-bugs\nthe arbiter")).toContain(RECURRENCE);
		expect(injected("/wait-whatever simpler")).toContain(FRAMING);
	});

	it("takes a skill file's body after its second fence, trimmed", () => {
		const body = (file: string) =>
			injected("simpler please", { skillFile: () => file });
		expect(body("---\nname: x\n---\n\n  body\nline\n\n")).toBe(
			`${FRAMING}\nbody\nline`,
		);
		for (const empty of [
			"---\nname: x\n---\n \n\n",
			"no fence\n",
			"---\nonly one\n",
		])
			expect(body(empty)).toBeUndefined();
	});

	it("latches the Skill route only once its text is out", () => {
		expect(skillInjected("diagnosing-bugs", "s9")).toBeDefined();
		const marker = fs
			.readdirSync(path.join(host, ".claude"), { recursive: true })
			.map(String)
			.filter((f) => f.includes("warn.recurrence-checks"));
		expect(marker).toHaveLength(1);
	});

	it("leaves the Skill route unlatched where its fragment did not read", () => {
		const store = fs.mkdtempSync(path.join(config, "rules-"));
		const prior = process.env.WFC_RULES_DIR;
		process.env.WFC_RULES_DIR = store;
		try {
			expect(skillInjected("diagnosing-bugs")).toBeUndefined();
		} finally {
			if (prior === undefined) delete process.env.WFC_RULES_DIR;
			else process.env.WFC_RULES_DIR = prior;
		}
		expect(logs).toContain(
			"recurrence-checks fragment unreadable — recurrence checks not injected",
		);
		expect(skillInjected("diagnosing-bugs")).toContain(PREFIX);
	});
});
