// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { initGitRepo } from "./git-fixture";
import { readGuardErrorsLog } from "./guard-errors-log";
import { takesPort, tierPort } from "./inject-tracker-docs-testkit";
import { runInProcess } from "./run-in-process.js";
import { withStubbedEnv } from "./scoped-env-testkit";

const ROOT = path.resolve(__dirname, "..", "..");
const { injectTrackerDocs } =
	require("./inject-tracker-docs.js") as typeof import("./inject-tracker-docs.js");
const { logFailOpen } =
	require("./inject-tracker-docs-host.js") as typeof import("./inject-tracker-docs-host.js");
const { readRuleText } = require("./rule-text") as {
	readRuleText: (id: string) => string;
};
const { compactPayloads } =
	require("./compact-payload-fixture") as typeof import("./compact-payload-fixture.js");
const { TAKES_VALUES } = require("./takes-label") as {
	TAKES_VALUES: string[];
};
const { HOOK_PERSIST_CHARS: PERSIST_CHARS } =
	require("./hook-limits.js") as typeof import("./hook-limits.js");

const { TIGHT_HEADROOM_CHARS } =
	require("./injector-margin.js") as typeof import("./injector-margin.js");

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "inject-hook-state-"));
afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

type Ports = import("./inject-tracker-docs.js").Ports;

const NOW = 1_800_000_000;

const FAKE_PORTS: Ports = {
	takesLabel: () => "",
	reviewTier: () => "",
	now: () => NOW,
	log: logFailOpen,
};

const runRaw = (
	payload: object | string,
	env: Record<string, string> = {},
	ports: Partial<Ports> = {},
): string =>
	withStubbedEnv(
		{
			// #448
			CLAUDE_PROJECT_DIR: ROOT,
			WFC_OUTPUT_STYLE: undefined,
			CLAUDE_CODE_SESSION_ID: "",
			TMPDIR: SCRATCH,
			CLAUDE_CONFIG_DIR: SCRATCH,
			...env,
		},
		() =>
			injectTrackerDocs(
				typeof payload === "string" ? payload : JSON.stringify(payload),
				{ ...FAKE_PORTS, ...ports },
			),
	);

const run = (
	payload: object,
	env: Record<string, string> = {},
	ports: Partial<Ports> = {},
): string => {
	const out = runRaw(payload, env, ports);
	if (out.trim() === "") return "";
	return JSON.parse(out).hookSpecificOutput.additionalContext;
};

const rulesHeader = (ctx: string): string => {
	expect(ctx, "a document has been inlined again").not.toContain("--- BEGIN ");
	return ctx;
};

const inject = (prompt: string, event = "UserPromptSubmit"): string =>
	run({ prompt, hook_event_name: event });

const BARE_HOST = fs.mkdtempSync(path.join(os.tmpdir(), "inject-bare-host-"));
afterAll(() => fs.rmSync(BARE_HOST, { recursive: true, force: true }));
const whole = (prompt: string): string =>
	run(
		{ prompt, hook_event_name: "UserPromptSubmit" },
		{ CLAUDE_PROJECT_DIR: BARE_HOST },
	);

describe("the priced-options rule (mantahostels#186)", () => {
	it("reaches /wayfinder", () => {
		expect(inject("/wayfinder 186")).toContain("PRICED OPTIONS");
	});

	it("carries the founder's literal format, both the band and the lettering", () => {
		const ctx = whole("/wayfinder 186");
		expect(ctx).toContain("Confidence: 70% (60% - 80%).");
		expect(ctx).toContain("(A) <the option, stated in plain words>");
		expect(ctx).toContain("(B) <the next option>");
		expect(ctx).toContain("ALWAYS lettered (A), (B), (C)");
	});

	it("makes rivals' figures one split summing to 100 (#38)", () => {
		const ctx = whole("/wayfinder 186");
		expect(ctx).toContain("Confidence: 30% (20% - 40%).");
		expect(ctx).toContain("so the headline figures sum to 100%");
		expect(ctx).toContain("Relation: <rivals:");
	});

	it("carries the relation line the guard demands (mantahostels#1037)", () => {
		const ctx = whole("/wayfinder 186");
		expect(ctx).toContain(
			"Relation: <rivals: which options actually conflict, and on what",
		);
		expect(ctx).toContain("the lettered shape reads as a ballot");
	});

	it("says the rule has no stakes threshold (mantahostels#570's unpriced yes/no)", () => {
		const ctx = whole("/wayfinder 186");
		expect(ctx).toContain("NO STAKES THRESHOLD");
		expect(ctx).toContain("still ships the lettered priced form");
		expect(ctx).toContain("never omitting the pricing");
	});

	it("reaches a /wayfinder session started as a background job", () => {
		const job = fs.mkdtempSync(path.join(os.tmpdir(), "inject-hook-"));
		try {
			fs.writeFileSync(
				path.join(job, "state.json"),
				JSON.stringify({ intent: "/wayfinder 186" }),
			);
			const ctx = run(
				{ hook_event_name: "SessionStart" },
				{ CLAUDE_JOB_DIR: job },
			);
			expect(ctx).toContain("PRICED OPTIONS");
		} finally {
			fs.rmSync(job, { recursive: true, force: true });
		}
	});

	it.each(["not json", "", "[1]"])(
		"reads an unreadable payload (%j) as the parent's, so a job's intent still reaches it",
		(payload) => {
			const job = fs.mkdtempSync(path.join(os.tmpdir(), "inject-hook-"));
			try {
				fs.writeFileSync(
					path.join(job, "state.json"),
					JSON.stringify({ intent: "/wayfinder 186" }),
				);
				expect(runRaw(payload, { CLAUDE_JOB_DIR: job })).toContain(
					"PRICED OPTIONS",
				);
			} finally {
				fs.rmSync(job, { recursive: true, force: true });
			}
		},
	);

	describe("after a compaction, read off the job's intent", () => {
		const atCompaction = (agentId?: string) => {
			const job = fs.mkdtempSync(path.join(os.tmpdir(), "inject-hook-"));
			try {
				fs.writeFileSync(
					path.join(job, "state.json"),
					JSON.stringify({ intent: "/wayfinder 186" }),
				);
				const sessionId = `compact-${agentId ?? "parent"}`;
				const { sessionStart } = compactPayloads({
					sessionId,
					transcriptPath: path.join(job, "t.jsonl"),
					cwd: ROOT,
					agentId,
				});
				return run(sessionStart, { CLAUDE_JOB_DIR: job });
			} finally {
				fs.rmSync(job, { recursive: true, force: true });
			}
		};

		it("re-injects into the parent", () => {
			expect(atCompaction()).toContain("PRICED OPTIONS");
		});

		it("injects nothing where the payload carries a subagent's agent_id", () => {
			expect(atCompaction("a21cf96dcd1d42038")).toBe("");
		});
	});

	it("points at the host's output style, core-voice.md where undeclared (#448)", () => {
		const host = fs.mkdtempSync(path.join(os.tmpdir(), "inject-host-"));
		const owed = (style: string) =>
			`the lettered priced form is owed inside a round (${style})`;
		try {
			const bare = run(
				{ prompt: "/implement 1", hook_event_name: "UserPromptSubmit" },
				{ CLAUDE_PROJECT_DIR: host },
			);
			expect(bare).toContain(owed(".claude/output-styles/core-voice.md"));
			fs.mkdirSync(path.join(host, ".claude"));
			fs.writeFileSync(
				path.join(host, ".claude", "workflow-core.json"),
				JSON.stringify({
					overrides: { output_style: ".claude/output-styles/manta-voice.md" },
				}),
			);
			const styled = run(
				{ prompt: "/implement 1", hook_event_name: "UserPromptSubmit" },
				{ CLAUDE_PROJECT_DIR: host },
			);
			expect(styled).toContain(owed(".claude/output-styles/manta-voice.md"));
			expect(styled).not.toContain("core-voice.md");
		} finally {
			fs.rmSync(host, { recursive: true, force: true });
		}
	});

	it("reaches every other tracker command too (mantahostels#853)", () => {
		for (const cmd of [
			"/code-review",
			"/triage 1",
			"/to-spec 1",
			"/to-tickets 1",
			"/implement 1",
			"/card-close 1",
		]) {
			expect(inject(cmd), cmd).toContain("PRICED OPTIONS");
		}
	});
});

