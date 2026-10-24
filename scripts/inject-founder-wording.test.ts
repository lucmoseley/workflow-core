// @vitest-environment node
/*
 * inject-founder-wording.sh hands a session a pattern's text — the recurrence
 * checks or the plain-words re-pitch — when the founder's prompt matches its
 * wording or the session loads its skill, and stays silent otherwise (spec
 * #628, #514, #642).
 *
 * Every prompt below is a paraphrase, never the founder's own words (#496).
 *
 * The real hook is spawned against a throwaway git host with its own config
 * dir, so a fail-open never reaches the founder's own log. The Skill route's
 * latch lives under the per-test host, so each test starts
 * unlatched and its session ids matter only within it (#516).
 *
 * The hook runs on `UserPromptSubmit` and on `PreToolUse` for Skill in
 * .claude/settings.json: break a case here and a returning fault is diagnosed
 * from scratch without the earlier fix, or the hook fires on a subagent report
 * that merely quotes its phrases (#652).
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installLib } from "./lib/lib-install-testkit";

const HOOK = path.resolve(__dirname, "inject-founder-wording.sh");
const SKILLS = path.resolve(__dirname, "../.claude/skills");
const require_ = createRequire(import.meta.url);
const { errorLog } = require_("./lib/arbiter-store.js");
const { CONTRACT, UPSTREAM_TRACKER } = require_(
	"./lib/workflow-core-config.js",
);

let host: string;
let config: string;

beforeEach(() => {
	host = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "recur-")));
	config = fs.mkdtempSync(path.join(os.tmpdir(), "recur-config-"));
	execFileSync("git", ["init", "-q", host]);
});

afterEach(() => {
	fs.rmSync(host, { recursive: true, force: true });
	fs.rmSync(config, { recursive: true, force: true });
});

const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
	...process.env,
	CLAUDE_PROJECT_DIR: host,
	// A fail-open is written under CLAUDE_CONFIG_DIR; unset, a test run appends
	// to the founder's own log.
	CLAUDE_CONFIG_DIR: config,
	...extra,
});

function declare(body: Record<string, unknown>) {
	fs.mkdirSync(path.join(host, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(host, ".claude/workflow-core.json"),
		JSON.stringify(body),
	);
}

function run(
	input: string,
	extraEnv: NodeJS.ProcessEnv = {},
	bash = "bash",
	hook = HOOK,
) {
	const r = spawnSync(bash, [hook], {
		input,
		encoding: "utf8",
		env: env(extraEnv),
	});
	return { status: r.status, out: r.stdout ?? "" };
}

/** The injected context, or undefined where the hook printed nothing. */
function injected(prompt: string, hook = HOOK): string | undefined {
	const { status, out } = run(
		JSON.stringify({
			session_id: "s1",
			hook_event_name: "UserPromptSubmit",
			prompt,
		}),
		{},
		"bash",
		hook,
	);
	expect(status).toBe(0);
	if (out.trim() === "") return;
	const parsed = JSON.parse(out).hookSpecificOutput;
	expect(parsed.hookEventName).toBe("UserPromptSubmit");
	expect(parsed.permissionDecision).toBeUndefined();
	return parsed.additionalContext;
}

