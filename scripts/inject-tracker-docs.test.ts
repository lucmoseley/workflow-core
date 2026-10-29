// @vitest-environment node
/*
 * Tests for scripts/inject-tracker-docs.sh, the UserPromptSubmit/SessionStart hook
 * that hands vendored skills the project rules their own SKILL.md files do not
 * carry.
 *
 * Coverage is the per-command routing — which command gets which rule — and the
 * de-duplication that stops both wired events injecting the same payload twice
 * (mantahostels#1870, mantahostels#1117).
 *
 * The real hook is run on one payload at a time, with its de-duplication
 * markers pinned to a scratch dir and `gh` stubbed where a case reaches it, so
 * no case reads or writes the host's real state or touches GitHub.
 *
 * Break a case here and a /to-tickets, /triage or /implement session follows
 * its vendored SKILL.md alone, writing prose "Blocked by" sections rather than
 * native dependency links.
 */

import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { stubGhScript } from "./lib/gh-stub";
import { initGitRepo } from "./lib/git-fixture";
import { readGuardErrorsLog } from "./lib/guard-errors-log";
import { registrationsOf } from "./lib/hook-wiring";
import { runInProcess } from "./lib/run-in-process.js";
import { readShellConst } from "./lib/shell-const-testkit";

const ROOT = path.resolve(__dirname, "..");
const HOOK = path.join(ROOT, "scripts", "inject-tracker-docs.sh");
const { readRuleText } = require("./lib/rule-text") as {
	readRuleText: (id: string) => string;
};
const { compactPayloads, compactTranscripts, SUBAGENT_JUST_COMPACTED } =
	require("./lib/compact-payload-fixture") as typeof import("./lib/compact-payload-fixture.js");
const { TAKES_VALUES } = require("./lib/takes-label") as {
	TAKES_VALUES: string[];
};

/* The harness's persistence threshold and the tight-headroom margin the margin
 * checker prices, each read from where it is spelled. Module scope, not local
 * to one describe block: both figures are reused by an unrelated block below. */
const PERSIST_CHARS = readShellConst(
	path.join(ROOT, "scripts", "lib", "hook-limits.sh"),
	"HOOK_PERSIST_CHARS",
);
const TIGHT_HEADROOM_CHARS = readShellConst(
	path.join(ROOT, "scripts", "check-injector-margin.sh"),
	"TIGHT_HEADROOM_CHARS",
);

/**
 * Where the hook keeps its per-session de-duplication markers. Pinned to a
 * scratch dir so a run never reads or writes the host's real state.
 */
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "inject-hook-state-"));
afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

/** Run the hook on one payload, an object or raw text, and return its stdout. */
const runRaw = (
	payload: object | string,
	env: Record<string, string> = {},
): string =>
	execFileSync(HOOK, {
		input: typeof payload === "string" ? payload : JSON.stringify(payload),
		encoding: "utf8",
		// CLAUDE_PROJECT_DIR is pinned because the output style is read off its
		// config (#448); unpinned, that read would rest on the runner's cwd.
		// CLAUDE_JOB_DIR is cleared unless a case sets it: the runner may itself be
		// a background job, whose state.json would otherwise supply a prompt.
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: ROOT,
			WFC_OUTPUT_STYLE: undefined,
			CLAUDE_JOB_DIR: "",
			// The de-duplication keys on the payload's session id, falling back to
			// this variable — which the runner's OWN session exports, so leaving it
			// set would make every case below the first a suppressed duplicate.
			CLAUDE_CODE_SESSION_ID: "",
			TMPDIR: SCRATCH,
			// A missing standards base is logged under it (#965); unset, a test
			// run appends to the founder's own log.
			CLAUDE_CONFIG_DIR: SCRATCH,
			// The `takes:` read (#1164) fails open off the network unless a case
			// stubs it.
			WFC_GH: "false",
			// /code-review's tier read (#1697) would match this repo's own staged
			// paths, so it stays off unless a case points it at the hook.
			WFC_REVIEW_TIER_HOOK: path.join(SCRATCH, "no-tier-hook"),
			...env,
		},
	});

/** Run the hook on one payload and return the context it hands the session. */
const run = (payload: object, env: Record<string, string> = {}): string => {
	const out = runRaw(payload, env);
	if (out.trim() === "") return "";
	return JSON.parse(out).hookSpecificOutput.additionalContext;
};

/**
 * Since mantahostels#1870 nothing is inlined at all — both tracker documents are pointed at
 * rather than pasted — so the whole context IS the hook's own rules and there is
 * nothing to cut off.
 *
 * The seam asserts that no paste has crept back. A document re-inlined here
 * would put the payload back over the harness's persistence threshold, reaching
 * the session as a preview and a file it rarely opens (the threshold and read
 * rate: mantahostels#1870) — so the paste does not merely cost tokens, it takes every rule
 * below the cut out of sight.
 */
const rulesHeader = (ctx: string): string => {
	expect(ctx, "a document has been inlined again").not.toContain("--- BEGIN ");
	return ctx;
};

const inject = (prompt: string, event = "UserPromptSubmit"): string =>
	run({ prompt, hook_event_name: event });