describe("the priced-options shape where Core voice loads (#2039)", () => {
	const pointer = "in the lettered shape your Core voice output style gives";
	const shape = "Confidence: 70% (60% - 80%).";
	let host: string;
	let user: string;
	beforeEach(() => {
		host = fs.mkdtempSync(path.join(os.tmpdir(), "inject-voice-host-"));
		user = fs.mkdtempSync(path.join(os.tmpdir(), "inject-voice-user-"));
		fs.mkdirSync(path.join(host, ".claude"));
	});
	afterEach(() => {
		fs.rmSync(host, { recursive: true, force: true });
		fs.rmSync(user, { recursive: true, force: true });
	});
	const settings = (dir: string, file: string, outputStyle: string) =>
		fs.writeFileSync(path.join(dir, file), JSON.stringify({ outputStyle }));
	const injected = () =>
		run(
			{ prompt: "/implement 1", hook_event_name: "UserPromptSubmit" },
			{ CLAUDE_PROJECT_DIR: host, CLAUDE_CONFIG_DIR: user },
		);

	it("hands this repo, whose settings name Core voice, the pointer", () => {
		const declared = JSON.parse(
			fs.readFileSync(path.join(ROOT, ".claude", "settings.json"), "utf8"),
		).outputStyle;
		expect(declared, "the precondition this case rests on").toBe("Core voice");
		const ctx = inject("/implement 1");
		expect(ctx).toContain(pointer);
		expect(ctx).toContain("`rule:house-decision`");
		expect(ctx).not.toContain(shape);
	});

	it("hands a host naming no style the whole shape", () => {
		const ctx = injected();
		expect(ctx).toContain(shape);
		expect(ctx).not.toContain(pointer);
	});

	it("reads an adopter's plugin-namespaced name as Core voice", () => {
		settings(host, ".claude/settings.json", "workflow-core:Core voice");
		expect(injected()).toContain(pointer);
	});

	it("reads the user's settings where the project names no style", () => {
		settings(user, "settings.json", "Core voice");
		expect(injected()).toContain(pointer);
	});

	it("lets the local settings outrank the project's, and the project's the user's", () => {
		settings(user, "settings.json", "Core voice");
		settings(host, ".claude/settings.json", "Explanatory");
		expect(injected()).toContain(shape);
		settings(host, ".claude/settings.local.json", "Core voice");
		expect(injected()).toContain(pointer);
	});
});

describe("the claim rule (mantahostels#270)", () => {
	it.each(["/wayfinder 270", "/implement 270", "/triage 270", "/to-spec 270"])(
		"tells %s to claim only what it is working",
		(cmd) => {
			const header = rulesHeader(inject(cmd));
			expect(header).toContain("claim the issue you are WORKING");
			expect(header).toContain("created UNASSIGNED");
		},
	);

	it.each([
		"scripts/claim-issue.js <n>",
		"scripts/file-issue.js",
		"scripts/resolve-ticket.js <n>",
	])("names %s as the route", (script) => {
		expect(rulesHeader(inject("/implement 537"))).toContain(script);
	});

	it("tells /to-spec to assign through file-issue, and what a raw assigning create owes", () => {
		const header = rulesHeader(inject("/to-spec 708"));
		expect(header).toContain("--assign-self");
		expect(header).toContain("a raw create-time assignment");
		expect(header).toContain("claim-issue <n>");
	});

	it("names the release, not only the claim", () => {
		expect(rulesHeader(inject("/implement 708"))).toContain(
			"release-issue <n>",
		);
	});
});

describe("the research-dispatch rule reaches a dispatching session (mantahostels#918)", () => {
	const payload = () => inject("/wayfinder 918");

	it("carries the scratch path the subagent is told to write to", () => {
		expect(payload()).toContain(
			"Write your findings to `.claude/tmp/research-<name>.md`",
		);
	});

	it("carries the Artefact line the dispatch guard requires (mantahostels#766)", () => {
		expect(payload()).toContain("Artefact: .claude/tmp/research-<name>.md");
	});

	it("carries the two prohibitions that keep it out of docs/", () => {
		const p = payload();
		expect(p).toContain("Do NOT write anywhere under `docs/`");
		expect(p).toContain("do NOT commit anything");
	});

	it("binds however the research was dispatched, not only at close time", () => {
		const p = payload();
		expect(p).toContain("### Research artefacts");
		expect(p).toContain("however the research was dispatched");
		expect(p).not.toContain(
			"### Closing a `wayfinder:research` issue — land the artefact first",
		);
	});

	it("points at the posting order rather than pasting it", () => {
		const p = payload();
		expect(p).toContain("Posting is the dispatching session's");
		expect(p).toContain("`docs/agents/issue-tracker.md` §Research artefacts");
	});

	it("carries the owner document's job-sizing sentence word for word", () => {
		const doc = fs.readFileSync(
			path.join(ROOT, "docs", "agents", "issue-tracker.md"),
			"utf8",
		);
		const sentence = /^\*\*Size a reading agent's job.*$/m.exec(doc)?.[0];
		expect(sentence).toBeDefined();
		expect(payload()).toContain(sentence);
	});

	it.each(["triage", "to-spec", "to-tickets", "card-close"])(
		"stays out of /%s entirely",
		(cmd) => {
			const ctx = inject(`/${cmd} 918`);
			expect(ctx).not.toContain("### Research artefacts —");
			expect(ctx).not.toContain("`rule:research-artefact-scratch`");
		},
	);

	it("reaches /implement as the residue id instead of the pasted block", () => {
		const ctx = inject("/implement 918");
		expect(ctx).not.toContain("### Research artefacts —");
		expect(ctx).toContain("`rule:research-artefact-scratch`");
	});
});