const logLines = () => {
	const saved = { ...process.env };
	process.env.CLAUDE_CONFIG_DIR = config;
	process.env.CLAUDE_PROJECT_DIR = host;
	try {
		const at = errorLog();
		return fs.existsSync(at) ? fs.readFileSync(at, "utf8") : "";
	} finally {
		process.env = saved;
	}
};

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
		expect(injected(prompt)).toContain("A FAULT BELIEVED FIXED MAY BE BACK");
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
		execFileSync("git", [
			"-C",
			host,
			"remote",
			"add",
			"origin",
			"git@github.com:owner/hostel.git",
		]);
		declare({});
		const text = injected("second time this week");
		expect(text).toContain(`(\`owner/hostel\`, \`${UPSTREAM_TRACKER}\`)`);
		expect(text).not.toContain("`corpus`");
	});

	it("names the `corpus` key where no own tracker resolves", () => {
		declare({});
		const text = injected("second time this week");
		expect(text).toContain(`\`${UPSTREAM_TRACKER}\``);
		expect(text).toContain("declare `corpus`");
	});

	it("names no missing own tracker where a rejected corpus falls back to own + upstream", () => {
		execFileSync("git", [
			"-C",
			host,
			"remote",
			"add",
			"origin",
			"git@github.com:owner/hostel.git",
		]);
		declare({ corpus: "owner/x" });
		const text = injected("second time this week");
		expect(text).toContain(`(\`owner/hostel\`, \`${UPSTREAM_TRACKER}\`)`);
		expect(text).not.toContain("`corpus`");
	});

	it("names an unreadable config, and no tracker, and records it", () => {
		fs.mkdirSync(path.join(host, ".claude"), { recursive: true });
		fs.writeFileSync(path.join(host, ".claude/workflow-core.json"), "{ nope");
		const text = injected("second time this week");
		expect(text).toContain("`.claude/workflow-core.json` does not read");
		expect(logLines()).toMatch(/corpus route could not read the config/);
	});

	it("names the `corpus` key, and no tracker, where none resolves", () => {
		declare({ corpus: [] });
		const text = injected("second time this week");
		expect(text).toContain("none resolves here — declare `corpus`");
		expect(text).not.toContain("@CORPUS@");
	});
});

const PREFIX =
	"Applies only if this fault, or one like it, was fixed or ticketed before; otherwise ignore.";

/** The context a Skill load injects, or undefined where the hook printed nothing. */
function skillInjected(
	skill: string,
	session = "s1",
	hook = HOOK,
): string | undefined {
	const { status, out } = run(
		JSON.stringify({
			session_id: session,
			hook_event_name: "PreToolUse",
			tool_name: "Skill",
			tool_input: { skill },
		}),
		{},
		"bash",
		hook,
	);
	expect(status).toBe(0);
	if (out.trim() === "") return;
	const parsed = JSON.parse(out).hookSpecificOutput;
	expect(parsed.hookEventName).toBe("PreToolUse");
	expect(parsed.permissionDecision).toBeUndefined();
	return parsed.additionalContext;
}

describe("loading the `diagnosing-bugs` skill", () => {
	it("fires with the conditional prefix above the check text", () => {
		const text = skillInjected("diagnosing-bugs");
		expect(text?.split("\n")[0]).toBe(PREFIX);
		expect(text).toContain("A FAULT BELIEVED FIXED MAY BE BACK");
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
		["tdd"],
	])("is silent on %s", (skill) => {
		expect(skillInjected(skill)).toBeUndefined();
	});

	it("emits the same fragment as the prompt route, below the prefix", () => {
		const prompt = injected("second time this week");
		expect(skillInjected("diagnosing-bugs")).toBe(`${PREFIX}\n${prompt}`);
	});
});

const FRAMING =
	"The founder's message asks for a simpler re-pitch of your last reply (`/wait-what`, fired by their wording). Apply this before anything else:";

const skillBody = () =>
	fs
		.readFileSync(
			path.resolve(__dirname, "../.claude/skills/wait-what/SKILL.md"),
			"utf8",
		)
		.replace(/^---\n[\s\S]*?\n---\n/, "")
		.trim();