/* A host declaring no output style, so it gets the whole priced-options shape
 * where this repo, under Core voice, gets the pointer (#2039). */
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
		// Spelled out rather than regex-matched: the shape IS the requirement.
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
		// The heading alone is a slogan; the clause is the behavioural content.
		expect(ctx).toContain("still ships the lettered priced form");
		expect(ctx).toContain("never omitting the pricing");
	});

	it("reaches a /wayfinder session started as a background job", () => {
		// A real SessionStart payload carries NO prompt — the job's opening prompt is
		// recorded as `intent` on CLAUDE_JOB_DIR/state.json, and reading it is the
		// whole reason that branch exists. Adding a prompt here skips the branch.
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
				// No event to read, so the context goes out as plain stdout.
				expect(runRaw(payload, { CLAUDE_JOB_DIR: job })).toContain(
					"PRICED OPTIONS",
				);
			} finally {
				fs.rmSync(job, { recursive: true, force: true });
			}
		},
	);

	// A subagent's compaction fires SessionStart:compact under its parent's
	// session id; the prelude names the parent's command and issue (#1785).
	describe("after a compaction, read off the job's intent", () => {
		const atCompaction = (
			agentId?: string,
			ages?: { parentAgeS: number; subagentAgesS: number[] },
		) => {
			const job = fs.mkdtempSync(path.join(os.tmpdir(), "inject-hook-"));
			try {
				fs.writeFileSync(
					path.join(job, "state.json"),
					JSON.stringify({ intent: "/wayfinder 186" }),
				);
				const sessionId = `compact-${agentId ?? "parent"}`;
				const { sessionStart } = compactPayloads({
					sessionId,
					transcriptPath: ages
						? compactTranscripts(job, { sessionId, ...ages })
						: path.join(job, "t.jsonl"),
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

		// Until the harness sends agent_id there (#1837).
		it("injects nothing where a subagent's transcript is fresher than the parent's stale one", () => {
			expect(atCompaction(undefined, SUBAGENT_JUST_COMPACTED)).toBe("");
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
		// Any of these commands can put a choice to the founder, and off this path
		// the only thing carrying the shape is the Stop guard, which mantahostels#872
		// saw miss four defective turns silently.
		// /code-review returns down a separate early branch, so omitting it would
		// leave the one path that does not share the exit untested.
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
	// The defect was the rule's own wording: "claim the issue before any other
	// work … or `--assignee @me` on create" reads as a general option, so a
	// session filing a spin-off claimed work it would never touch and removed it
	// from selection.
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

	// `/to-spec` creates its issue already assigned, which is not the shape
	// `record-issue-claim.js` watches for, so it was the one command whose
	// sessions would reliably assign without recording (mantahostels#708).
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
	/*
	 * Pasted in the hook's own prose, because a session that misses it does the
	 * WRONG thing rather than an uninformed one: it tells the subagent to write
	 * into `docs/research/`, ahead of the concision pass.
	 *
	 * /wayfinder ALONE takes it. /implement is the one variant with closing steps
	 * of its own, and carrying this too would put it over the threshold; its
	 * tracker pointer names the section instead.
	 */
	const payload = () => inject("/wayfinder 918");

	it("carries the scratch path the subagent is told to write to", () => {
		// The structural half: `.claude/tmp/` is gitignored, and check-doc-map takes
		// its scope from `git ls-files`, so the file carries no doc-map §A row
		// (mantahostels#2089, mantahostels#2093).
		// Asserted as the whole instruction, not the bare path — a bare-path
		// assertion would pass vacuously against the Artefact line above it.
		expect(payload()).toContain(
			"Write your findings to `.claude/tmp/research-<name>.md`",
		);
	});

	// The guard added at mantahostels#766 denies a dispatch whose prompt has no Artefact
	// line, so the pasted block must carry one or this rule's own recipe is
	// refused at dispatch time.
	it("carries the Artefact line the dispatch guard requires (mantahostels#766)", () => {
		expect(payload()).toContain("Artefact: .claude/tmp/research-<name>.md");
	});

	it("carries the two prohibitions that keep it out of docs/", () => {
		const p = payload();
		expect(p).toContain("Do NOT write anywhere under `docs/`");
		expect(p).toContain("do NOT commit anything");
	});

	it("binds however the research was dispatched, not only at close time", () => {
		// The old heading scoped the rule to closing a wayfinder:research issue, so
		// a dispatching session never recited it.
		const p = payload();
		expect(p).toContain("### Research artefacts");
		expect(p).toContain("however the research was dispatched");
		expect(p).not.toContain(
			"### Closing a `wayfinder:research` issue — land the artefact first",
		);
	});

	/* The landing half is a pointer, not a paste: it binds AFTER the subagent has
	 * returned, when the dispatching session can read a file, whereas the dispatch
	 * half has to be in the prompt at the moment the Agent call is written. */
	it("points at the posting order rather than pasting it", () => {
		const p = payload();
		expect(p).toContain("Posting is the dispatching session's");
		expect(p).toContain("`docs/agents/issue-tracker.md` §Research artefacts");
	});

	/* #1789: one sentence, worded as in the owner document, so a /wayfinder
	 * dispatcher reads the same rule `rule:research-artefact-scratch` hands
	 * everyone else. */
	it("carries the owner document's job-sizing sentence word for word", () => {
		const doc = fs.readFileSync(
			path.join(ROOT, "docs", "agents", "issue-tracker.md"),
			"utf8",
		);
		const sentence = /^\*\*Size a reading agent's job.*$/m.exec(doc)?.[0];
		expect(sentence).toBeDefined();
		expect(payload()).toContain(sentence);
	});

	/* Everything else is spent on a command that does not dispatch research
	 * itself. mantahostels#2499 gives /implement the `research-artefact-scratch` residue id
	 * instead of the wayfinder-only pasted block; the other four carry neither. */
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

/* mantahostels#2585, off mantahostels#2577's ruling on the incident mantahostels#2564 records. The clause lives
 * here rather than in `.claude/skills/wayfinder/SKILL.md` because that file's
 * doc-map §A route is Vendored — an edit to it is lost on the next pull. */
describe("the charting terminal condition reaches /wayfinder alone (mantahostels#2585)", () => {
	const payload = () => inject("/wayfinder 2585");

	it("names all four conditions, so a partial run cannot read as done", () => {
		const p = payload();
		expect(p).toContain("A charting run is DONE when four things are true");
		expect(p).toContain("The map body is written");
		expect(p).toContain(
			"every ticket you can specify now exists as a child issue",
		);
		// "wired" alone is unactionable: a session that fired the edge call has no
		// evidence it took until it reads the edge back.
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
		// Without this half the clause reads as a gag on naming the order at all.
		expect(p).toContain("Naming the next ticket in order is reporting");
		// Without this the clause reads as barring a resolving session from
		// choosing its own ticket, which SKILL.md's "Work through the map" step 2
		// requires it to do — the inverse of the harm mantahostels#2577 §2 guards.
		expect(p).toContain(
			"Which ticket THIS session resolves is still yours to choose",
		);
	});

	/* Every other command pays for the bytes and none of them charts. */
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
	/** Run the hook for /<cmd> under a given session id. */
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

	// No session id at all — e.g. a payload malformed upstream of this hook —
	// falls back to the bare name rather than emitting a literal "-undefined"
	// or an empty-but-hyphenated path.
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

	it("gives /triage alone the whole-spec review (#892)", () => {
		const triage = inject("/triage 849");
		expect(triage).toContain("node scripts/spec-commits.js <n>");
		expect(triage).not.toContain("codereview-pass");
		expect(inject("/implement 186")).not.toContain("spec-commits.js");
	});

	it("files /triage's findings under an open spec and re-reviews from Reviewed through (#897)", () => {
		const triage = inject("/triage 849");
		expect(triage).toContain("filed under the spec while it is open");
		expect(triage).toContain("**Reviewed through:**");
		expect(triage).toContain("node scripts/spec-commits.js <n> --since <sha>");
	});

	it("still gives /code-review the disposition rule alone, without the tracker pointers", () => {
		const ctx = inject("/code-review");
		expect(ctx).toContain("EVERY REVIEW FINDING NEEDS A DESTINATION");
		// It files an issue only where a finding needs one, so the placement and
		// labelling rules would cost more context than the one rule it is missing.
		// Both strings below are the CURRENT frame text: a `not.toContain` on
		// wording the injector has retired passes vacuously.
		expect(ctx).not.toContain("THE TRACKER RULES ARE NOT BELOW");
		expect(ctx).not.toContain("Below is this command's index");
	});

	// The vendored code-review skill does not say how to dispatch its two axes,
	// so a hook is the only thing carrying it: this one for a typed /code-review,
	// scripts/lib/review-rules.js for the review /implement loads as a skill.
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
		// The gate is a word-boundary match on a leading slash, so discussing the
		// command must not inject the rules into an unrelated session.
		expect(inject("I was reading about the wayfinder skill today")).toBe("");
	});
});

/*
 * mantahostels#1009 — the reviewer-model pin (docs/effort-guide.md) is one value,
 * written once (#1697): docs/agents/rules/review-dispatch-shape.txt, which
 * this hook and scripts/concision-backstop.sh's Stop nag print. The concision
 * pass's own fresh-reader pin, a different value, is spelled in those two and in
 * .claude/skills/concision-pass/SKILL.md §3 (mantahostels#2635).
 */
describe("the reviewer-model pin (mantahostels#1009)", () => {
	/** The reviewer `model: "..."` the dispatch fragment pins on both axes. */
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

	/**
	 * The concision pass's fresh-reader pin (mantahostels#2614), restated in the
	 * backstop's code nag and the closing-steps fragment, and drifting the same
	 * way if only one is edited.
	 */
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

	// #1621 — the escalated tier's briefs defer to the axes' pin, so a reviewer
	// model change stays the four lockstep edits docs/effort-guide.md names.
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

	// mantahostels#2614 — the concision pass judged prose on the reviewer's model because
	// its dispatch named none and sat beside this one. Both strings now pin it,
	// and Sonnet is the value docs/effort-guide.md's dispatch table names, so
	// anything else is the drift this exists to catch. The pin rides in
	// `rule:implement-closing-steps`, which the backstop prints to /implement
	// sessions alone.
	it("pins the concision pass's own reader to Sonnet, in both strings", () => {
		const backstop = fs.readFileSync(
			path.join(ROOT, "scripts", "concision-backstop.sh"),
			"utf8",
		);
		expect(concisionModel(backstop, "concision-backstop.sh")).toBe("sonnet");
		expect(
			concisionModel(
				readRuleText("implement-closing-steps"),
				"rule:implement-closing-steps",
			),
		).toBe("sonnet");
	});

	// The concision helper matches on wording around its pin, so a second pin
	// added in a new sentence — the mantahostels#2614 copy-paste shape — would pass
	// unseen, as would a reviewer pin copied back out of the fragment.
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
		expect(all).toEqual(["sonnet"]);
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

	// The same literal count the backstop and the fragment get above.
	it("carries exactly the one known model literal in that skill file", () => {
		const skill = fs.readFileSync(
			path.join(ROOT, ".claude/skills/concision-pass/SKILL.md"),
			"utf8",
		);
		const all = [...skill.matchAll(/model: "([^"]+)"/g)].map((m) => m[1]);
		expect(all.sort()).toEqual(["sonnet"]);
	});
});

/*
 * #1618, #1697 — the dispatch sentence and its run count live once, in the
 * fragment, and both scripts print it.
 */
describe("the review dispatch sentence (#1618, #1697)", () => {
	const runCount =
		"two `Agent` tool calls, or three or four on an escalated or mission-critical change";

	it("reaches a typed /code-review whole, from the fragment", () => {
		expect(readRuleText("review-dispatch-shape")).toContain(runCount);
		expect(inject("/code-review")).toContain(
			readRuleText("review-dispatch-shape"),
		);
	});

	it.each(["inject-tracker-docs.sh", "concision-backstop.sh"])(
		"is not spelled in %s, which prints the fragment",
		(script) => {
			const source = fs
				.readFileSync(path.join(ROOT, "scripts", script), "utf8")
				.replaceAll("\\`", "`");
			expect(source).toMatch(/\brule_(?:text|or_path) review-dispatch-shape\b/);
			expect(source).not.toContain("SINGLE message");
			expect(source).not.toContain("three or four on an escalated");
		},
	);
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

/*
 * #1697 — the dispatcher's inject-review-tier core fires on the Skill tool
 * alone, so a /code-review the founder types reaches it only through this
 * hook's /code-review arm, which runs it alone on a Skill payload of its own
 * making.
 */
describe("a typed /code-review takes the Skill route's review tier (#1697)", () => {
	const tierHook = path.join(ROOT, "scripts", "guard-dispatch.js");
	/* The injector drops a repeat of one session's command inside 60 s, so each
	 * call takes its own id; the first 8 characters, which name the Artefact
	 * paths, stay the same. */
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
			{ CLAUDE_PROJECT_DIR: repo, WFC_REVIEW_TIER_HOOK: hook },
		);

	/** What the Skill route injects for the same change. */
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

	// #2386: the tier core reads the worktree from the payload's cwd, which
	// this hook's own Skill payload must carry.
	it("reads a change staged in a linked worktree the session works in (#2386)", () => {
		declare([rls]);
		const tree = path.join(repo, ".claude", "worktrees", "wt");
		git("worktree", "add", "-q", "--detach", tree);
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

/*
 * The deviations record (mantahostels#1242). The WRITE half reaches a builder, and the READ
 * half the review. Since mantahostels#3451 both reach /implement's review through
 * scripts/lib/review-rules.js, whose test covers them; a typed /code-review
 * takes the READ half here.
 */
describe("the deviations record (mantahostels#1242)", () => {
	it("tells /code-review's Spec axis to read it", () => {
		const ctx = inject("/code-review");
		expect(ctx).toContain(
			"SPEC AXIS READS THE IMPLEMENTER'S DEVIATIONS RECORD",
		);
		expect(ctx).toContain("Declared departures");
	});

	// Cole's source says the reviewer "should not flag" a documented deviation;
	// mantahostels#1163 ruled that out here, so the injected text must say the record is
	// reported separately rather than swallowed.
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

/*
 * mantahostels#1011 — the Standards axis finds its standards only because this
 * hook names the paths (mantahostels#992): the base at the resolved core root
 * and the host's local docs/code-standards.md.
 *
 * The texts are restated in three places — this hook's `standards`, reached
 * from the /code-review branch, the four `review-standards-axis*` fragments
 * lib/review-rules.js hands a Skill-loaded review, and
 * scripts/concision-backstop.sh's Stop nag. A rename that misses one leaves
 * that route pointing at nothing, silently. This describe holds the hook and
 * one fragment; guard-review-rules.test.ts holds all four fragments, and
 * concision-backstop.test.ts the nag.
 */
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

/*
 * The base is looked for at WFC_SCRIPT_ROOT, the core root this hook resolves.
 */
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
		// A local file still on the old heading keeps its smells unraised
		// (mantahostels#994).
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
		// #886's line, which this replaces.
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

/*
 * mantahostels#1117 — both hook events are wired, so a background job whose opening prompt
 * names a tracker command fires SessionStart AND UserPromptSubmit against the
 * same prompt, handing the session the same payload twice
 * (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/tracker-injection-frequency.md).
 *
 * Suppressing the wrong firing is far worse than suppressing none: the tracker
 * rules reach the session by no other route.
 */
describe("the SessionStart/UserPromptSubmit double-fire (mantahostels#1117)", () => {
	/** One firing, keyed to a session id the way a real payload is. */
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

	/**
	 * The marker whose existence suppresses the second firing. Its mtime is the
	 * firing time, so a case ages one by rewriting that rather than by waiting.
	 */
	const marker = (session: string, cmd: string) =>
		path.join(
			SCRATCH,
			`wfc-tracker-inject-${process.getuid?.()}`,
			`${session}.${cmd}`,
		);

	/** Move a marker's mtime back by `seconds`. */
	const age = (file: string, seconds: number) => {
		const t = Date.now() / 1000 - seconds;
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
		// Nothing guarantees which event reaches the hook first.
		const s = "dup-reversed";
		expect(fire(s, "/wayfinder 1117", "UserPromptSubmit")).toContain(
			"PRICED OPTIONS",
		);
		expect(fire(s, "/wayfinder 1117", "SessionStart")).toBe("");
	});

	// Both sides of the window are pinned: a window of 1 second and a window of an
	// hour each pass a suite that only ever fires the pair back-to-back. Held a
	// few seconds off the boundary itself, an mtime being whole seconds — a case
	// aged to exactly the window lands either side of it depending on where in
	// the second it ran.
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

	// A SessionStart on a compaction boundary must NEVER be suppressed: the
	// payload has just been summarised out of the session's context, so the
	// session no longer holds it.
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
		// A marker written by an exempt firing would suppress the ordinary firing
		// that follows it, which is the under-injection this whole hook guards.
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
		// And the first command is still suppressed: recording the second must not
		// clear the marker the first wrote.
		expect(fire(s, "/implement 1117")).toBe("");
	});

	it("keys on the session, so a parallel session gets its own copy", () => {
		expect(fire("session-one", "/implement 1117")).toContain("PRICED OPTIONS");
		expect(fire("session-two", "/implement 1117")).toContain("PRICED OPTIONS");
	});

	// The payload is a function of which command matched and nothing else, so the
	// firing that is dropped carried text byte-identical to the one the session
	// kept.
	it("suppresses only a byte-identical payload", () => {
		const first = fire("identical-a", "/implement 1117", "SessionStart");
		const second = fire("identical-b", "/implement 1117 with more detail");
		expect(second).toBe(first);
	});

	// The pair's gap is inside one hook process's own runtime, so a check-then-
	// write with no atomic step loses the race and both firings inject.
	it("lets exactly one of two concurrent firings through", async () => {
		const both = await Promise.all(
			["SessionStart", "UserPromptSubmit"].map(
				(event) =>
					new Promise<string>((resolve) => {
						execFile(
							HOOK,
							{
								env: {
									...process.env,
									CLAUDE_PROJECT_DIR: ROOT,
									CLAUDE_JOB_DIR: "",
									CLAUDE_CODE_SESSION_ID: "",
									TMPDIR: SCRATCH,
								},
							},
							(_err, stdout) => resolve(stdout),
						).stdin?.end(
							JSON.stringify({
								prompt: "/implement 1117",
								hook_event_name: event,
								session_id: "concurrent-pair",
							}),
						);
					}),
			),
		);
		expect(both.filter((o) => o.trim() !== "")).toHaveLength(1);
	});

	describe("every failure path injects rather than withholding", () => {
		const twice = (session: string, env: Record<string, string> = {}) => [
			fire(session, "/implement 1117", "SessionStart", { env }),
			fire(session, "/implement 1117", "UserPromptSubmit", { env }),
		];

		it("injects both times when the payload carries no session id", () => {
			// Nothing to key on, so the hook cannot tell a duplicate from a repeat.
			const p = { prompt: "/implement 1117", hook_event_name: "SessionStart" };
			expect(run(p)).toContain("PRICED OPTIONS");
			expect(run({ ...p, hook_event_name: "UserPromptSubmit" })).toContain(
				"PRICED OPTIONS",
			);
		});

		it("injects both times when the marker cannot be written", () => {
			// TMPDIR pointed at a regular file, so the mkdir fails.
			const blocked = path.join(SCRATCH, "not-a-dir");
			fs.writeFileSync(blocked, "");
			for (const out of twice("unwritable", { TMPDIR: blocked })) {
				expect(out).toContain("PRICED OPTIONS");
			}
		});

		it("injects both times when the clock will not answer", () => {
			// A `date` that fails leaves the hook unable to judge any marker's age.
			// Reading every marker as recent instead would suppress every firing for
			// the life of the session.
			const bin = fs.mkdtempSync(path.join(SCRATCH, "nodate-"));
			fs.writeFileSync(path.join(bin, "date"), "#!/bin/sh\nexit 1\n", {
				mode: 0o755,
			});
			for (const out of twice("no-clock", {
				PATH: `${bin}:${process.env.PATH}`,
			})) {
				expect(out).toContain("PRICED OPTIONS");
			}
		});

		it("injects when a marker is dated in the future", () => {
			// A WSL2 guest clock stepping back after a host suspend leaves markers
			// ahead of `now`. Read unsigned, the window would call them recent
			// forever and the command would be dead for the rest of the session.
			const s = "future-marker";
			expect(fire(s, "/implement 1117", "SessionStart")).toContain("PRICED");
			age(marker(s, "implement"), -3600);
			expect(fire(s, "/implement 1117")).toContain("PRICED OPTIONS");
		});

		/* THE EMPTY-PROJECT-ROOT CASE IS GONE (mantahostels#1870). It drove the hook to emit
		 * nothing by giving it a root with no tracker documents in it; nothing is
		 * read off disk any more, so every firing emits and that path cannot be
		 * reached. The reservation-after-text invariant it covered is still
		 * covered — by the jq failure below, which is now the only way to make a
		 * matched command produce no text. */
		it("reserves nothing when the payload could not be built", () => {
			// emit reserves AFTER the text exists, so a jq that fails on the wrapper object leaves the session
			// with nothing and the next firing free to inject. A reservation taken
			// before the payload is known would suppress that firing instead.
			const realJq = execFileSync("bash", ["-c", "command -v jq"], {
				encoding: "utf8",
			}).trim();
			const bin = fs.mkdtempSync(path.join(SCRATCH, "badjq-"));
			fs.writeFileSync(
				path.join(bin, "jq"),
				`#!/bin/sh\nfor a in "$@"; do [ "$a" = "-nc" ] && exit 1; done\nexec ${realJq} "$@"\n`,
				{ mode: 0o755 },
			);
			const s = "jq-failed";
			const env = { PATH: `${bin}:${process.env.PATH}` };
			expect(fire(s, "/implement 1117", "SessionStart", { env })).toBe("");
			expect(fs.existsSync(marker(s, "implement"))).toBe(false);
			expect(fire(s, "/implement 1117")).toContain("PRICED OPTIONS");
		});

		it("keeps a session id from escaping the scratch directory", () => {
			// The id reaches the filesystem as a path segment. Traversal would put
			// the marker somewhere the sweep never visits — or over a real file.
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
	/*
	 * THE WHOLE OF THE GUARANTEE THIS TICKET BOUGHT. A hook payload over 10,000
	 * CHARACTERS is written to a file, and the session is handed a ~2 KB preview
	 * plus a link it followed 10.2% of the time under /implement (n=850,
	 * https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/hook-payload-persistence.md). Under the cut there is no
	 * preview and no link: the payload arrives inline and entire, so POSITION
	 * INSIDE IT STOPS MATTERING and every rule in it arrives.
	 *
	 * The constant is read out of the shipped 2.1.251 binary by mantahostels#1868 (`V5n=1e4`).
	 * THIS MODELS A CONSUMER THE REPO DOES NOT OWN: the harness can move it
	 * without anything here going red.
	 *
	 * `String.length`, not a byte count and not code points — the harness slices
	 * with `String.prototype.length`, so this must count the same units. A byte
	 * count reads ~1.5% high on a payload this dense with `§`, `—` and `→`.
	 *
	 * PERSIST_CHARS is declared at module scope, above.
	 */

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

	/* The whole priced-options shape is in no union the budget check sums, so
	 * this is its only bound (#2039). */
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

	/* The `**Bound:**`, `**Values:**` and `**Practice:**` lines, likewise: mantahostels#1844 could only assert it survived a
	 * preview. Every command but /code-review can resolve a ticket, and
	 * resolve-ticket refuses a comment missing any of them (#1801, #2325). */
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
	/*
	 * mantahostels#1870 pointed six commands at both tracker documents in full, measured
	 * followed 10.2%-38.1% of the time. mantahostels#2497 then routed every rule WITH an
	 * observable `gh` Bash shape to lib/tracker-rules.js, printed at the call
	 * that engages it. What mantahostels#2499 does: the two document pointers are gone, and
	 * what is left of each document — a rule with no such shape — is named in a
	 * per-command index instead, an id and the moment it binds, fetched with
	 * `scripts/lib/rule-text.sh <id>` only when that moment arrives.
	 */
	const sixCommands = [
		"wayfinder",
		"to-spec",
		"to-tickets",
		"implement",
		"triage",
		"card-close",
	];

	it.each(sixCommands)("gives /%s the residue index framing", (cmd) => {
		const ctx = inject(`/${cmd} 2499`);
		expect(ctx).toContain("THE TRACKER RULES ARE NOT BELOW");
		expect(ctx).toContain("docs/agents/issue-tracker.md");
		expect(ctx).toContain("docs/agents/triage-labels.md");
	});

	/* mantahostels#1118's line, carried verbatim — part of the measured result, not
	 * decoration. */
	it.each(sixCommands)(
		"carries mantahostels#1118's never-act-from-memory line verbatim on /%s",
		(cmd) => {
			expect(inject(`/${cmd} 2499`)).toContain(
				"Never act on a trigger from memory or inference",
			);
		},
	);

	/* Every index entry names an observable trigger — never the rule's own
	 * content, which lives only in docs/agents/rules/<id>.txt. */
	it.each(sixCommands)(
		"names an id and a moment, never a rule's content, on /%s",
		(cmd) => {
			const ctx = inject(`/${cmd} 2499`);
			const lines = ctx.split("\n").filter((l) => l.startsWith("- `rule:"));
			expect(lines.length).toBeGreaterThan(0);
			for (const line of lines) expect(line).toMatch(/^- `rule:[a-z-]+` — /);
		},
	);

	/*
	 * Every residue id this ticket added, and which commands' index carries it.
	 * The list is the per-command assignment this session made — read out of
	 * scripts/inject-tracker-docs.sh's own `if` chain rather than restated from
	 * memory, since that chain is the one place it is authored.
	 */
	const ruleOwners: Record<string, string[]> = {
		/* lib/tracker-rules.js prints it on each shape it names (#2023). */
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
	};

	it.each(Object.entries(ruleOwners))(
		"carries `rule:%s` only to the commands that can trigger it",
		(id, owners) => {
			for (const cmd of sixCommands) {
				const has = inject(`/${cmd} 2499`).includes(`\`rule:${id}\``);
				expect(has, `/${cmd} × ${id}`).toBe(owners.includes(cmd));
			}
		},
	);

	/* Every id named anywhere in the index answers to a real, non-empty
	 * fragment — the whole point of routing by id rather than pasting text. */
	it("names only ids docs/agents/rules/ actually answers", () => {
		/* Through readRuleText, which throws on an id with no fragment, so the
		 * selector's rule-id pass attributes each fragment (base §X10). */
		for (const id of Object.keys(ruleOwners))
			expect(readRuleText(id).trim().length, id).toBeGreaterThan(0);
	});

	/* THE TWO GUARD-ENFORCED ACTS STAY OUT OF THE INDEX — a session that trips
	 * either learns it from the guard's own deny, not from a line here. */
	it.each(sixCommands)(
		"keeps the two guard-enforced acts out of /%s's index",
		(cmd) => {
			const ctx = inject(`/${cmd} 2499`);
			expect(ctx).not.toContain("`rule:issue-body-raw-write`");
			expect(ctx).not.toContain("`rule:close-outstanding-line`");
		},
	);

	/* THE FOREGROUND LINE REPLACED THE BACKGROUND-EVERY-`gh`-CALL RULE (#523):
	 * pinned both ways, so neither the retirement nor the paste can regress. */
	it.each(sixCommands)(
		"pastes the foreground re-run line, not the background rule, into /%s",
		(cmd) => {
			const ctx = inject(`/${cmd} 2499`);
			expect(ctx).not.toContain("background every one");
			expect(ctx).not.toContain("A foreground Bash `gh` HANGS");
			expect(ctx).toContain(
				"run `gh` in the foreground, and re-run an empty result once before believing it",
			);
		},
	);

	/* THE FETCH COMMAND ITSELF MUST BE IN THE INJECTED TEXT, not only in a
	 * comment a session never sees — mantahostels#2499's own body names it: "The index
	 * tells a session to fetch with `scripts/lib/rule-text.sh <id> [<id>…]`". */
	it.each(sixCommands)(
		"names the fetch command in /%s's own payload, not just a comment",
		(cmd) => {
			expect(inject(`/${cmd} 2499`)).toContain(
				"`scripts/lib/rule-text.sh <id> [<id>…]`",
			);
		},
	);

	/* THE PASTED SET IS UNCHANGED (the ticket's own acceptance criterion): the
	 * header's three overrides, the priced-options shape, /code-review's five
	 * rules, /implement's opening step and the `**Bound:**` pointer are all
	 * covered by other describe blocks in this file — this one only re-checks
	 * that dropping the two document pointers left them alone. */
	it("still gives /implement its opening step alongside the new index", () => {
		const ctx = inject("/implement 2499");
		expect(ctx).toContain("`## Parent`");
		expect(ctx).toContain("THE TRACKER RULES ARE NOT BELOW");
	});

	it("still gives /wayfinder the `**Bound:**` line alongside the new index", () => {
		const ctx = inject("/wayfinder 2499");
		expect(ctx).toContain("**Bound:**");
		expect(ctx).toContain("THE TRACKER RULES ARE NOT BELOW");
	});

	/* DOCS is kept declared and empty rather than deleted: check-context-budget.js
	 * parses it to know what the injector adds to a session, and reads a MISSING
	 * array as a BROKEN gate rather than as nothing injected. */
	it("leaves the injector's DOCS array declared and empty", () => {
		expect(fs.readFileSync(HOOK, "utf8")).toMatch(/^DOCS=\(\)$/m);
	});

	/* The margin gate's own binding case — asserted here too, in units
	 * scripts/check-injector-margin.sh already prices, so a regression on this
	 * one command fails a test rather than only a pre-commit hook. */
	it("keeps /implement's payload the margin gate's tight headroom under the threshold", () => {
		expect(inject("/implement 2499").length).toBeLessThan(
			PERSIST_CHARS - TIGHT_HEADROOM_CHARS,
		);
	});

	/* Neither pointer reads a repo file, so the payload cannot vary with where
	 * the hook thinks the repo is — asserted as BYTE EQUALITY against a project
	 * root that holds only the output style setting, which picks the
	 * priced-options form (#2039). */
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
			expect(ctx, cmd).toBe(inject(`/${cmd} 2499`));
			expect(ctx, cmd).toContain(`You invoked /${cmd}`);
		}
	});
});

/*
 * In an adopter the plugin's commands arrive namespaced — `/workflow-core:wayfinder`,
 * the spelling Claude Code's own menu produces for a plugin command. Only this
 * repo, which also holds the commands locally, sees the bare `/wayfinder`.
 *
 * Matching bare-only dropped the entire payload for such a session, silently
 * (#201).
 */
describe("the plugin namespace on a command is optional (#201)", () => {
	/* Every entry of the hook's own COMMANDS, `code-review` included — it takes
	 * an early branch of its own, so a list short of it leaves that branch
	 * untested for the namespaced spelling. */
	const namespacedCommands = [
		"wayfinder",
		"to-spec",
		"to-tickets",
		"implement",
		"triage",
		"card-close",
		"code-review",
	];

	/* The non-empty assertion is inside the loop, not beside it: `inject`
	 * returns "" on no match, so an equality against the bare spelling alone
	 * would pass on two empties. */
	it.each(namespacedCommands)(
		"injects for /workflow-core:%s exactly as for the bare spelling",
		(cmd) => {
			const ctx = inject(`/workflow-core:${cmd} 201`);
			expect(ctx.length).toBeGreaterThan(1000);
			expect(ctx).toBe(inject(`/${cmd} 201`));
		},
	);

	/* `workflow-core` is the PLUGIN's name, which whoever ships the plugin sets
	 * in plugin.json — so a hardcoded prefix would fix this repo and no fork. */
	it("accepts any plugin name as the prefix, not only workflow-core", () => {
		expect(inject("/my-fork:implement 201")).toBe(inject("/implement 201"));
	});

	/* The optional prefix must not have loosened the word boundary the bare
	 * match already guaranteed. */
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
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inject-takes-"));
	afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
	const log = path.join(dir, "gh.log");
	const label = path.join(dir, "label");
	const stub = stubGhScript(
		dir,
		`#!/bin/sh\necho "$@" >> ${log}\ncat ${label}\n`,
	);
	beforeEach(() => fs.rmSync(log, { force: true }));
	const readCalls = () =>
		fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";

	const typed = (
		prompt: string,
		takes: string,
		gh = stub.gh,
		env: Record<string, string> = {},
	) => {
		fs.writeFileSync(label, takes);
		return run(
			{ prompt, hook_event_name: "UserPromptSubmit" },
			{ WFC_GH: gh, ...env },
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
		const failing = stubGhScript(path.join(dir, "failing"), "", {
			failing: true,
		});
		expect(typed("/wayfinder 7", "", failing.gh)).toBe(inject("/wayfinder 7"));
	});

	it("gives up on a hung gh at a 1 s give-up the test sets, injecting the usual payload", () => {
		const slow = stubGhScript(
			path.join(dir, "slow"),
			"#!/bin/sh\nsleep 30\necho takes:implement\n",
		);
		// §X9: a kill of a real hung gh, through a 1 s give-up so load cannot eat
		// the margin (#2268); a hook that never gave up outruns the case's 15 s.
		// Residual: a hook ignoring the seam falls back to 4 s and passes too.
		expect(
			typed("/wayfinder 7", "", slow.gh, { WFC_TAKES_GH_TIMEOUT_S: "1" }),
		).toBe(inject("/wayfinder 7"));
	}, 15_000);

	// The gh give-up alone, not the whole hook run, against each registration.
	it("gives up on gh inside every timeout the self-plugin and the plugin manifest register", () => {
		const giveUp = readShellConst(HOOK, "TAKES_GH_TIMEOUT_S");
		for (const file of [
			path.join(ROOT, "self-plugin", "hooks", "hooks.json"),
			path.join(ROOT, "hooks", "hooks.json"),
		]) {
			const settings = JSON.parse(fs.readFileSync(file, "utf8"));
			const wired = (["UserPromptSubmit", "SessionStart"] as const).flatMap(
				(event) => registrationsOf(event, "inject-tracker-docs.sh", settings),
			);
			expect(wired.length, file).toBeGreaterThan(0);
			for (const { timeout } of wired) {
				expect(
					timeout,
					`${file} registers the hook with no timeout`,
				).toBeDefined();
				expect(giveUp, file).toBeLessThan(timeout as number);
			}
		}
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
		const env = { WFC_GH: stub.gh };
		const fire = (prompt: string, takes: string) => {
			fs.writeFileSync(label, takes);
			return run(
				{
					prompt,
					hook_event_name: "UserPromptSubmit",
					session_id: "takes-dup",
				},
				env,
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