describe("the charting terminal condition reaches /wayfinder alone (mantahostels#2585)", () => {
	const payload = () => inject("/wayfinder 2585");

	it("names all four conditions, so a partial run cannot read as done", () => {
		const p = payload();
		expect(p).toContain("A charting run is DONE when four things are true");
		expect(p).toContain("The map body is written");
		expect(p).toContain(
			"every ticket you can specify now exists as a child issue",
		);
		expect(p).toContain("their blocking edges are wired AND read back");
		expect(p).toContain(
			"every `wayfinder:research` ticket this run created is resolved and closed",
		);
	});

	it("says spending the research exception is not a licence to carry on", () => {
		const p = payload();
		expect(p).toContain("end the session on `result:`");
		expect(p).toContain("is not a licence to carry on past it");
	});

	it("routes cross-session scheduling to /pick-next and off the founder", () => {
		const p = payload();
		expect(p).toContain(
			"What runs next across sessions belongs to `/pick-next` and the frontier query",
		);
		expect(p).toContain("Naming the next ticket in order is reporting");
		expect(p).toContain(
			"Which ticket THIS session resolves is still yours to choose",
		);
	});

	it.each([
		"implement",
		"triage",
		"to-spec",
		"to-tickets",
		"card-close",
		"code-review",
	])("stays out of /%s", (cmd) => {
		const ctx = inject(`/${cmd} 2585`);
		expect(ctx).not.toContain("A charting run is DONE");
		expect(ctx).not.toContain("belongs to `/pick-next`");
	});
});

describe("the review-axis Artefact paths are session-scoped (mantahostels#2220)", () => {
	const withSession = (cmd: string, session: string) =>
		run({
			prompt: `/${cmd} 2220`,
			hook_event_name: "UserPromptSubmit",
			session_id: session,
		});

	it.each(["code-review"])(
		"suffixes both Artefact paths for /%s with the session id",
		(cmd) => {
			const ctx = withSession(cmd, "aaaaaaaa-1111-2222-3333-444444444444");
			expect(ctx).toContain("`.claude/tmp/review-standards-aaaaaaaa.md`");
			expect(ctx).toContain("`.claude/tmp/review-spec-aaaaaaaa.md`");
		},
	);

	it.each(["code-review"])(
		"gives two different sessions two different paths on /%s",
		(cmd) => {
			const first = withSession(cmd, "11111111-one-uuid");
			const second = withSession(cmd, "22222222-two-uuid");
			expect(first).not.toBe(second);
			expect(first).toContain("review-standards-11111111.md");
			expect(second).toContain("review-standards-22222222.md");
		},
	);

	it.each(["code-review"])(
		"does not hand /%s the bare, unsuffixed filename",
		(cmd) => {
			const ctx = withSession(cmd, "bbbbbbbb-cccc-dddd-eeee-ffffffffffff");
			expect(ctx).not.toContain("`.claude/tmp/review-standards.md`");
			expect(ctx).not.toContain("`.claude/tmp/review-spec.md`");
		},
	);

	it("falls back to the bare filename with no session id available", () => {
		const ctx = run({
			prompt: "/code-review 2220",
			hook_event_name: "UserPromptSubmit",
		});
		expect(ctx).toContain("`.claude/tmp/review-standards.md`");
		expect(ctx).toContain("`.claude/tmp/review-spec.md`");
	});
});

describe("the rules that were already here", () => {
	it("tells /implement alone to read its parent spec and closed blockers before starting (#893)", () => {
		const ctx = inject("/implement 893");
		expect(ctx).toContain("`## Parent`");
		expect(ctx).toContain("dependencies/blocked_by");
		expect(inject("/triage 893")).not.toContain("dependencies/blocked_by");
	});

	it("tells /implement to create or resume its build state file and commit at each slice boundary (#4410)", () => {
		const ctx = inject("/implement 4419");
		expect(ctx).toContain("`node scripts/build-state.js <n> --spec <parent>`");
		expect(ctx).toContain("a one-slice unit included");
		expect(ctx).toContain("`standingRules`");
		expect(ctx).toContain(
			"At each slice boundary rewrite it, and commit citing the ticket.",
		);
		expect(ctx).toContain(
			"The closing /code-review runs over the commits `node scripts/spec-commits.js <n>` lists for the ticket.",
		);
		for (const cmd of ["/triage 4419", "/to-tickets 4410", "/wayfinder 4419"])
			expect(inject(cmd)).not.toContain("build-state.js");
	});

	it("tells /implement alone to gate a ticket that cannot start yet before releasing it (#5399)", () => {
		const ctx = inject("/implement 5399");
		expect(ctx).toContain("Found that the ticket cannot start yet");
		expect(ctx).toContain(
			"`scripts/lib/rule-text.sh blocked-ticket-gate roadmap-gating`",
		);
		for (const cmd of ["/triage 5399", "/wayfinder 5399"])
			expect(inject(cmd)).not.toContain("cannot start yet");
	});

	it("gives /triage alone the whole-spec review (#892)", () => {
		const triage = inject("/triage 849");
		expect(triage).toContain("node scripts/spec-commits.js <n>");
		expect(triage).not.toContain("codereview-pass");
		expect(inject("/implement 186")).not.toContain("whole-spec review");
	});

	it("files /triage's first-pass findings under an open spec and re-reviews from Reviewed through (#897)", () => {
		const triage = inject("/triage 849");
		expect(triage).toContain(
			"On a first pass a TICKETED one is filed under the spec while it is open",
		);
		expect(triage).toContain("**Reviewed through:**");
		expect(triage).toContain("node scripts/spec-commits.js <n> --since <sha>");
	});

	it("keeps a spec in re-review only for a live finding, with no pass count (#3811)", () => {
		const triage = inject("/triage 849");
		expect(triage).toContain(
			"Live: it names a route ordinary use reaches and the wrong behaviour on it; file it under the spec",
		);
		expect(triage).toContain(
			"Corner: it needs an unusual input or state; file it standalone, its body citing the spec",
		);
		expect(triage).toContain(
			"Tidying: it changes no behaviour; file it standalone, one ticket per pass.",
		);
		expect(triage).toContain(
			"The first pass that files no live finding closes the spec, naming any open standalone tickets on `**Outstanding:**`",
		);
		expect(triage).toContain("No pass count stops a spec");
		expect(triage).toContain(
			"At a fifth or later pass, counting the earlier `**Reviewed through:**` comments, your triage comment also says whether to redesign rather than patch",
		);
		expect(inject("/implement 186")).not.toContain("Corner: it needs");
	});

	it("tells a whole-spec review to fix first, classing only what it tickets on a named exception (#4284, #4492)", () => {
		const triage = inject("/triage 849");
		expect(triage.indexOf("Fix first, on every pass")).toBeLessThan(
			triage.indexOf("On a first pass a TICKETED one"),
		);
		expect(triage).toContain(
			"the `review-finding-destination` rule /code-review hands you says which findings are FIXED here and which TICKETED, and what a TICKETED line names",
		);
		expect(triage).toContain(
			"each TICKETED finding gets a class, picking only where it is filed",
		);
	});

	it("tells a fix ticket's own /code-review that only a live fault goes under the spec (#3811)", () => {
		const fragment = fs.readFileSync(
			path.join(ROOT, "docs/agents/rules/review-finding-destination.txt"),
			"utf8",
		);
		expect(fragment).toContain(
			"A whole-spec review's fix ticket files under the spec only a live fault",
		);
		expect(fragment).toContain("the rest go standalone, citing the spec");
		expect(inject("/code-review")).toContain(fragment.trim());
	});

	it("tells /code-review to fix first and give a no-behaviour fix a Standards-only re-review (#4284)", () => {
		const ctx = inject("/code-review");
		expect(ctx).toContain(
			"FIX FIRST any finding in code the reviewed work wrote",
		);
		expect(ctx).toContain("ticket those and what the change only exposed");
		expect(ctx).toContain(
			"A no-behaviour fix gets a Standards-only re-review over its diff",
		);
		expect(ctx).toContain("only what you would not fix given time");
	});

	it("still gives /code-review the disposition rule alone, without the tracker pointers", () => {
		const ctx = inject("/code-review");
		expect(ctx).toContain("EVERY REVIEW FINDING NEEDS A DESTINATION");
		expect(ctx).not.toContain("THE TRACKER RULES ARE NOT BELOW");
		expect(ctx).not.toContain("Below is this command's index");
	});

	it("tells /code-review how to dispatch its two review axes", () => {
		expect(inject("/code-review")).toContain("code-reviewer");
	});

	it("still routes /wayfinder to both tracker documents alongside the new rule", () => {
		const ctx = inject("/wayfinder 186");
		expect(ctx).toContain("docs/agents/issue-tracker.md");
		expect(ctx).toContain("docs/agents/triage-labels.md");
	});

	it("stays silent on a prompt naming no tracker command", () => {
		expect(inject("what is the status of the pilot")).toBe("");
	});

	it("does not fire on a bare mention of a command name in prose", () => {
		expect(inject("I was reading about the wayfinder skill today")).toBe("");
	});
});