describe("the re-pitch pattern", () => {
	it.each([
		["could you put that in simpler terms"],
		["say it again, simple and concise"],
		["rewrite it in simple English please"],
		["give it to me in concise language"],
		["no jargon this time"],
		["plain and simple English, please"],
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
		expect(injected(prompt)).toBe(`${FRAMING}\n${skillBody()}`);
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

	it("reads the skill beside a plugin install's copy of the hook", () => {
		expect(injected("simpler please", hookCopy())).toBe(
			`${FRAMING}\n${skillBody()}`,
		);
	});

	it("joins both texts in one envelope, recurrence first", () => {
		const text = injected("second time this broke — explain it simpler");
		const recurrence = injected("second time this broke");
		expect(text).toBe(`${recurrence}\n\n${FRAMING}\n${skillBody()}`);
	});

	it("records a missing skill file and still emits a recurrence match", () => {
		const hook = hookCopy({ skills: false });
		expect(injected("simpler please", hook)).toBeUndefined();
		const text = injected("second time this broke — explain it simpler", hook);
		expect(text).toContain("A FAULT BELIEVED FIXED MAY BE BACK");
		expect(text).not.toContain(FRAMING);
		expect(logLines()).toMatch(/wait-what skill file unreadable/);
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

	// The hook mirrors lib/tool-calls-since.js's HARNESS_TEXT and
	// lib/transcript.js's STOP_FEEDBACK; a frame added there and not here
	// fails this.
	it("stays silent on every frame the transcript reader treats as the harness's", () => {
		const read = (lib: string) =>
			fs.readFileSync(path.resolve(__dirname, lib), "utf8");
		const frames = read("lib/tool-calls-since.js").match(
			/HARNESS_TEXT =\s*\/\^\\s\*\(\?:([^)]*)\)\//,
		)?.[1];
		const stop = read("lib/transcript.js").match(
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

describe("a host listing the hook under `disabled`", () => {
	it.each([
		["the prompt route", () => injected("second time this week")],
		["the re-pitch pattern", () => injected("simpler please")],
		["the Skill route", () => skillInjected("diagnosing-bugs")],
	])("gets nothing on %s", (_route, fire) => {
		declare({ contract: CONTRACT, disabled: ["inject-founder-wording.sh"] });
		expect(fire()).toBeUndefined();
	});

	it("still fires where the list names another hook", () => {
		declare({ contract: CONTRACT, disabled: ["guard-branch.sh"] });
		expect(skillInjected("diagnosing-bugs")).toContain(PREFIX);
	});
});

/**
 * A copy of the hook laid out as a plugin install: lib/ linking every file but
 * `omitLib`, the rules store rule-text.sh finds two levels up, and the skills
 * directory unless `skills` is false.
 */
function hookCopy({ omitLib = "", skills = true } = {}): string {
	const at = fs.mkdtempSync(path.join(config, "copy-"));
	installLib(path.join(at, "scripts/lib"), {
		keep: (f) => f !== omitLib,
		link: true,
	});
	fs.mkdirSync(path.join(at, "docs/agents"), { recursive: true });
	fs.symlinkSync(
		path.resolve(__dirname, "../docs/agents/rules"),
		path.join(at, "docs/agents/rules"),
	);
	if (skills) {
		fs.mkdirSync(path.join(at, ".claude"));
		fs.symlinkSync(SKILLS, path.join(at, ".claude/skills"));
	}
	const hook = path.join(at, "scripts/inject-founder-wording.sh");
	fs.copyFileSync(HOOK, hook);
	return hook;
}

it("injects the Skill route unlatched, on the record, where lib/guard-parse.sh does not load", () => {
	const hook = hookCopy({ omitLib: "guard-parse.sh" });
	expect(skillInjected("diagnosing-bugs", "s1", hook)).toContain(PREFIX);
	expect(skillInjected("diagnosing-bugs", "s1", hook)).toContain(PREFIX);
	expect(logLines()).toMatch(/guard-parse\.sh did not load/);
});

describe("fails open, silently and on the record, on", () => {
	it.each([
		["an empty payload", "", /empty payload/],
		["a non-JSON payload", "not json at all", /did not parse as JSON/],
		["a malformed payload", '{"prompt": "second time', /did not parse/],
		["a payload with no prompt", '{"session_id":"s1"}', /no prompt/],
	])("%s", (_name, input, record) => {
		expect(run(input)).toEqual({ status: 0, out: "" });
		expect(logLines()).toMatch(record);
	});

	it("a missing jq, exiting 0 with nothing printed", () => {
		// A PATH holding what the hook reaches for before jq, and not jq.
		const bin = path.join(config, "bin");
		fs.mkdirSync(bin);
		for (const tool of ["dirname", "cat", "mkdir"]) {
			const at = execFileSync("bash", ["-c", `command -v ${tool}`], {
				encoding: "utf8",
			}).trim();
			fs.symlinkSync(at, path.join(bin, tool));
		}
		const bash = execFileSync("bash", ["-c", "command -v bash"], {
			encoding: "utf8",
		}).trim();
		const input = JSON.stringify({ prompt: "second time this week" });
		expect(run(input, { PATH: bin }, bash)).toEqual({ status: 0, out: "" });
		expect(logLines()).toMatch(/jq not found/);
	});
});