describe("the reviewer-model pin (mantahostels#1009)", () => {
	const readReviewerModel = (): string => {
		const found = [
			...readRuleText("review-dispatch-shape").matchAll(
				/model: "([^"]+)"` on every one/g,
			),
		].map((m) => m[1]);
		expect(found, "reviewer model pins in the dispatch fragment").toHaveLength(
			1,
		);
		return found[0];
	};

	const concisionModel = (text: string, where: string): string => {
		const found = [
			...text.matchAll(/fresh-reader agents on \\?`model: \\?"([^"\\]+)\\?"/g),
		].map((m) => m[1]);
		expect(found, `concision model pins in ${where}`).toHaveLength(1);
		return found[0];
	};

	it("reaches /code-review as the fragment spells it", () => {
		expect(inject("/code-review")).toContain(
			`model: "${readReviewerModel()}"\` on every one`,
		);
	});

	it.each(["review-focused-run", "review-attacker-run"])(
		"is named nowhere in the %s brief",
		(id) => {
			const brief = readRuleText(id);
			expect(brief).toContain(
				"the same subagent type and model as the two axes",
			);
			expect(brief).not.toMatch(/model:|opus|sonnet|haiku|fable/i);
		},
	);

	it("pins the concision pass's own reader to Haiku, in both strings", () => {
		const backstop = fs.readFileSync(
			path.join(ROOT, "scripts", "concision-backstop.sh"),
			"utf8",
		);
		expect(concisionModel(backstop, "concision-backstop.sh")).toBe("haiku");
		expect(
			concisionModel(
				readRuleText("implement-closing-steps"),
				"rule:implement-closing-steps",
			),
		).toBe("haiku");
	});

	it.each([
		[
			"concision-backstop.sh",
			() =>
				fs.readFileSync(
					path.join(ROOT, "scripts", "concision-backstop.sh"),
					"utf8",
				),
		],
		[
			"rule:implement-closing-steps",
			() => readRuleText("implement-closing-steps"),
		],
	])("carries only the concision pass's model pin in %s", (_where, read) => {
		const all = [...read().matchAll(/model: \\?"([^"\\]+)\\?"/g)].map(
			(m) => m[1],
		);
		expect(all).toEqual(["haiku"]);
	});

	it("pins the same reader model in the concision-pass skill's own §3", () => {
		const skill = fs.readFileSync(
			path.join(ROOT, ".claude/skills/concision-pass/SKILL.md"),
			"utf8",
		);
		const found = [...skill.matchAll(/pinned \*\*`model: "([^"]+)"`\*\*/g)].map(
			(m) => m[1],
		);
		expect(found, "fresh-reader pins in concision-pass/SKILL.md").toHaveLength(
			1,
		);
		expect(found[0]).toBe(
			concisionModel(
				readRuleText("implement-closing-steps"),
				"rule:implement-closing-steps",
			),
		);
	});

	it("carries exactly the one known model literal in that skill file", () => {
		const skill = fs.readFileSync(
			path.join(ROOT, ".claude/skills/concision-pass/SKILL.md"),
			"utf8",
		);
		const all = [...skill.matchAll(/model: "([^"]+)"/g)].map((m) => m[1]);
		expect(all.sort()).toEqual(["haiku"]);
	});
});

describe("the review dispatch sentence (#1618, #1697)", () => {
	const runCount =
		"two `Agent` tool calls, or three or four on an escalated or mission-critical change";

	it("reaches a typed /code-review whole, from the fragment", () => {
		expect(readRuleText("review-dispatch-shape")).toContain(runCount);
		expect(inject("/code-review")).toContain(
			readRuleText("review-dispatch-shape"),
		);
	});

	it.each([
		["lib/inject-tracker-docs.js", /\bfragmentLookup\(host\)/],
		["lib/tracker-inject-text.js", /\bfragment\("review-dispatch-shape"\)/],
		[
			"concision-backstop.sh",
			/\brule_(?:text|or_path) review-dispatch-shape\b/,
		],
	])("is not spelled in %s, which prints the fragment", (script, spelling) => {
		const source = fs
			.readFileSync(path.join(ROOT, "scripts", script), "utf8")
			.replaceAll("\\`", "`");
		expect(source).toMatch(spelling);
		expect(source).not.toContain("SINGLE message");
		expect(source).not.toContain("three or four on an escalated");
	});
});

describe("a rule store that cannot supply the dispatch shape (#3514)", () => {
	const empty = fs.mkdtempSync(path.join(SCRATCH, "no-rules-"));
	const noRules = { WFC_RULES_DIR: empty, WFC_RULES_FALLBACK_DIR: empty };
	const misses = () =>
		readGuardErrorsLog(SCRATCH).split("rule:review-dispatch-shape unreadable")
			.length;

	it("names the dispatch shape's path and logs the miss once per printing", () => {
		const fire = () =>
			run(
				{
					prompt: "/code-review",
					hook_event_name: "UserPromptSubmit",
					session_id: "dispatch-miss",
				},
				noRules,
			);
		const before = misses();
		expect(fire()).toContain(
			"Dispatch the review runs as docs/agents/rules/review-dispatch-shape.txt says.",
		);
		expect(fire(), "the duplicate firing prints nothing").toBe("");
		expect(misses()).toBe(before + 1);
	});

	it("logs nothing for a command that prints no dispatch shape", () => {
		const before = misses();
		const ctx = run(
			{ prompt: "/implement 1", hook_event_name: "UserPromptSubmit" },
			noRules,
		);
		expect(ctx).toContain("You invoked /implement");
		expect(misses()).toBe(before);
	});
});

describe("a typed /code-review takes the Skill route's review tier (#1697)", () => {
	const tierHook = path.join(ROOT, "scripts", "guard-dispatch.js");
	let calls = 0;
	const sid = () => `16970000-${++calls}`;
	const rls = {
		name: "RLS and auth boundaries",
		description: "who may read or write what",
		globs: ["supabase/migrations/**"],
		focus: "who can read or write what",
		examples: ["an RLS policy", "a grant"],
	};
	let repo: string;

	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: repo, encoding: "utf8" });

	beforeEach(() => {
		repo = fs.mkdtempSync(path.join(SCRATCH, "typed-tier-"));
		initGitRepo(repo, path.join(repo, ".git", "no-hooks"));
		const skill = path.join(repo, ".claude", "skills", "code-review");
		fs.mkdirSync(skill, { recursive: true });
		fs.writeFileSync(
			path.join(skill, "SKILL.md"),
			"---\nname: code-review\n---\n",
		);
		git("add", ".");
		git("commit", "-qm", "skill");
	});

	afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

	const declare = (sensitivePaths?: unknown[]) =>
		fs.writeFileSync(
			path.join(repo, ".claude", "workflow-core.json"),
			JSON.stringify(sensitivePaths === undefined ? {} : { sensitivePaths }),
		);

	const stage = (rel: string) => {
		fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
		fs.writeFileSync(path.join(repo, rel), "x\n");
		git("add", "--", rel);
	};

	const typed = (prompt = "/code-review", hook = tierHook, cwd = repo) =>
		run(
			{
				prompt,
				hook_event_name: "UserPromptSubmit",
				session_id: sid(),
				cwd,
			},
			{ CLAUDE_PROJECT_DIR: repo },
			{ reviewTier: tierPort(hook) },
		);

	const readSkillRouteContext = (): string => {
		const r = runInProcess(tierHook, ["--only", "inject-review-tier"], {
			stdin: JSON.stringify({
				hook_event_name: "PreToolUse",
				tool_name: "Skill",
				tool_input: { skill: "code-review" },
				session_id: sid(),
			}),
			env: {
				...process.env,
				CLAUDE_PROJECT_DIR: repo,
				CLAUDE_CONFIG_DIR: SCRATCH,
			},
		});
		expect(r.status, r.stderr).toBe(0);
		return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
	};

	it("ends on the Skill route's tier block, briefs and records for a change under a declared glob", () => {
		declare([rls]);
		stage("supabase/migrations/001.sql");
		const tier = readSkillRouteContext();

		const ctx = typed();
		expect(tier).toContain("Tier owed: escalated");
		for (const id of [
			"review-focused-run",
			"review-attacker-run",
			"review-tier-records",
		])
			expect(tier).toContain(readRuleText(id));
		expect(ctx.endsWith(`\n\n${tier}`)).toBe(true);
		expect(ctx.length).toBeLessThan(PERSIST_CHARS);
	});

	it("leads with the tier where the whole would cross the persistence threshold", () => {
		declare(
			Array.from({ length: 30 }, (_, i) => ({
				...rls,
				name: `area ${i}`,
				focus: "f".repeat(200),
			})),
		);
		stage("supabase/migrations/001.sql");

		const ctx = typed();
		expect(ctx.startsWith("Sensitive paths declared")).toBe(true);
		expect(ctx).toContain("You invoked /code-review");
	});

	it("reaches an adopter's bare typed /code-review, which has no local SKILL.md (#1746)", () => {
		git("rm", "-q", ".claude/skills/code-review/SKILL.md");
		git("commit", "-qm", "adopter: the plugin's skill only");
		fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
		declare([rls]);
		stage("supabase/migrations/001.sql");
		expect(typed()).toContain("Tier owed: escalated");
	});

	it("takes the plugin-namespaced spelling too", () => {
		declare([rls]);
		stage("supabase/migrations/001.sql");
		expect(typed("/workflow-core:code-review")).toContain(
			"Tier owed: escalated",
		);
	});

	it("tells a host that declares no sensitive paths that no review can escalate", () => {
		declare();
		stage("supabase/migrations/001.sql");
		expect(typed()).toContain(readRuleText("review-sensitive-undeclared"));
	});

	it("reads a change staged in a linked worktree the session works in (#2386)", () => {
		declare([rls]);
		const tree = path.join(repo, ".claude", "worktrees", "wt");
		git("worktree", "add", "-q", "--detach", tree);
		fs.mkdirSync(path.join(tree, ".claude"), { recursive: true });
		fs.copyFileSync(
			path.join(repo, ".claude", "workflow-core.json"),
			path.join(tree, ".claude", "workflow-core.json"),
		);
		fs.mkdirSync(path.join(tree, "supabase", "migrations"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(tree, "supabase", "migrations", "001.sql"),
			"x\n",
		);
		execFileSync("git", ["add", "--", "supabase/migrations/001.sql"], {
			cwd: tree,
		});
		expect(typed("/code-review", tierHook, tree)).toContain(
			"Tier owed: escalated",
		);
	});

	it("adds not one byte on an ordinary change", () => {
		declare([rls]);
		stage("app/page.tsx");
		const ctx = typed();
		expect(ctx).toContain("You invoked /code-review");
		expect(ctx).toBe(typed("/code-review", path.join(repo, "no-such-hook")));
	});
});

describe("the deviations record (mantahostels#1242)", () => {
	it("tells /code-review's Spec axis to read it", () => {
		const ctx = inject("/code-review");
		expect(ctx).toContain(
			"SPEC AXIS READS THE IMPLEMENTER'S DEVIATIONS RECORD",
		);
		expect(ctx).toContain("Declared departures");
	});

	it("says the record is never suppressed", () => {
		expect(inject("/code-review")).toContain("never suppressed");
	});

	it("does not tell a prompt-time command to write one", () => {
		expect(rulesHeader(inject("/wayfinder 1242"))).not.toContain(
			"RECORD WHERE THE BUILD DEPARTED",
		);
		expect(inject("/code-review")).not.toContain(
			"RECORD WHERE THE BUILD DEPARTED",
		);
	});
});

describe("the code-standards pointer (mantahostels#1011)", () => {
	const standardsDoc = "docs/code-standards.md";

	it("names a local path that exists", () => {
		expect(fs.existsSync(path.join(ROOT, standardsDoc))).toBe(true);
	});

	it("reaches /code-review, which runs the Standards axis directly", () => {
		expect(inject("/code-review")).toContain(standardsDoc);
	});

	it("reaches a Skill-loaded review through its fragment", () => {
		expect(readRuleText("review-standards-axis")).toContain(standardsDoc);
	});

	it("tells the reviewer to cite a breach by its rule id", () => {
		expect(inject("/code-review")).toContain("rule id");
	});
});

describe("the standards base and local file (#965)", () => {
	let host: string;
	let core: string;
	beforeEach(() => {
		host = fs.mkdtempSync(path.join(os.tmpdir(), "standards-host-"));
		core = fs.mkdtempSync(path.join(os.tmpdir(), "standards-core-"));
	});
	afterEach(() => {
		fs.rmSync(host, { recursive: true, force: true });
		fs.rmSync(core, { recursive: true, force: true });
	});
	const put = (root: string, rel: string) => {
		fs.mkdirSync(path.join(root, "docs"), { recursive: true });
		fs.writeFileSync(path.join(root, rel), "x\n");
	};
	const review = () =>
		run(
			{ prompt: "/code-review", hook_event_name: "UserPromptSubmit" },
			{ CLAUDE_PROJECT_DIR: host, WFC_SCRIPT_ROOT: core },
		);
	const basePath = () => path.join(core, "docs", "code-standards-base.md");

	it("both present: hands over both paths, and the base wins outside the changes table", () => {
		put(core, "docs/code-standards-base.md");
		put(host, "docs/code-standards.md");
		const ctx = review();
		expect(ctx).toContain(
			`Hand the Standards axis, in its prompt, base \`${basePath()}\` and local \`docs/code-standards.md\`.`,
		);
		expect(ctx).toContain('"§X2 (base), excepted by local row 2"');
		expect(ctx).toContain('"Smells not raised" (or "Suppressions")');
		expect(ctx).toContain("`Base unreadable: <path>`");
		expect(ctx).not.toContain("No standards base");
		expect(ctx).not.toContain("No local standards file");
	});

	it("base only: hands over the base and says the base applies unchanged", () => {
		put(core, "docs/code-standards-base.md");
		const ctx = review();
		expect(ctx).toContain(`Hand the Standards axis the base \`${basePath()}\``);
		expect(ctx).toContain(
			"its report opens `No local standards file: the base applies unchanged.`",
		);
		expect(ctx).toContain("`Base unreadable: <path>`");
		expect(ctx).not.toContain("hand the Standards axis only the local");
	});

	it("local only: hands over the local file and names the absent base", () => {
		put(host, "docs/code-standards.md");
		const ctx = review();
		expect(ctx).toContain(
			"hand the Standards axis only the local `docs/code-standards.md`",
		);
		expect(ctx).toContain(
			`its report opens \`No standards base: ${basePath()} is absent.\``,
		);
		expect(ctx).not.toContain("Hand the Standards axis the base");
		expect(ctx).not.toContain("Hand the Standards axis, in its prompt, base");
	});

	it("neither: hands over neither path and names both missing", () => {
		const ctx = review();
		expect(ctx).toContain("hand the Standards axis neither.");
		expect(ctx).toContain(
			`its report opening \`No standards base or local file: ${basePath()} and docs/code-standards.md are absent.\``,
		);
		expect(ctx).not.toContain(
			"No standards file: docs/code-standards.md is absent.",
		);
	});

	it("names the host's GLOSSARY.md for base §G8 where it exists (#1373)", () => {
		put(core, "docs/code-standards-base.md");
		fs.writeFileSync(path.join(host, "GLOSSARY.md"), "# Glossary\n");
		expect(review()).toContain(
			"Hand the Standards axis `GLOSSARY.md` too, for base §G8.",
		);
	});

	it("names no glossary where the host has none (#1373)", () => {
		put(core, "docs/code-standards-base.md");
		expect(review()).not.toContain("GLOSSARY.md");
	});

	it("logs a missing base, and only a missing one", () => {
		const readLog = () => readGuardErrorsLog(SCRATCH);
		const before = readLog().split(basePath()).length;
		put(core, "docs/code-standards-base.md");
		review();
		expect(readLog().split(basePath()).length).toBe(before);
		fs.rmSync(basePath());
		review();
		expect(readLog().split(basePath()).length).toBe(before + 1);
	});
});

describe("the SessionStart/UserPromptSubmit double-fire (mantahostels#1117)", () => {
	const fire = (
		session: string,
		prompt: string,
		event = "UserPromptSubmit",
		{
			extra = {},
			env = {},
		}: { extra?: object; env?: Record<string, string> } = {},
	) =>
		run({ prompt, hook_event_name: event, session_id: session, ...extra }, env);

	const marker = (session: string, cmd: string) =>
		path.join(
			SCRATCH,
			`wfc-tracker-inject-${process.getuid?.()}`,
			`${session}.${cmd}`,
		);

	const age = (file: string, seconds: number) => {
		const t = NOW - seconds;
		fs.utimesSync(file, t, t);
	};

	it("drops the second half of the pair", () => {
		const s = "dup-pair";
		expect(fire(s, "/implement 1117", "SessionStart")).toContain(
			"PRICED OPTIONS",
		);
		expect(fire(s, "/implement 1117", "UserPromptSubmit")).toBe("");
	});

	it("suppresses in either firing order", () => {
		const s = "dup-reversed";
		expect(fire(s, "/wayfinder 1117", "UserPromptSubmit")).toContain(
			"PRICED OPTIONS",
		);
		expect(fire(s, "/wayfinder 1117", "SessionStart")).toBe("");
	});

	it("still suppresses a firing just inside the window", () => {
		const s = "just-inside";
		expect(fire(s, "/implement 1117", "SessionStart")).toContain("PRICED");
		age(marker(s, "implement"), 55);
		expect(fire(s, "/implement 1117")).toBe("");
	});

	it("injects again once the window has passed", () => {
		const s = "just-outside";
		expect(fire(s, "/implement 1117", "SessionStart")).toContain("PRICED");
		age(marker(s, "implement"), 65);
		expect(fire(s, "/implement 1117")).toContain("PRICED OPTIONS");
	});

	it.each(["compact", "clear", "resume"])(
		"never suppresses a SessionStart whose source is %s",
		(source) => {
			const s = `source-${source}`;
			expect(fire(s, "/implement 1117", "SessionStart")).toContain("PRICED");
			expect(
				fire(s, "/implement 1117", "SessionStart", { extra: { source } }),
			).toContain("PRICED OPTIONS");
		},
	);

	it("records nothing for a firing whose source is exempt", () => {
		const s = "compact-records-nothing";
		expect(
			fire(s, "/implement 1117", "SessionStart", {
				extra: { source: "compact" },
			}),
		).toContain("PRICED");
		expect(fs.existsSync(marker(s, "implement"))).toBe(false);
	});

	it("keys on the command, so a different one in the same session injects", () => {
		const s = "two-commands";
		expect(fire(s, "/implement 1117")).toContain("PRICED OPTIONS");
		expect(fire(s, "/wayfinder 1117")).toContain("You invoked /wayfinder");
		expect(fire(s, "/implement 1117")).toBe("");
	});

	it("keys on the session, so a parallel session gets its own copy", () => {
		expect(fire("session-one", "/implement 1117")).toContain("PRICED OPTIONS");
		expect(fire("session-two", "/implement 1117")).toContain("PRICED OPTIONS");
	});

	it("suppresses only a byte-identical payload", () => {
		const first = fire("identical-a", "/implement 1117", "SessionStart");
		const second = fire("identical-b", "/implement 1117 with more detail");
		expect(second).toBe(first);
	});

	describe("every failure path injects rather than withholding", () => {
		it("leaves the marker free where a firing fails before its text exists", () => {
			const payload = {
				prompt: "/implement 1117",
				hook_event_name: "SessionStart",
				session_id: "fail-before-text",
			};
			expect(() =>
				run(
					payload,
					{},
					{
						takesLabel: () => {
							throw new Error("the read broke");
						},
					},
				),
			).toThrow("the read broke");
			expect(
				run({ ...payload, hook_event_name: "UserPromptSubmit" }),
			).toContain("PRICED OPTIONS");
		});

		const twice = (session: string, env: Record<string, string> = {}) => [
			fire(session, "/implement 1117", "SessionStart", { env }),
			fire(session, "/implement 1117", "UserPromptSubmit", { env }),
		];

		it("injects both times when the payload carries no session id", () => {
			const p = { prompt: "/implement 1117", hook_event_name: "SessionStart" };
			expect(run(p)).toContain("PRICED OPTIONS");
			expect(run({ ...p, hook_event_name: "UserPromptSubmit" })).toContain(
				"PRICED OPTIONS",
			);
		});

		it("injects both times when the marker cannot be written", () => {
			const blocked = path.join(SCRATCH, "not-a-dir");
			fs.writeFileSync(blocked, "");
			for (const out of twice("unwritable", { TMPDIR: blocked })) {
				expect(out).toContain("PRICED OPTIONS");
			}
		});

		it("injects when a marker is dated in the future", () => {
			const s = "future-marker";
			expect(fire(s, "/implement 1117", "SessionStart")).toContain("PRICED");
			age(marker(s, "implement"), -3600);
			expect(fire(s, "/implement 1117")).toContain("PRICED OPTIONS");
		});

		it("keeps a session id from escaping the scratch directory", () => {
			expect(fire("../../escape", "/implement 1117")).toContain("PRICED");
			const dir = path.join(
				SCRATCH,
				`wfc-tracker-inject-${process.getuid?.()}`,
			);
			expect(fs.readdirSync(dir)).toContain("______escape.implement");
		});
	});
});

describe("every command's payload lands whole, under the cut (mantahostels#1870)", () => {
	const allCommands = [
		"wayfinder",
		"to-spec",
		"to-tickets",
		"implement",
		"triage",
		"card-close",
		"code-review",
	];

	it.each(allCommands)("keeps /%s under the persistence threshold", (cmd) => {
		expect(inject(`/${cmd} 1870`).length).toBeLessThan(PERSIST_CHARS);
	});

	it.each(allCommands)(
		"keeps /%s under it with the whole priced-options shape",
		(cmd) => {
			expect(whole(`/${cmd} 1870`).length).toBeLessThan(PERSIST_CHARS);
		},
	);

	const pricedRule = "EVERY CHOICE PUT TO THE FOUNDER SHIPS PRICED";

	it.each(allCommands)("delivers the priced-options rule to /%s", (cmd) => {
		expect(inject(`/${cmd} 1870`)).toContain(pricedRule);
	});

	it.each(allCommands.filter((c) => c !== "code-review"))(
		"delivers the `**Bound:**`, `**Values:**` and `**Practice:**` lines to /%s",
		(cmd) => {
			const ctx = inject(`/${cmd} 1870`);
			expect(ctx).toContain("**Bound:**");
			expect(ctx).toContain("**Values:**");
			expect(ctx).toContain("**Practice:**");
		},
	);

	it("leaves them out of /code-review, which resolves no ticket", () => {
		expect(inject("/code-review 1870")).not.toContain("**Values:**");
	});
});

describe("the residue index replaces both full-document pointers (mantahostels#2499)", () => {
	const sixCommands = [
		"wayfinder",
		"to-spec",
		"to-tickets",
		"implement",
		"triage",
		"card-close",
	];

	const payloads = new Map<string, string>();
	const injected = (cmd: string): string => {
		let ctx = payloads.get(cmd);
		if (ctx === undefined) {
			ctx = inject(`/${cmd} 2499`);
			payloads.set(cmd, ctx);
		}
		return ctx;
	};

	it.each(sixCommands)("gives /%s the residue index framing", (cmd) => {
		const ctx = injected(cmd);
		expect(ctx).toContain("THE TRACKER RULES ARE NOT BELOW");
		expect(ctx).toContain("docs/agents/issue-tracker.md");
		expect(ctx).toContain("docs/agents/triage-labels.md");
	});

	it.each(sixCommands)(
		"carries mantahostels#1118's never-act-from-memory line verbatim on /%s",
		(cmd) => {
			expect(injected(cmd)).toContain(
				"Never act on a trigger from memory or inference",
			);
		},
	);

	it.each(sixCommands)(
		"names an id and a moment, never a rule's content, on /%s",
		(cmd) => {
			const ctx = injected(cmd);
			const lines = ctx.split("\n").filter((l) => l.startsWith("- `rule:"));
			expect(lines.length).toBeGreaterThan(0);
			for (const line of lines) expect(line).toMatch(/^- `rule:[a-z-]+` — /);
		},
	);

	const ruleOwners: Record<string, string[]> = {
		"gh-cli-limits": [],
		"roadmap-gating": ["wayfinder", "implement", "triage"],
		"card-close-route": ["implement"],
		"issue-title-card-id": ["to-spec", "to-tickets", "card-close"],
		"decisions-search-first": ["wayfinder", "to-tickets", "implement"],
		"research-artefact-scratch": ["implement"],
		"wayfinder-ops-shapes": ["wayfinder"],
		"kind-label-vocabulary": ["to-spec", "to-tickets", "triage"],
		"takes-label-nuances": ["triage"],
		"waiting-external-vocabulary": ["wayfinder", "triage"],
		"size-line": ["to-tickets"],
	};

	it.each(Object.entries(ruleOwners))(
		"carries `rule:%s` only to the commands that can trigger it",
		(id, owners) => {
			for (const cmd of sixCommands) {
				const has = injected(cmd).includes(`\`rule:${id}\``);
				expect(has, `/${cmd} × ${id}`).toBe(owners.includes(cmd));
			}
		},
	);

	it("names only ids docs/agents/rules/ actually answers", () => {
		for (const id of Object.keys(ruleOwners))
			expect(readRuleText(id).trim().length, id).toBeGreaterThan(0);
	});

	it.each(sixCommands)(
		"keeps the two guard-enforced acts out of /%s's index",
		(cmd) => {
			const ctx = injected(cmd);
			expect(ctx).not.toContain("`rule:issue-body-raw-write`");
			expect(ctx).not.toContain("`rule:close-outstanding-line`");
		},
	);

	it.each(sixCommands)(
		"pastes the foreground re-run line, not the background rule, into /%s",
		(cmd) => {
			const ctx = injected(cmd);
			expect(ctx).not.toContain("background every one");
			expect(ctx).not.toContain("A foreground Bash `gh` HANGS");
			expect(ctx).toContain(
				"run `gh` in the foreground, and re-run an empty result once before believing it",
			);
		},
	);

	it.each(sixCommands)(
		"names the fetch command in /%s's own payload, not just a comment",
		(cmd) => {
			expect(injected(cmd)).toContain(
				"`scripts/lib/rule-text.sh <id> [<id>…]`",
			);
		},
	);

	it("still gives /implement its opening step alongside the new index", () => {
		const ctx = injected("implement");
		expect(ctx).toContain("`## Parent`");
		expect(ctx).toContain("THE TRACKER RULES ARE NOT BELOW");
	});

	it("still gives /wayfinder the `**Bound:**` line alongside the new index", () => {
		const ctx = injected("wayfinder");
		expect(ctx).toContain("**Bound:**");
		expect(ctx).toContain("THE TRACKER RULES ARE NOT BELOW");
	});

	it("keeps /implement's payload the margin gate's tight headroom under the threshold", () => {
		expect(injected("implement").length).toBeLessThan(
			PERSIST_CHARS - TIGHT_HEADROOM_CHARS,
		);
	});

	it("emits the same bytes whatever project root it is pointed at", () => {
		const empty = fs.mkdtempSync(path.join(os.tmpdir(), "no-docs-"));
		fs.mkdirSync(path.join(empty, ".claude"));
		fs.writeFileSync(
			path.join(empty, ".claude", "settings.json"),
			JSON.stringify({ outputStyle: "Core voice" }),
		);
		for (const cmd of sixCommands) {
			const ctx = run(
				{ prompt: `/${cmd} 2499`, hook_event_name: "UserPromptSubmit" },
				{ CLAUDE_PROJECT_DIR: empty },
			);
			expect(ctx, cmd).toBe(injected(cmd));
			expect(ctx, cmd).toContain(`You invoked /${cmd}`);
		}
	});
});

describe("the plugin namespace on a command is optional (#201)", () => {
	const namespacedCommands = [
		"wayfinder",
		"to-spec",
		"to-tickets",
		"implement",
		"triage",
		"card-close",
		"code-review",
	];

	it.each(namespacedCommands)(
		"injects for /workflow-core:%s exactly as for the bare spelling",
		(cmd) => {
			const ctx = inject(`/workflow-core:${cmd} 201`);
			expect(ctx.length).toBeGreaterThan(1000);
			expect(ctx).toBe(inject(`/${cmd} 201`));
		},
	);

	it("accepts any plugin name as the prefix, not only workflow-core", () => {
		expect(inject("/my-fork:implement 201")).toBe(inject("/implement 201"));
	});

	it("still refuses a command that is only part of a longer word", () => {
		expect(inject("/workflow-core:implementation 201")).toBe("");
		expect(inject("read docs/implement-notes")).toBe("");
	});

	it("still refuses a prefix that is not attached to a command", () => {
		expect(inject("/workflow-core: implement 201")).toBe("");
	});
});

describe("the tracker frame in a plugin install (#1010)", () => {
	it("names both tracker docs at the plugin root", () => {
		const core = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-frame-core-"));
		try {
			fs.mkdirSync(path.join(core, "docs", "agents"), { recursive: true });
			for (const f of ["issue-tracker.md", "triage-labels.md"])
				fs.writeFileSync(path.join(core, "docs", "agents", f), "");
			const ctx = run(
				{ prompt: "/implement 1", hook_event_name: "UserPromptSubmit" },
				{ WFC_SCRIPT_ROOT: core },
			);
			expect(ctx).toContain(
				`THE TRACKER RULES ARE NOT BELOW — \`${core}/docs/agents/issue-tracker.md\` and \`${core}/docs/agents/triage-labels.md\` are their home`,
			);
		} finally {
			fs.rmSync(core, { recursive: true, force: true });
		}
	});
});

describe("a command typed on an issue labelled for another (#1164)", () => {
	let label = "";
	let fake = takesPort(() => label);
	beforeEach(() => {
		fake = takesPort(() => label);
	});
	const readCalls = () => fake.calls.join("\n");

	const typed = (
		prompt: string,
		takes: string,
		takesLabel?: Ports["takesLabel"],
	) => {
		label = takes;
		return run(
			{ prompt, hook_event_name: "UserPromptSubmit" },
			{},
			{ takesLabel: takesLabel ?? fake.port },
		);
	};

	it("opens /wayfinder's payload with the line on a takes:implement issue", () => {
		const ctx = typed("/wayfinder 1912", "takes:implement");
		expect(ctx.split("\n")[0]).toBe(
			"#1912 is `takes:implement`, not `takes:wayfinder`. Confirm with the founder, or switch to /implement, first.",
		);
		expect(ctx).toContain("You invoked /wayfinder");
	});

	it("reads the namespaced command and a #-prefixed, punctuated reference", () => {
		expect(
			typed("/workflow-core:wayfinder #1912, please", "takes:implement"),
		).toMatch(/^#1912 is `takes:implement`, not `takes:wayfinder`/);
	});

	it("names the label alone where no command opens it", () => {
		for (const takes of ["takes:human", "takes:children"])
			expect(typed("/implement 7", takes).split("\n")[0]).toBe(
				`#7 is \`${takes}\`, not \`takes:implement\`. Confirm with the founder first.`,
			);
	});

	it("asks the URL's own repo", () => {
		typed("/to-spec https://github.com/o/r/issues/9#issuecomment-1", "");
		expect(readCalls()).toMatch(/^issue view 9 --repo o\/r /);
	});

	it("adds nothing on a matching label or none", () => {
		for (const takes of ["takes:implement", ""])
			expect(typed("/implement 7", takes)).toBe(inject("/implement 7"));
	});

	it("never asks for /triage, /card-close or /code-review, or with no reference", () => {
		for (const p of [
			"/triage 7",
			"/card-close 7",
			"/code-review 7",
			"/wayfinder I read this",
		])
			typed(p, "takes:human");
		expect(readCalls()).toBe("");
	});

	it("fails open on a gh that errors, injecting the usual payload", () => {
		expect(typed("/wayfinder 7", "", () => "")).toBe(inject("/wayfinder 7"));
	});

	it("keeps every command under the persistence threshold with the line", () => {
		const longest = `takes:${TAKES_VALUES.reduce((a, b) => (b.length > a.length ? b : a))}`;
		for (const cmd of ["wayfinder", "to-spec", "to-tickets", "implement"])
			expect(typed(`/${cmd} 99999`, longest).length, cmd).toBeLessThan(
				PERSIST_CHARS,
			);
		expect(typed("/implement 99999", longest).length).toBeLessThan(
			PERSIST_CHARS - TIGHT_HEADROOM_CHARS,
		);
	});

	it("still warns on a second issue the same command names inside the dedupe window", () => {
		const fire = (prompt: string, takes: string) => {
			label = takes;
			return run(
				{
					prompt,
					hook_event_name: "UserPromptSubmit",
					session_id: "takes-dup",
				},
				{},
				{ takesLabel: fake.port },
			);
		};
		expect(fire("/wayfinder 5", "takes:wayfinder")).toContain("You invoked");
		expect(fire("/wayfinder 9", "takes:implement")).toMatch(/^#9 is /);
		expect(fire("/wayfinder 9", "takes:implement")).toBe("");
	});

	it("reads the first of comma- or ampersand-joined references", () => {
		for (const p of [
			"/wayfinder 17,19",
			"/wayfinder 17&19",
			"/wayfinder 17 and 19",
		])
			expect(typed(p, "takes:implement"), p).toMatch(
				/^#17 is `takes:implement`/,
			);
	});
});
