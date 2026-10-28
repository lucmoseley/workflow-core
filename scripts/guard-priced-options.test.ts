// @vitest-environment node
/*
 * guard-priced-options.js blocks a turn that puts the founder a question not in
 * the lettered priced form, and the status-marker limbs a background job's
 * ending owes, each bounded by its block cap (mantahostels#802, why a Stop hook;
 * mantahostels#785, the background-job marker).
 *
 * Driven end-to-end through the CLI — a payload on stdin, a transcript on disk,
 * the block JSON on stdout. One case loads the module in-process, for the
 * escape pattern the refusal text must not drift from (#1008).
 *
 * It runs at every `Stop` (`self-plugin/hooks/hooks.json`, `hooks/hooks.json`)
 * and is the only enforcement of core-voice's priced-options rule: loosen a
 * case and an unpriced choice reaches the founder, or a job waiting on him is
 * filed Completed; tighten one and a well-formed turn is refused.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXEMPT_NAMES } from "./lib/priced-options-testkit";
import { runInProcess } from "./lib/run-in-process";
import {
	readStopGuardBlock,
	readStopGuardBlockWithin,
	type StopBlock,
} from "./lib/stop-guard-testkit";
import { buildBashCall, researchCalls } from "./lib/transcript-testkit";
import { readProgramLibs } from "./lib-closure-fixture";

/* The breadcrumb directory, from the module that owns it (mantahostels#3382). */
const hookRecord = createRequire(__filename)("./lib/hook-record.js");

/* The block counters (`*-nagged-<sid>`) live under gr_markers_dir
 * (.claude/tmp/markers), not the throwaway root itself — hook-block.js's
 * counterPath (mantahostels#3515 F8, issue #2). */
const { markersDir } = createRequire(__filename)("./lib/marker-root.js");

const GUARD = path.join(__dirname, "guard-priced-options.js");

/* A top figure two steps clear of the low-top line, for the rounds that test
 * something else: a re-rule of LOW_TOP moves them with it (#2538). */
const { CLOSE_GAP, LOW_TOP } = createRequire(__filename)(
	"./lib/close-rivals.js",
);
const LIKELY_TOP = LOW_TOP + 10;

/** A headline figure with a ten-point band, as a `Confidence:` line gives it. */
const priced = (figure: number) =>
	`${figure}% (${figure - 5}% - ${figure + 5}%)`;

let dir: string;
let sid: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "priced-options-"));
	sid = `test-session-${Math.random().toString(36).slice(2)}`;
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/*
 * A background Bash call with no settling notification, for the fixtures whose
 * message ends on `waiting:`. Since mantahostels#2487 that marker is verified against the
 * transcript, so a hand-off turn needs a launch actually out in the file it is
 * judged from.
 */
const PENDING_LAUNCH = buildBashCall("sleep 60", "toolu_pending", {
	input: { run_in_background: true },
});

/**
 * A transcript whose outgoing message is `text`, preceded by a user turn and
 * enough research that the under-researched-round limb (#1710) passes it.
 */
function transcriptWith(text: string, extra: object[] = []): string {
	const file = path.join(dir, `${sid}.jsonl`);
	const records = [
		{ type: "user", message: { content: "the founder's question" } },
		...researchCalls(),
		...extra,
		{ type: "assistant", message: { content: [{ type: "text", text }] } },
	];
	fs.writeFileSync(
		file,
		`${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
	);
	return file;
}

/*
 * The needs-input check keys off CLAUDE_JOB_DIR, which vitest inherits when the
 * suite is itself run from a background job. Every runner below sets it
 * explicitly.
 */
/** One channel (mantahostels#2350): `reason` carries the whole correction. */
type Block = StopBlock;

/* `stdin` is spawnSync's `input` under the name the seam uses. */
const runGuardCli = (opts: {
	stdin: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}) =>
	runInProcess(GUARD, [], {
		...opts,
		env: { ...opts.env, CLAUDE_CONFIG_DIR: path.join(dir, "config") },
	});

/**
 * A `null` `jobDir` runs the guard as an interactive session. `extra`
 * overrides the runner's environment; an `undefined` in it unsets.
 */
const runGuard = (
	transcript: string,
	jobDir: string | null,
	extra: NodeJS.ProcessEnv = {},
): Block | null =>
	readStopGuardBlock(GUARD, {
		dir,
		sid,
		transcript,
		job: jobDir ?? false,
		env: extra,
	});

/** Run the guard as an interactive session; null when it allowed the stop. */
function run(transcript: string): Block | null {
	return runGuard(transcript, null);
}

/**
 * Run the guard with the turn's text on the payload, as the harness supplies it
 * (mantahostels#1273), and no transcript to fall back to — so only the payload can answer.
 */
const runWithMessage = (message: string) =>
	readStopGuardBlock(GUARD, { dir, sid, message });

/**
 * Run the guard as a background job with the turn's text on the payload and no
 * transcript behind it (mantahostels#1254).
 */
const runInJobWithMessage = (message: string) =>
	readStopGuardBlock(GUARD, { dir, sid, message, job: dir });

/** Run the guard as a background job, where the status line can be mislabelled. */
function runInJob(transcript: string): Block | null {
	return runGuard(transcript, dir);
}

/** GOOD's runner-up, priced so the pair sums to 100. */
const GOOD_B = `Confidence: ${priced(100 - LIKELY_TOP)}.`;

const GOOD = `Two things to settle.

❓ **Q1** - **Expiry period**: How long should a reward code stay redeemable?

(A) Twelve months from issue
Confidence: ${priced(LIKELY_TOP)}. Matches the booking season most members return in.

(B) No expiry at all
${GOOD_B} Simplest to explain, but leaves an open liability.

Relation: (A) and (B) conflict on the expiry date itself — a code cannot both lapse and not lapse.

➡️ (A).`;

/*
 * mantahostels#2583 obliges a round above any `needs input:` in a background job, so a
 * fixture isolating one of the MARKER limbs carries a well-formed round to keep
 * the new limb out of its way.
 */
const withRound = (text: string) => `${GOOD}\n\n${text}`;

/* A re-rule that breaks one of these leaves a fixture built on LIKELY_TOP
 * passing without testing what its case names: re-shape that fixture. */
describe("the figures derived from LIKELY_TOP", () => {
	it("keep every band between 0 and 100", () => {
		for (const figure of [
			LIKELY_TOP,
			100 - LIKELY_TOP,
			100 - LIKELY_TOP - 10,
		]) {
			expect(figure - 5, String(figure)).toBeGreaterThanOrEqual(0);
			expect(figure + 5, String(figure)).toBeLessThanOrEqual(100);
		}
	});

	it("keep GOOD's pair apart, and the no-sum pair's sum off 100", () => {
		expect(LIKELY_TOP - (100 - LIKELY_TOP)).toBeGreaterThan(CLOSE_GAP);
		expect(Math.abs(LIKELY_TOP + 10 - 100)).toBeGreaterThan(5);
	});
});

describe("a well-formed round", () => {
	it("allows the stop", () => {
		expect(run(transcriptWith(GOOD))).toBeNull();
	});

	it("allows an en-dash band and a three-digit figure", () => {
		const text = GOOD.replace(
			priced(LIKELY_TOP),
			`${LIKELY_TOP}% (${LIKELY_TOP - 5}% – 100%)`,
		);
		expect(text).not.toBe(GOOD);
		expect(run(transcriptWith(text))).toBeNull();
	});
});

describe("scope", () => {
	it("ignores a message carrying no round marker, questions and all", () => {
		const text = "Should we do this? I think yes. Maybe (A) or (B), unpriced.";
		expect(run(transcriptWith(text))).toBeNull();
	});

	it("ignores a subagent's message and reads only the outgoing one", () => {
		const file = transcriptWith(GOOD, [
			{
				type: "assistant",
				isSidechain: true,
				message: {
					content: [{ type: "text", text: "❓ **Q9** - **Bad**: pick one." }],
				},
			},
		]);
		expect(run(file)).toBeNull();
	});

	it("does not reach back past the last user turn", () => {
		const file = path.join(dir, `${sid}.jsonl`);
		fs.writeFileSync(
			file,
			`${[
				{
					type: "assistant",
					message: {
						content: [{ type: "text", text: "❓ **Q8** - **Old**: pick." }],
					},
				},
				{ type: "user", message: { content: "next" } },
				{
					type: "assistant",
					message: { content: [{ type: "text", text: "All done." }] },
				},
			]
				.map((r) => JSON.stringify(r))
				.join("\n")}\n`,
		);
		expect(run(file)).toBeNull();
	});
});

describe("the defects it names", () => {
	it("catches choices in prose with one recommendation", () => {
		const text = `❓ **Q1** - **Expiry period**: Should a code last twelve months, or never expire? Twelve months matches the season; no expiry is simpler but leaves a liability.

➡️ Twelve months.`;
		const block = run(transcriptWith(text));
		expect(block?.decision).toBe("block");
		expect(block?.reason).toContain("Q1: it offers no lettered options at all");
	});

	it("catches options listed as a numbered list", () => {
		const text = `❓ **Q2** - **Expiry**: Which?

1. Twelve months
2. No expiry

➡️ 1.`;
		expect(run(transcriptWith(text))?.reason).toContain(
			"Q2: its options are listed as a numbered list",
		);
	});

	it("catches options listed as a bulleted list", () => {
		const text = `❓ **Q3** - **Expiry**: Which?

- Twelve months
- No expiry

➡️ The first.`;
		expect(run(transcriptWith(text))?.reason).toContain(
			"Q3: its options are listed as a bulleted list",
		);
	});

	it("names the specific lettered option missing a Confidence line", () => {
		const text = GOOD.replace(
			`${GOOD_B} Simplest to explain, but leaves an open liability.`,
			"Simplest to explain.",
		);
		const reason = run(transcriptWith(text))?.reason ?? "";
		expect(reason).toContain("option (B) carries no Confidence line");
		/* Scoped to the defect line, the only place a letter should appear. */
		const defectLine =
			reason.split("\n").find((l) => l.startsWith("Q1:")) ?? "";
		expect(defectLine).not.toContain("(A)");
	});

	it("catches a bare percentage with no error band, naming the option", () => {
		const text = GOOD.replace(GOOD_B, `Confidence: ${100 - LIKELY_TOP}%.`);
		expect(run(transcriptWith(text))?.reason).toContain(
			"option (B) gives a bare percentage with no error band",
		);
	});

	it("catches a table", () => {
		const text = `❓ **Q4** - **Expiry**: Which?

| Option | Confidence |
| --- | --- |
| Twelve months | 62% (55% - 70%) |
| No expiry | 25% (15% - 35%) |

➡️ Twelve months.`;
		expect(run(transcriptWith(text))?.reason).toContain(
			"lays the options out as a table",
		);
	});

	it("catches a horizontal rule between options", () => {
		const text = GOOD.replace(
			"(B) No expiry at all",
			"---\n\n(B) No expiry at all",
		);
		expect(run(transcriptWith(text))?.reason).toContain(
			"separates the options with a horizontal rule",
		);
	});

	it("reports every defective question in one block", () => {
		const text = `❓ **Q1** - **A**: which?

1. this
2. that

❓ **Q2** - **B**: which?

- this
- that`;
		const reason = run(transcriptWith(text))?.reason ?? "";
		expect(reason).toContain("Q1:");
		expect(reason).toContain("Q2:");
		expect(reason).toContain("2 of them break");
	});

	it("leaves a well-formed question out of the defect list", () => {
		const text = `${GOOD}\n\n❓ **Q2** - **Owner**: who owns it?\n\n1. me\n2. you`;
		const reason = run(transcriptWith(text))?.reason ?? "";
		expect(reason).toContain("Q2:");
		expect(reason).not.toContain("Q1:");
		expect(reason).toContain("1 of them break");
	});
});

describe("the escape", () => {
	it("allows an option that declares its figure unknowable", () => {
		const text = `❓ **Q5** - **Timing**: When will the regulator answer?

(A) Within a quarter
Confidence: unknowable — no published service standard exists.

(B) Longer
Confidence: unknowable — same reason.

Relation: (A) and (B) are mutually exclusive — the answer is one date or the other.

➡️ Plan for (B).`;
		expect(run(transcriptWith(text))).toBeNull();
	});

	it("allows the escape in the word the rule's comment uses (#1008)", () => {
		const text = GOOD.replace(
			`${GOOD_B} Simplest to explain, but leaves an open liability.`,
			"Confidence: genuinely ungroundable.",
		);
		expect(run(transcriptWith(text))).toBeNull();
	});

	describe("as the refusal teaches it (#1008)", () => {
		const unpriced = GOOD.replace(`${GOOD_B} `, "");
		const reason = () => run(transcriptWith(unpriced))?.reason ?? "";

		/* The escape words as the guard declares them, pinned here so a word
		 * dropped from the refusal turns this red. The case below feeds back
		 * whatever the refusal names, so a word dropped from the pattern alone
		 * turns that one red. */
		it("names every escape word", () => {
			const words = [
				"unknowable",
				"ungroundable",
				"unquantifiable",
				"not quantifiable",
				"subjective",
			];
			const text = reason();
			for (const w of words) expect(text).toContain(`\`${w}\``);
		});

		it("passes each word it recommends, fed back", () => {
			const list = reason().match(/say why — ((?:`[^`]+`(?:, )?)+)/)?.[1];
			const words = [...(list ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1]);
			expect(words.length).toBeGreaterThan(1);
			for (const w of words) {
				const fixed = unpriced.replace(
					"Simplest to explain, but leaves an open liability.",
					`Confidence: ${w} — it turns on how members read it.`,
				);
				expect(run(transcriptWith(fixed)), w).toBeNull();
			}
		});
	});

	it("does not let one option's escape cover another's missing price", () => {
		const text = `❓ **Q6** - **Timing**: Which?

(A) Within a quarter
Confidence: unknowable — no published service standard.

(B) Longer
Because it feels slow.

Relation: (A) and (B) conflict on the date.

➡️ (B).`;
		expect(run(transcriptWith(text))?.reason).toContain(
			"option (B) carries no Confidence line",
		);
	});
});

describe("the message it sends back", () => {
	const blocked = () => run(transcriptWith("❓ **Q1** - **X**: pick one."));

	it("prints no round template back at the founder", () => {
		const block = blocked();
		const whole = block?.reason ?? "";
		expect(whole).not.toContain("❓");
		expect(whole).not.toContain("Confidence:");
		expect(whole).not.toContain("(A) <the first option");
	});

	/* mantahostels#2319, mantahostels#2335, mantahostels#2350. */
	it("opens on the machine-directed notice, then the whole correction", () => {
		const block = blocked();
		const reason = block?.reason ?? "";
		const [notice, ...rest] = reason.split("\n\n");
		expect(notice).toContain("machine-directed");
		expect(notice).toContain("nothing for you to answer");
		expect(reason).toContain("Q1:");
		expect(rest.join("\n\n")).toContain("RE-SEND");
	});

	it("emits no systemMessage at all", () => {
		expect(blocked()).not.toHaveProperty("systemMessage");
	});

	it("names no question where the fault was not a question's", () => {
		/* A misplaced `result:` marker faults the turn, not a question — so there
		 * is no corrected question coming and the notice must not imply one. */
		const reason =
			runInJobWithMessage("Landed it.\n\nresult: done\n\nShall I push?")
				?.reason ?? "";
		expect(reason).not.toContain("Q1:");
	});

	it("asks for the corrected question only, indexed by a needs-input line", () => {
		const reason = blocked()?.reason ?? "";
		expect(reason).toContain("RE-SEND ONLY THE CORRECTED QUESTION");
		expect(reason).toContain("not the whole round");
		expect(reason).toContain("`needs input:` line enumerating");
	});

	/* The style is read off `dir`'s config, not the runner's (#448). */
	const blockedAt = () =>
		runGuard(transcriptWith("❓ **Q1** - **X**: pick one."), null, {
			WFC_OUTPUT_STYLE: undefined,
		})?.reason ?? "";

	it("points at core-voice.md where the host declares no output style", () => {
		const reason = blockedAt();
		expect(reason).toContain("`.claude/output-styles/core-voice.md`");
	});

	it("points at the host's declared output style (#448)", () => {
		fs.mkdirSync(path.join(dir, ".claude"));
		fs.writeFileSync(
			path.join(dir, ".claude", "workflow-core.json"),
			JSON.stringify({
				overrides: { output_style: ".claude/output-styles/manta-voice.md" },
			}),
		);
		const reason = blockedAt();
		expect(reason).toContain("`.claude/output-styles/manta-voice.md`");
		expect(reason).not.toContain("core-voice.md");
	});

	it("says the two templates compose, so the round marker is not the defect", () => {
		const reason = blocked()?.reason ?? "";
		expect(reason).toContain("compose");
	});

	it("forbids inventing a figure to satisfy the check", () => {
		const reason =
			run(transcriptWith("❓ **Q1** - **X**: pick one."))?.reason ?? "";
		expect(reason).toContain("a figure you made up to satisfy this check");
	});
});

describe("the loop is bounded", () => {
	it("blocks three times then lets the turn through", () => {
		const file = transcriptWith("❓ **Q1** - **X**: pick one.");
		expect(run(file)?.decision).toBe("block");
		expect(run(file)?.decision).toBe("block");
		expect(run(file)?.decision).toBe("block");
		expect(run(file)).toBeNull();
	});

	it("counts nothing on a turn it allows", () => {
		const good = transcriptWith(GOOD);
		expect(run(good)).toBeNull();
		expect(
			fs.existsSync(
				path.join(markersDir(dir), `.priced-options-nagged-${sid}`),
			),
		).toBe(false);
	});
});

describe("it fails silent", () => {
	it("exits 0 and says nothing on a payload that is not JSON", () => {
		const res = runGuardCli({
			stdin: "not json",
			cwd: dir,
			env: { ...process.env, WFC_REPO_ROOT: dir },
		});
		expect(res.status).toBe(0);
		expect(res.stdout.trim()).toBe("");
	});

	it("exits 0 and says nothing when the transcript is missing", () => {
		expect(run(path.join(dir, "absent.jsonl"))).toBeNull();
	});

	it("exits 0 and says nothing on a transcript of unparseable lines", () => {
		const file = path.join(dir, `${sid}.jsonl`);
		fs.writeFileSync(file, "{{{\nnot json\n");
		expect(run(file)).toBeNull();
	});

	it("exits 0 and says nothing with no session_id", () => {
		const res = runGuardCli({
			stdin: "{}",
			cwd: dir,
			env: { ...process.env, WFC_REPO_ROOT: dir },
		});
		expect(res.status).toBe(0);
		expect(res.stdout.trim()).toBe("");
	});
});

describe("the two checks the injected rule also states", () => {
	it("catches a bold or titled option name", () => {
		const text = GOOD.replace(
			"(B) No expiry at all",
			"(B) **No expiry** at all",
		);
		expect(run(transcriptWith(text))?.reason).toContain(
			"option (B) gives the option a bold or titled name",
		);
	});

	/* `toBeNull` and not `not.toContain`: the weaker form passes on any
	 * unrelated defect, so it would stop testing bold the moment something else
	 * in the fixture drifted. */
	it("leaves bold alone inside an option's prose (mantahostels#1722)", () => {
		const text = GOOD.replace(
			"(B) No expiry at all",
			"(B) No expiry at all, which preserves the **Outstanding:** ritual",
		);
		expect(run(transcriptWith(text))).toBeNull();
	});

	/* A round repeating a letter would otherwise be shown its innocent line and
	 * told that one was bold. */
	it("quotes the offending line, not the first sharing its letter (mantahostels#1722)", () => {
		const text = GOOD.replace(
			"(B) No expiry at all",
			"(B) No expiry at all\n\n(B) **Titled** twin",
		);
		const reason = run(transcriptWith(text))?.reason ?? "";
		expect(reason).toContain("(B) opens `(B) **Titled** twin");
	});

	it("catches a recommendation that names no letter", () => {
		const text = GOOD.replace("➡️ (A).", "➡️ Twelve months.");
		expect(run(transcriptWith(text))?.reason).toContain(
			"its recommendation does not name an option by its letter",
		);
	});

	it("accepts a recommendation that names its letter in a sentence", () => {
		const text = GOOD.replace(
			"➡️ (A).",
			"➡️ Go with (A), unless the season data shifts.",
		);
		expect(run(transcriptWith(text))).toBeNull();
	});

	it("does not demand a letter when there are no lettered options to name", () => {
		const reason =
			run(transcriptWith("❓ **Q1** - **X**: pick one.\n\n➡️ Whatever."))
				?.reason ?? "";
		expect(reason).not.toContain("does not name an option by its letter");
	});
});

describe("the needs-input marker a background job owes (mantahostels#785)", () => {
	it("blocks a well-formed round that carries no marker", () => {
		const reason = runInJob(transcriptWith(GOOD))?.reason ?? "";
		expect(reason).toContain("needs input:");
		expect(reason).toContain("nothing but a human will wake this session");
	});

	it("allows the same round once the marker is there", () => {
		const text = `${GOOD}\n\nneeds input: which expiry period to publish.`;
		expect(runInJob(transcriptWith(text))).toBeNull();
	});

	it("reads the marker only on a line of its own", () => {
		const text = `${GOOD}\n\nI have no idea what it needs input: for.`;
		expect(runInJob(transcriptWith(text))?.reason ?? "").toContain(
			"needs input:",
		);
	});

	it("does not fire in an interactive session, which has no status line", () => {
		expect(run(transcriptWith(GOOD))).toBeNull();
	});

	it("does not fire on a turn that asks the founder nothing", () => {
		/* Carries `result:` so mantahostels#1200's missing-marker check stays out of the way:
		 * what is under test is that a question-less turn owes no needs-input. */
		expect(
			runInJob(
				transcriptWith("Landed the fix and pushed it.\n\nresult: fix pushed."),
			),
		).toBeNull();
	});

	it("reports the format defect and the missing marker together", () => {
		const text = GOOD.replace(`${GOOD_B} `, "");
		const reason = runInJob(transcriptWith(text))?.reason ?? "";
		expect(reason).toContain("carries no Confidence line");
		expect(reason).toContain("needs input:");
	});
});

describe("a result: that is still waiting on the founder (mantahostels#822)", () => {
	const offer =
		"Assessed the three CLIs. shellcheck is the one worth adding.\n\n" +
		"result: three CLIs assessed, shellcheck recommended.\n\n" +
		"Say the word and I'll add shellcheck plus the wiring.";

	it("blocks the message that motivated it, quoting its offer and pointing to needs input:", () => {
		const reason = runInJob(transcriptWith(offer))?.reason ?? "";
		expect(reason).toContain("say the word");
		expect(reason).toContain("needs input:");
	});

	it("does not fire in an interactive session, which has no status line", () => {
		expect(run(transcriptWith(offer))).toBeNull();
	});

	it("allows a completion that offers nothing back", () => {
		const text =
			"Landed the fix, ran the suite green and pushed it.\n\n" +
			"result: shellcheck wired into npm run lint, suite green.";
		expect(runInJob(transcriptWith(text))).toBeNull();
	});

	it("allows an approval-seeking message that claims no result", () => {
		const text =
			"Assessed the three CLIs. Shall I add shellcheck?\n\n" +
			"needs input: whether to add it.";
		expect(runInJob(transcriptWith(withRound(text)))).toBeNull();
	});

	it("reads result: only on a line of its own", () => {
		/* The inline "result:" must not arm this check; the trailing marker is
		 * mantahostels#1200's check, not this one's. */
		const text =
			"The result: nothing worth adding. Say the word and I'll stop there.\n\n" +
			"needs input: whether to stop there.";
		expect(runInJob(transcriptWith(withRound(text)))).toBeNull();
	});

	it.each([
		["Shall I wire it in?", "shall i"],
		["Want me to wire it in?", "want me to"],
		["Would you like me to wire it in?", "would you like me to"],
		["Let me know if you want the wiring too.", "let me know if"],
		["I'll add the wiring if you want it.", "i'll … if you"],
		["The change is pending approval.", "pending approval"],
		["I'm ready to add the wiring.", "ready to"],
		["I can add the wiring if you'd like.", "if you'd like"],
	])("catches %j", (phrase, gist) => {
		const text = `result: assessed.\n\n${phrase}`;
		expect(runInJob(transcriptWith(text))?.reason ?? "").toContain(gist);
	});

	it("leaves a bare 'ready to' about the work alone", () => {
		const text = "result: the branch is ready to merge, suite green.";
		expect(runInJob(transcriptWith(text))).toBeNull();
	});

	it("says how to clear it", () => {
		const reason = runInJob(transcriptWith(offer))?.reason ?? "";
		expect(reason).toContain("needs input:");
		expect(reason).toContain("result:");
	});

	it("reports all four defects in one block, charging each counter (mantahostels#2786)", () => {
		const text =
			GOOD.replace(`${GOOD_B} `, "") +
			"\n\nresult: expiry options priced.\n\nSay the word and I'll implement (A).";
		const transcript = transcriptWith(text);
		/* Four counters, spent TOGETHER: the round's shape, its missing marker,
		 * the approval-seeking `result:`, and the report sitting below that
		 * marker. Each still keeps its own three, so three blocks
		 * exhaust all four at once and the fourth stop is allowed. */
		const phrases = [
			"carries no Confidence line",
			"nothing but a human will wake this session",
			"say the word",
			"and then keeps going",
		];
		for (let i = 0; i < 3; i++) {
			const reason = runInJob(transcript)?.reason ?? "";
			for (const phrase of phrases) expect(reason).toContain(phrase);
		}
		expect(runInJob(transcript)).toBeNull();
	});
});

describe("an offer of work beyond the delivered task (mantahostels#2445)", () => {
	const nextTicket =
		"Landed the fix, suite green, pushed.\n\n" +
		"result: #2401 closed, the root-scratch warn now latches once a session.\n\n" +
		"Want me to take #2403 next?";

	it("leads with deleting the offer, not with switching marker", () => {
		const reason = runInJob(transcriptWith(nextTicket))?.reason ?? "";
		expect(reason).toContain("want me to");
		expect(reason).toContain("offers to take on the next ticket");
		expect(reason).toContain("Do NOT switch to `needs input:`");
		expect(reason).toContain("`/pick-next`'s call");
		/* "leads with" is an ordering claim, so assert the order. */
		expect(reason.indexOf("delete the")).toBeLessThan(
			reason.indexOf("Switch to `needs input:`"),
		);
	});

	it("keeps the escape's other half — dropping the result: line", () => {
		const reason = runInJob(transcriptWith(nextTicket))?.reason ?? "";
		expect(reason).toContain("dropping the `result:` line");
	});

	it("catches an offer naming a command rather than a number", () => {
		const text =
			"result: map charted.\n\nShall I run /wayfinder on it from here?";
		const reason = runInJob(transcriptWith(text))?.reason ?? "";
		expect(reason).toContain("offers to take on the next ticket");
	});

	it("catches an offer naming the next unit of work in words", () => {
		const text =
			"result: #2401 closed.\n\nLet me know if you want the next ticket opened.";
		const reason = runInJob(transcriptWith(text))?.reason ?? "";
		expect(reason).toContain("offers to take on the next ticket");
	});

	it("reads a slash command only where one can start, never inside a path", () => {
		/* `\b` closes on the following slash, so an unanchored limb read
		 * `docs/research/…` as `/research`. */
		const text =
			"result: findings landed.\n\n" +
			"They sit in docs/agents/triage-labels.md — want me to fold them in?";
		const reason = runInJob(transcriptWith(text))?.reason ?? "";
		expect(reason).toContain("still asks the founder for approval");
		expect(reason).not.toContain("offers to take on the next ticket");
	});

	it("keeps the original refusal where a blocking ask sits alongside", () => {
		/* The first offer is a real decision; only the second is next-work. The
		 * founder is blocked, so the marker-switch advice is the right one — and
		 * the blocking ask must not be quoted back as evidence of further work. */
		const text =
			"result: assessed.\n\nShall I use the wider timeout?\n\n" +
			"Separately, want me to take #2403 next?";
		const reason = runInJob(transcriptWith(text))?.reason ?? "";
		expect(reason).toContain("still asks the founder for approval");
		expect(reason).not.toContain("offers to take on the next ticket");
	});

	it("names every gist when all of them are next-work offers", () => {
		const text =
			"result: #2401 closed.\n\nWant me to take #2403 next? " +
			"Shall I open #2404 as well?";
		const reason = runInJob(transcriptWith(text))?.reason ?? "";
		expect(reason).toContain("want me to");
		expect(reason).toContain("shall i");
	});

	it("gives the same advice when its own refusal is pasted back", () => {
		/* The gists sit in a sentence carrying a further-work token, so the
		 * quoted block re-enters on the branch that emitted it. */
		const emitted = runInJob(transcriptWith(nextTicket))?.reason ?? "";
		const reason =
			runInJob(transcriptWith(`Blocked earlier with:\n\n${emitted}`))?.reason ??
			"";
		expect(reason).not.toContain("still asks the founder for approval");
	});

	it("leaves an offer about the delivered task on the original refusal", () => {
		const text =
			"result: three CLIs assessed, shellcheck recommended.\n\n" +
			"Say the word and I'll add shellcheck plus the wiring.";
		const reason = runInJob(transcriptWith(text))?.reason ?? "";
		expect(reason).toContain("still asks the founder for approval");
		expect(reason).not.toContain("offers to take on the next ticket");
	});

	it("wants the offer and the ticket in one sentence, not merely one message", () => {
		/* The `result:` line cites the ticket it closed; the offer below is about
		 * this task. Reading the whole message at once would misfire here. */
		const text =
			"result: #2401 closed, suite green.\n\n" +
			"Say the word and I'll add the wiring too.";
		const reason = runInJob(transcriptWith(text))?.reason ?? "";
		expect(reason).toContain("still asks the founder for approval");
		expect(reason).not.toContain("offers to take on the next ticket");
	});

	it("splits on a full stop too, not only on a line break", () => {
		const text =
			"result: #2401 closed, suite green. Say the word and I'll add the wiring.";
		const reason = runInJob(transcriptWith(text))?.reason ?? "";
		expect(reason).toContain("still asks the founder for approval");
		expect(reason).not.toContain("offers to take on the next ticket");
	});

	it("does not fire in an interactive session", () => {
		expect(run(transcriptWith(nextTicket))).toBeNull();
	});
});

describe("a needs input: the message then undercuts (mantahostels#85)", () => {
	const ask =
		"Two options, both priced above.\n\nneeds input: pick a schedule (A, B or C)";

	it("blocks a marker that promises the session will keep working, quoting the promise", () => {
		const text = `${ask}. I'll then build the gate and set the date.`;
		const reason = runInJob(transcriptWith(text))?.reason ?? "";
		expect(reason).toContain("promises to keep working");
		expect(reason).toContain("I'll then build");
	});

	it("hands a promise in a paragraph BELOW the marker to the placement check", () => {
		/* Since #228 the marker must be last, so a promise under it is not a
		 * second defect and does not charge a second counter. */
		const text = `${ask}.\n\nOnce you answer I will draft the chase email.`;
		const reason = runInJob(transcriptWith(text))?.reason ?? "";
		expect(reason).toContain("characters sit below it");
		expect(reason).not.toContain("promises to keep working");
	});

	it("allows a marker that asks for the decision and stops", () => {
		expect(runInJob(transcriptWith(withRound(`${ask}.`)))).toBeNull();
	});

	it("allows the promise when it sits above the marker", () => {
		// Same words, ordered so the last thing the classifier reads is the ask.
		const text = `With a schedule chosen I will build the gate.\n\n${ask}.`;
		expect(runInJob(transcriptWith(withRound(text)))).toBeNull();
	});

	it("does not read a first person that is not a promise of work", () => {
		const text = `${ask}. I can't tell which you'd prefer and I'd rather not guess.`;
		expect(runInJob(transcriptWith(withRound(text)))).toBeNull();
	});

	it("blocks a marker whose own line runs past the window, giving its distance from the end in characters", () => {
		/* Since #228 everything BELOW the marker is `needsInputMisplaced`'s, which
		 * leaves this limb the one over-long case that has nothing below it to
		 * find: the marker's own line overrunning the window. */
		const text = `needs input: ${"pick one of these and then. ".repeat(200)}`;
		const reason = runInJob(transcriptWith(text))?.reason ?? "";
		expect(reason).toContain("characters from the end");
		expect(reason).toContain("cannot see the marker at all");
	});

	it("leaves a marker with prose below it to the placement check", () => {
		const text = `${ask}.\n\n${"filler prose. ".repeat(400)}`;
		const reason = runInJob(transcriptWith(text))?.reason ?? "";
		expect(reason).toContain("characters sit below it");
		expect(reason).not.toContain("cannot see the marker at all");
	});

	it("does not fire in an interactive session, which has no status line", () => {
		const text = `${ask}. I'll then build the gate and set the date.`;
		expect(run(transcriptWith(text))).toBeNull();
	});

	it("measures the last marker, not one quoted earlier in the message", () => {
		// A message that pastes a block reason back quotes the marker near the top.
		// Measuring from there would call the real marker at the end unreachable.
		const quoted = "Blocked earlier with:\n\nneeds input: <the decision>\n\n";
		const text = `${quoted}${"filler prose. ".repeat(400)}\n\n${ask}.`;
		expect(runInJob(transcriptWith(withRound(text)))).toBeNull();
	});

	it("does not fire on a turn carrying no marker at all", () => {
		/* This check is the undercut of an EXISTING needs-input marker, so a turn
		 * with none owes it nothing; mantahostels#1200's check is what blocks that turn. */
		const reason =
			runInJob(transcriptWith("Landed the fix. I'll push it next."))?.reason ??
			"";
		expect(reason).toContain("neither status marker");
		expect(reason).not.toContain("promises to keep working");
	});
});

describe("a needs input: written above the round it announces (#228)", () => {
	const round =
		"❓ **Q1** Which schedule?\n\n" +
		`(A) Nightly\nConfidence: ${priced(LIKELY_TOP)}. Cheapest to run.\n\n` +
		`(B) Weekly\nConfidence: ${priced(100 - LIKELY_TOP)}. Fewer wake-ups.\n\n` +
		"Relation: rivals.\n\n➡️ (A).";

	it("blocks the marker with the round written underneath", () => {
		const text = `needs input: pick a schedule.\n\n${round}`;
		const reason = runInJob(transcriptWith(text))?.reason ?? "";
		expect(reason).toContain("characters sit below it");
		expect(reason).toContain("needs input: <the decision you are blocked on");
	});

	it("allows the same round once the marker is the last line", () => {
		const text = `${round}\n\nneeds input: pick a schedule.`;
		expect(runInJob(transcriptWith(text))).toBeNull();
	});

	it("allows trailing blank lines after the marker", () => {
		const text = `${round}\n\nneeds input: pick a schedule.\n\n  \n`;
		expect(runInJob(transcriptWith(text))).toBeNull();
	});

	it("judges the last marker, not one quoted earlier", () => {
		// A turn pasting a block reason back quotes the marker near the top; the
		// real one still ends the message.
		const text =
			"Blocked earlier with:\n\nneeds input: <the decision>\n\n" +
			`${round}\n\nneeds input: pick a schedule.`;
		expect(runInJob(transcriptWith(text))).toBeNull();
	});

	it("stands down where a later result: governs the filing", () => {
		// `result:` below it means the needs-input above is not the governing
		// marker, so its placement is resultMisplaced's to judge, not this limb's.
		const text = "needs input: quoted.\n\nDelivered it.\n\nresult: done.";
		expect(runInJob(transcriptWith(text))?.reason ?? "").not.toContain(
			"characters sit below it",
		);
	});

	it("stands down where a later waiting: governs the filing", () => {
		const text =
			"needs input: quoted.\n\nDispatched it.\n\nwaiting: the agent.";
		expect(runInJob(transcriptWith(text))?.reason ?? "").not.toContain(
			"characters sit below it",
		);
	});

	it("does not fire in an interactive session, which has no status line", () => {
		const text = `needs input: pick a schedule.\n\n${round}`;
		expect(run(transcriptWith(text))).toBeNull();
	});

	it("does not fire on a turn carrying no needs input: at all", () => {
		const text = `${round.replace("➡️ (A).", "")}\n\nresult: done.`;
		expect(runInJob(transcriptWith(text))?.reason ?? "").not.toContain(
			"characters sit below it",
		);
	});
});

describe("it leaves proof that it ran (mantahostels#872)", () => {
	/** One appended line per invocation, oldest first (mantahostels#1274). */
	const readRecords = () => {
		const file = path.join(
			hookRecord.recordsDir(dir),
			`.hook-ran-guard-priced-options-${sid}`,
		);
		if (!fs.existsSync(file)) return [];
		return fs
			.readFileSync(file, "utf8")
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l));
	};

	const readLastRecord = () => readRecords()[readRecords().length - 1] ?? null;

	it("records a turn it allowed", () => {
		expect(run(transcriptWith(GOOD))).toBeNull();
		expect(readRecords()).toHaveLength(1);
		expect(readLastRecord()).toMatchObject({ outcome: "message" });
	});

	it("records a turn it blocked, without touching the block counter's job", () => {
		expect(run(transcriptWith("❓ **Q1** - **X**: pick one."))?.decision).toBe(
			"block",
		);
		expect(readRecords()).toHaveLength(1);
		expect(readLastRecord()).toMatchObject({ outcome: "message" });
		expect(
			fs.readFileSync(
				path.join(markersDir(dir), `.priced-options-nagged-${sid}`),
				"utf8",
			),
		).toBe("1\n");
	});

	it("records an empty message", () => {
		const file = path.join(dir, `${sid}.jsonl`);
		fs.writeFileSync(
			file,
			`${JSON.stringify({ type: "user", message: { content: "ask" } })}\n`,
		);
		expect(run(file)).toBeNull();
		expect(readRecords()).toHaveLength(1);
		expect(readLastRecord()).toMatchObject({ outcome: "empty-message" });
	});

	it("records a missing transcript", () => {
		run(path.join(dir, "absent.jsonl"));
		expect(readRecords()).toHaveLength(1);
		expect(readLastRecord()).toMatchObject({ outcome: "no-transcript" });
	});

	it("records every invocation, not only the blocking ones", () => {
		const good = transcriptWith(GOOD);
		run(good);
		run(good);
		run(good);
		expect(readRecords()).toHaveLength(3);
		expect(
			fs.existsSync(
				path.join(markersDir(dir), `.priced-options-nagged-${sid}`),
			),
		).toBe(false);
	});

	it("names the route the message came from", () => {
		// No `last_assistant_message` on this payload, so the fallback runs.
		run(transcriptWith(GOOD));
		expect(readLastRecord()).toMatchObject({
			source: "transcript",
			payloadLen: null,
		});
		expect(readLastRecord()?.transcriptLen).toBeGreaterThan(0);
	});

	it("takes the text off the payload when the harness supplies it", () => {
		runWithMessage(GOOD);
		expect(readLastRecord()).toMatchObject({
			outcome: "message",
			source: "payload",
			payloadLen: GOOD.length,
			transcriptLen: null,
		});
	});

	it("still blocks when the record cannot be written", () => {
		/* A directory where the record file goes, so the append fails. Recursive
		 * because the breadcrumb directory itself does not exist until
		 * a guard has written once (mantahostels#3382), and this test blocks the first write. */
		fs.mkdirSync(
			path.join(
				hookRecord.recordsDir(dir),
				`.hook-ran-guard-priced-options-${sid}`,
			),
			{ recursive: true },
		);
		expect(run(transcriptWith("❓ **Q1** - **X**: pick one."))?.decision).toBe(
			"block",
		);
	});
});

describe("it judges the text the payload carries (mantahostels#1273)", () => {
	it("allows a well-formed round read off the payload alone", () => {
		expect(runWithMessage(GOOD)).toBeNull();
	});

	it("blocks a defective one, naming the question and the way out", () => {
		const found = runWithMessage("❓ **Q1** - **X**: pick one.");
		expect(found?.decision).toBe("block");
		expect(found?.reason).toContain("Q1:");
	});

	it("blocks a finished background job whose report carries no marker (mantahostels#1254)", () => {
		const found = runInJobWithMessage(
			"Built the fix and pushed it. Suite green, 4,636 pass.",
		);
		expect(found?.decision).toBe("block");
		expect(found?.reason).toMatch(/result:|needs input:/);
	});
});

describe("the relation between the options (mantahostels#1037)", () => {
	/** The GOOD round with its `Relation:` line taken back out. */
	const noRelation = GOOD.split("\n")
		.filter((l) => !l.startsWith("Relation:"))
		.join("\n");

	it("blocks a round that states no relation between its options", () => {
		const reason = run(transcriptWith(noRelation))?.reason ?? "";
		expect(reason).toContain("Q1: it states no relation between its options");
	});

	it("leaves a single-option round alone, there being no relation to state", () => {
		const text = `❓ **Q1** - **Expiry**: Ship the twelve-month expiry?

(A) Yes
Confidence: ${priced(LIKELY_TOP)}. Matches the season.

➡️ (A).`;
		const reason = run(transcriptWith(text))?.reason ?? "";
		expect(reason).not.toContain("states no relation");
	});

	it("accepts options declared independent, so combinable options need no contortion", () => {
		const text = noRelation.replace(
			"➡️ (A).",
			"Relation: independent — (A) and (B) touch different files and either, both or neither is takeable.\n\n➡️ (A) and (B) together.",
		);
		expect(run(transcriptWith(text))).toBeNull();
	});

	it("accepts a mixed declaration naming both a conflict and a combination", () => {
		const text = `❓ **Q1** - **Selection**: Which improvements now?

(A) Order the tail by write-set size
Confidence: 62% (55% - 70%). The ordering is the part sessions get wrong.

(B) Replace the picker with a skill
Confidence: 55% (40% - 68%). #102 says either shape is cheaply reversible.

(C) Print the frontier count
Confidence: ${priced(LIKELY_TOP)}. One line, no dependency on the other two.

Relation: (C) is orthogonal to both; (A) and (B) conflict on where the ordering lives.

➡️ (A) and (C) together, (B) held.`;
		expect(run(transcriptWith(text))).toBeNull();
	});

	it("still blocks a bare Relation: with nothing after it", () => {
		const text = noRelation.replace("➡️ (A).", "Relation:\n\n➡️ (A).");
		expect(run(transcriptWith(text))?.reason).toContain(
			"it states no relation between its options",
		);
	});

	it("takes a relation line on presence alone, contentless or not", () => {
		const text = noRelation.replace(
			"➡️ (A).",
			"Relation: see the discussion above.\n\n➡️ (A).",
		);
		expect(run(transcriptWith(text))).toBeNull();
	});

	it("accepts mantahostels#1505's cross-question reference", () => {
		/* The "(D)" belongs to Q1, not to the question the line sits in. */
		const text = noRelation.replace(
			"➡️ (A).",
			"Relation: (B) is takeable under any Q1 answer, though under Q1 (D) it lands later.\n\n➡️ (A).",
		);
		expect(run(transcriptWith(text))).toBeNull();
	});

	it("takes a three-option relation naming no option", () => {
		const text = `❓ **Q1** - **Selection**: Which improvements now?

(A) Order the tail by write-set size
Confidence: 62% (55% - 70%). The ordering is what sessions get wrong.

(B) Replace the picker with a skill
Confidence: 55% (40% - 68%). #102 says either shape is cheaply reversible.

(C) Print the frontier count
Confidence: ${priced(LIKELY_TOP)}. One line, no dependency on the other two.

Relation: these conflict.

**Why not (C):** a frontier count nobody reads is not worth the week.

➡️ (A).`;
		expect(run(transcriptWith(text))).toBeNull();
	});

	it("lets two options declare a conflict without naming the pair, there being one pair", () => {
		const text = noRelation.replace(
			"➡️ (A).",
			"Relation: mutually exclusive — one expiry date can be shipped.\n\n➡️ (A).",
		);
		expect(run(transcriptWith(text))).toBeNull();
	});

	it("accepts the relations that are neither conflict nor independence (mantahostels#1037 review)", () => {
		/* Subsumption and sequencing are real answers with no vocabulary of their
		 * own, and a list narrow enough to separate conflict from independence
		 * refuses both. */
		for (const line of [
			"Relation: (A) and (B) can both be taken.",
			"Relation: (A) subsumes (B).",
			"Relation: (B) is only worth doing after (A) ships.",
			"Relation: (A) and (B) overlap on the digest step but neither blocks the other.",
		]) {
			const text = noRelation.replace("➡️ (A).", `${line}\n\n➡️ (A).`);
			expect(run(transcriptWith(text)), line).toBeNull();
		}
	});

	it("accepts a three-option conflict declared over all of them at once", () => {
		const text = `❓ **Q1** - **Selection**: Which improvement now?

(A) Order the tail by write-set size
Confidence: ${priced(LIKELY_TOP)}. The ordering is what sessions get wrong.

(B) Replace the picker with a skill
Confidence: ${priced(10)}. #102 says either shape is cheaply reversible.

(C) Print the frontier count
Confidence: ${priced(100 - LIKELY_TOP - 10)}. One line, no dependency on the other two.

Relation: all three are mutually exclusive — one of them ships this week.

**Why not (C):** a frontier count nobody reads is not worth the week.

➡️ (A).`;
		expect(run(transcriptWith(text))).toBeNull();
	});

	it("accepts a conflict declared over all of the options at once", () => {
		const text = noRelation.replace(
			"➡️ (A).",
			"Relation: all the options are mutually exclusive — one expiry date can be shipped.\n\n➡️ (A).",
		);
		expect(run(transcriptWith(text))).toBeNull();
	});

	it("takes a relation line naming an option the question does not offer", () => {
		const text = noRelation.replace(
			"➡️ (A).",
			"Relation: (A) and (D) conflict on the expiry date.\n\n➡️ (A).",
		);
		expect(run(transcriptWith(text))).toBeNull();
	});

	it("names the line it wants by its opening word", () => {
		const reason = run(transcriptWith(noRelation))?.reason ?? "";
		expect(reason).toContain("opening `Relation:`");
	});

	it("does not read a relation line from the next question's block", () => {
		const text = `${noRelation}\n\n❓ **Q2** - **Owner**: who?\n\n(A) Me\nConfidence: ${priced(LIKELY_TOP)}. I have the context.\n\n(B) You\nConfidence: 25% (15% - 35%). You have the access.\n\nRelation: (A) and (B) conflict on who holds the token.\nBlocked: only you hold the deploy token.\n\n➡️ (A).`;
		const reason = run(transcriptWith(text))?.reason ?? "";
		expect(reason).toContain("Q1: it states no relation");
		expect(reason).not.toContain("Q2:");
	});
});

describe("rivals' figures are one probability split (#38)", () => {
	const round = (
		a: number,
		b: number,
		relation: string,
	) => `❓ **Q1** - **Expiry period**: How long should a reward code stay redeemable?

(A) Twelve months from issue
Confidence: ${a}% (${a - 8}% - ${a + 8}%). Matches the booking season most members return in.

(B) No expiry at all
Confidence: ${b}% (${b - 8}% - ${b + 8}%). Simplest to explain, but leaves an open liability.

Relation: ${relation}

➡️ (A).`;

	it("blocks rivals whose figures do not sum to 100, naming the sum they reach", () => {
		const reason =
			run(transcriptWith(round(72, 20, "rivals — one expiry rule.")))?.reason ??
			"";
		expect(reason).toContain(
			"declares the options rivals, but their figures sum to 92%",
		);
	});

	it("blocks an over-100 split declared mutually exclusive, quoting the sum", () => {
		const reason =
			run(transcriptWith(round(70, 40, "mutually exclusive.")))?.reason ?? "";
		expect(reason).toContain("sum to 110%");
	});

	it("allows rivals summing to 100, and within five of it", () => {
		expect(
			run(
				transcriptWith(
					round(LIKELY_TOP, 100 - LIKELY_TOP, "rivals — one expiry rule."),
				),
			),
		).toBeNull();
		expect(
			run(
				transcriptWith(
					round(LIKELY_TOP, 96 - LIKELY_TOP, "rivals — one expiry rule."),
				),
			),
		).toBeNull();
	});

	it("does not sum options declared combinable", () => {
		expect(
			run(
				transcriptWith(
					round(LIKELY_TOP, 60, "independent, so any combination is takeable."),
				),
			),
		).toBeNull();
	});

	it("does not sum a relation that names a combinable pair beside a rival one", () => {
		expect(
			run(
				transcriptWith(
					round(
						LIKELY_TOP,
						60,
						"rivals on the date; either combines with the reminder email.",
					),
				),
			),
		).toBeNull();
	});

	/* LIKELY_TOP + 10 misses 100 by more than five, so each case refuses where
	 * the sum were taken. */
	it("does not sum a relation that never declares rivals", () => {
		expect(
			run(
				transcriptWith(
					round(
						LIKELY_TOP,
						10,
						"(A) and (B) conflict on the expiry date itself.",
					),
				),
			),
		).toBeNull();
	});

	it("does not sum where an option is declared unknowable", () => {
		const text = round(LIKELY_TOP, 10, "rivals — one expiry rule.").replace(
			"Confidence: 10% (2% - 18%). Simplest to explain, but leaves an open liability.",
			"Unknowable: no member data on expiry yet.",
		);
		expect(run(transcriptWith(text))).toBeNull();
	});
});

describe("a background job that ends carrying no marker at all (mantahostels#1200)", () => {
	const done =
		"Landed the fix, ran the suite green and pushed it as ba5b98a.\n\n" +
		"Next up is the predictor symmetry fix.";

	it("blocks the finished report that names neither status", () => {
		const reason = runInJob(transcriptWith(done))?.reason ?? "";
		expect(reason).toContain("neither");
		expect(reason).toContain("result:");
		expect(reason).toContain("needs input:");
	});

	it("allows the same message once it carries result:", () => {
		expect(
			runInJob(transcriptWith(`${done}\n\nresult: fix landed.`)),
		).toBeNull();
	});

	it("allows a message carrying needs input:", () => {
		const text = "Assessed the three CLIs.\n\nneeds input: which to add.";
		expect(runInJob(transcriptWith(withRound(text)))).toBeNull();
	});

	it("allows the hand-off turn taken while a background job runs", () => {
		const text =
			"Dispatched the standards reviewer.\n\n" +
			"waiting: the review agent's completion notification.";
		expect(runInJob(transcriptWith(text, [PENDING_LAUNCH]))).toBeNull();
	});

	it("does not fire in an interactive session, which has no status line", () => {
		expect(run(transcriptWith(done))).toBeNull();
	});

	it("says nothing extra on a question round, which its own check covers", () => {
		const reason = runInJob(transcriptWith(GOOD))?.reason ?? "";
		expect(reason).toContain("needs input:");
		expect(reason).not.toContain("neither");
	});
});

describe("a status marker decorated rather than bare (mantahostels#3426)", () => {
	const report = "Landed the fix and pushed it as ba5b98a.";

	it.each([
		["a backticked result:", "`result:` fix landed.", "`"],
		["a bold waiting:", "**waiting:** the review agent.", "**"],
		["a quoted needs input:", "> needs input: which CLI to add.", ">"],
	])(
		"refuses %s by its decoration, not as missing, naming the decoration and offering the bare marker as the way out",
		(_what, marker, deco) => {
			const reason =
				runInJob(transcriptWith(`${report}\n\n${marker}`))?.reason ?? "";
			expect(reason).toContain("decorated");
			expect(reason).toContain(`\`${deco}\``);
			expect(reason).toContain("Rewrite the same marker bare");
			expect(reason).not.toContain("carrying neither");
		},
	);

	it("names the decoration where the closer sits before the colon", () => {
		const reason =
			runInJob(transcriptWith(`${report}\n\n**result**: fix landed.`))
				?.reason ?? "";
		expect(reason).toContain("decorated");
		expect(reason).not.toContain("carrying neither");
	});

	it("names a decorated needs input: under a question round", () => {
		const reason =
			runInJob(transcriptWith(`${GOOD}\n\n**needs input:** the expiry.`))
				?.reason ?? "";
		expect(reason).toContain("decorated");
		expect(reason).not.toContain("nothing but a human will wake");
	});

	it("allows a bare marker even with a decorated one quoted above it", () => {
		const text = `${report}\n\n> result: an example line.\n\nresult: fix landed.`;
		expect(runInJob(transcriptWith(text))).toBeNull();
	});

	it("reads a marker mentioned mid-sentence as prose, not decoration", () => {
		const reason =
			runInJob(transcriptWith(`${report} The guard wants a \`result:\` line.`))
				?.reason ?? "";
		expect(reason).toContain("carrying neither status marker");
		expect(reason).not.toContain("decorated");
	});

	it("does not fire in an interactive session", () => {
		expect(
			run(transcriptWith(`${report}\n\n\`result:\` fix landed.`)),
		).toBeNull();
	});
});

describe("a result: the message then buries (mantahostels#1210)", () => {
	const report =
		"Two commits pushed, tests green, claims released.\n\n" +
		"CI has not tested the sha and the next sweep is 8h 50m away. " +
		"The triaged issue stays open carrying deferred work.";

	it("blocks a marker written above the report it summarises, giving the result: form to end on instead", () => {
		const text = `result: triage complete.\n\n${report}`;
		const reason = runInJob(transcriptWith(text))?.reason ?? "";
		expect(reason).toContain("still running");
		expect(reason).toContain("result: <what was delivered");
	});

	it("allows the same report once the marker is the last line", () => {
		const text = `${report}\n\nresult: triage complete.`;
		expect(runInJob(transcriptWith(text))).toBeNull();
	});

	it("allows trailing blank lines after the marker", () => {
		const text = `${report}\n\nresult: triage complete.\n\n  \n`;
		expect(runInJob(transcriptWith(text))).toBeNull();
	});

	it("blocks a marker whose own line runs past the window, giving its distance from the end in characters", () => {
		const text = `result: ${"delivered and delivered. ".repeat(200)}`;
		const reason = runInJob(transcriptWith(text))?.reason ?? "";
		expect(reason).toContain("characters from the end");
		expect(reason).toContain("cannot see the marker at all");
	});

	it("does not fire in an interactive session, which has no status line", () => {
		expect(run(transcriptWith(`result: done.\n\n${report}`))).toBeNull();
	});

	it("does not fire on a turn carrying no result: at all", () => {
		const text = `${report}\n\nneeds input: which sweep to wait for.`;
		expect(runInJob(transcriptWith(withRound(text)))).toBeNull();
	});

	it("ignores a result: quoted above the real needs input: marker", () => {
		/* The marker that governs the message is the later `needs input:`, whose
		 * placement is mantahostels#85's check to judge, not this one's. */
		const text =
			"Blocked earlier with:\n\nresult: <what was delivered>\n\n" +
			`${report}\n\nneeds input: which sweep to wait for.`;
		expect(runInJob(transcriptWith(withRound(text)))).toBeNull();
	});

	it("ignores a result: quoted above the real waiting: marker", () => {
		const text =
			"Blocked earlier with:\n\nresult: <what was delivered>\n\n" +
			"Dispatched the reviewer.\n\nwaiting: its completion notification.";
		expect(runInJob(transcriptWith(text, [PENDING_LAUNCH]))).toBeNull();
	});

	it("measures the last result:, not one quoted earlier", () => {
		const text =
			"Blocked earlier with:\n\nresult: <what was delivered>\n\n" +
			`${report}\n\nresult: triage complete.`;
		expect(runInJob(transcriptWith(text))).toBeNull();
	});

	it("names the misplacement in the same block as the approval-seeking check (mantahostels#2786)", () => {
		const text = "result: assessed.\n\nSay the word and I'll wire it in.";
		const reason = runInJob(transcriptWith(text))?.reason ?? "";
		expect(reason).toContain("say the word");
		expect(reason).toContain("still running");
	});
});

/** Three options on one axis, the highest priced first, for the cases below. */
const THREE_OPTIONS =
	"(A) Build the partial launch now.\n" +
	"Confidence: 71% (60% - 80%). Drives it: it is what the command means.\n\n" +
	"(B) Make --force take issue numbers.\n" +
	"Confidence: 55% (45% - 65%). Drives it: it preserves the set as the unit.\n\n" +
	"(C) Leave it exactly as it is.\n" +
	"Confidence: 62% (50% - 72%). Drives it: the gate has one firing.\n";

/*
 * A recommendation naming the option its own message priced lowest
 * (mantahostels#1344). These cases carry neither the `❓ **Qn**` round marker nor the
 * `➡` recommendation arrow.
 */
describe("a recommendation that contradicts its own prices", () => {
	it("blocks the recommendation of the option priced lowest, quoting the higher prices and the ruling ticket", () => {
		const reason =
			run(transcriptWith(`${THREE_OPTIONS}\nMy recommendation is (C).`))
				?.reason ?? "";
		expect(reason).toContain("62%");
		expect(reason).toContain("71%");
		expect(reason).toContain("#1344");
	});

	it("names the axis mismatch as the likelier fault, not the wording", () => {
		const reason =
			run(transcriptWith(`${THREE_OPTIONS}\nMy recommendation is (C).`))
				?.reason ?? "";
		expect(reason).toContain("DIFFERENT propositions");
		expect(reason).toContain("Why not (A)");
	});

	it("allows it once a Why not line names the option passed over", () => {
		const text =
			`${THREE_OPTIONS}\nMy recommendation is (C).\n\n` +
			"**Why not (A):** it changes a gate with one firing to its name.";
		expect(run(transcriptWith(text))).toBeNull();
	});

	it("still blocks when the Why not line names the wrong option", () => {
		const text =
			`${THREE_OPTIONS}\nMy recommendation is (C).\n\n` +
			"**Why not (B):** more flags on a young gate.";
		expect(run(transcriptWith(text))?.reason ?? "").toContain("#1344");
	});

	it("allows a recommendation of the highest-priced option", () => {
		expect(
			run(transcriptWith(`${THREE_OPTIONS}\nMy recommendation is (A).`)),
		).toBeNull();
	});

	it("allows options priced equally", () => {
		const text =
			"(A) Do it now.\nConfidence: 60% (50% - 70%). Drives it: cheap.\n\n" +
			"(B) Do it later.\nConfidence: 60% (50% - 70%). Drives it: also cheap.\n\n" +
			"I recommend (B).";
		expect(run(transcriptWith(text))).toBeNull();
	});

	it("attributes a letter to its own question by the number in front of it", () => {
		const second =
			"\n(A) Launch both now.\n" +
			"Confidence: 64% (52% - 75%). Drives it: one carries urgent.\n\n" +
			"(B) Launch one alone.\n" +
			"Confidence: 70% (60% - 79%). Drives it: measured headroom.\n";
		const reason =
			run(
				transcriptWith(
					`${THREE_OPTIONS}${second}\nMy recommendation is 1(C) and 2(B).`,
				),
			)?.reason ?? "";
		expect(reason).toContain("Q1 (C)");
		expect(reason).not.toContain("Q2");
	});

	it("skips a bare letter where more than one question could own it", () => {
		const second =
			"\n(A) Launch both now.\n" +
			"Confidence: 64% (52% - 75%). Drives it: one carries urgent.\n\n" +
			"(B) Launch one alone.\n" +
			"Confidence: 70% (60% - 79%). Drives it: measured headroom.\n";
		expect(
			run(transcriptWith(`${THREE_OPTIONS}${second}\nI recommend (C).`)),
		).toBeNull();
	});

	it("leaves a message with no recommendation alone", () => {
		expect(run(transcriptWith(THREE_OPTIONS))).toBeNull();
	});

	// Were an option reference to start at any blank, each of 100,000 blanks
	// ahead of a word would re-read the run after them, minutes in all;
	// started only where the run starts, milliseconds (#3383, Sonar S8786).
	// The refusal names the option read past the stretch.
	it("reads a recommendation with a long blank stretch mid-line, promptly", () => {
		const block = readStopGuardBlockWithin(GUARD, {
			dir,
			sid,
			transcript: transcriptWith(
				`${THREE_OPTIONS}\nMy recommendation is${" ".repeat(100_000)}the third, (C).`,
			),
		});
		expect(block?.reason).toContain("#1344");
	});
});

describe("accounting for every option passed over, not just the top one", () => {
	it("reads each question's own Why not line, not only the first (mantahostels#1344)", () => {
		const text =
			"(A) One.\nConfidence: 71% (60% - 80%). Drives it: a reason.\n\n" +
			"(B) Two.\nConfidence: 55% (45% - 65%). Drives it: a reason.\n\n" +
			"**Why not (A):** it costs a week.\n\n" +
			"(A) Three.\nConfidence: 60% (50% - 70%). Drives it: a reason.\n\n" +
			"(B) Four.\nConfidence: 80% (70% - 88%). Drives it: a reason.\n\n" +
			"**Why not (B):** the same week.\n\n" +
			"My recommendation is 1(B) and 2(A).";
		expect(run(transcriptWith(text))).toBeNull();
	});

	it("blocks while an option priced above the recommendation is unaccounted for, naming the option still owed a Why not", () => {
		const text =
			"(A) One.\nConfidence: 71% (60% - 80%). Drives it: a reason.\n\n" +
			"(B) Two.\nConfidence: 62% (50% - 72%). Drives it: a reason.\n\n" +
			"(C) Three.\nConfidence: 55% (45% - 65%). Drives it: a reason.\n\n" +
			"**Why not (A):** it costs a week.\n\nI recommend (C).";
		const reason = run(transcriptWith(text))?.reason ?? "";
		expect(reason).toContain("Why not (B)");
	});

	it("clears once every option above it is accounted for", () => {
		const text =
			"(A) One.\nConfidence: 71% (60% - 80%). Drives it: a reason.\n\n" +
			"(B) Two.\nConfidence: 62% (50% - 72%). Drives it: a reason.\n\n" +
			"(C) Three.\nConfidence: 55% (45% - 65%). Drives it: a reason.\n\n" +
			"**Why not (A):** it costs a week.\n" +
			"**Why not (B):** it needs the same week.\n\nI recommend (C).";
		expect(run(transcriptWith(text))).toBeNull();
	});
});

/*
 * `docs/working-contract.md` §Self-containment requires an option be "restated
 * in full wherever they're used again", so the well-formed message this
 * refusal exists for repeats the recommended option on its own line — which
 * reads as a fresh run of letters unless the unpriced run is discarded.
 */
describe("a recommendation that restates the option it names", () => {
	it("blocks though the restatement opens a second run of letters (mantahostels#1344)", () => {
		const text =
			`${THREE_OPTIONS}\nMy recommendation:\n\n` +
			"(C) Leave it exactly as it is — the effort belongs elsewhere.";
		expect(run(transcriptWith(text))?.reason ?? "").toContain("#1344");
	});

	it("keeps a numbered letter on its own question across a restatement (mantahostels#1344)", () => {
		const second =
			"\n(A) Launch both now.\n" +
			"Confidence: 64% (52% - 75%). Drives it: one carries urgent.\n\n" +
			"(B) Launch one alone.\n" +
			"Confidence: 70% (60% - 79%). Drives it: measured headroom.\n";
		const text =
			`${THREE_OPTIONS}\n(C) Leave it exactly as it is — restated.\n` +
			`${second}\nMy recommendation is 1(A) and 2(A).`;
		const reason = run(transcriptWith(text))?.reason ?? "";
		expect(reason).toContain("Q2 (A)");
	});

	/* The positive case §X4 demands beside the two above: the same restated
	 * shape, recommending the option priced highest, still passes. */
	it("allows a restatement of the option priced highest (mantahostels#1344)", () => {
		const text =
			`${THREE_OPTIONS}\nMy recommendation:\n\n` +
			"(A) Build the partial launch now — it is what the command means.";
		expect(run(transcriptWith(text))).toBeNull();
	});
});

describe("what the restatement filter must not swallow", () => {
	it("keeps a question numbered where one of its options is unpriced (mantahostels#1344)", () => {
		const text =
			"(A) Publish the ladder.\n" +
			"Confidence: 80% (70% - 88%). Drives it: the design is settled.\n\n" +
			"(B) Wait for the second vendor.\n" +
			"No figure: the vendor's terms are unknowable from here.\n\n" +
			"(A) Run the sweep nightly.\n" +
			"Confidence: 40% (30% - 50%). Drives it: it doubles the cost.\n\n" +
			"(B) Run it four times a day.\n" +
			"Confidence: 90% (85% - 95%). Drives it: it is what runs today.\n\n" +
			"My recommendation is 1(A) and 2(B).";
		expect(run(transcriptWith(text))).toBeNull();
	});

	it("reads the line below only where it restates an option (mantahostels#1344)", () => {
		const text =
			`${THREE_OPTIONS}\nMy recommendation:\n\n` +
			"Ruling out (C) leaves the two above to choose between.";
		expect(run(transcriptWith(text))).toBeNull();
	});

	it("does not read the line below a sentence that recommends nothing (mantahostels#1344)", () => {
		const text =
			"(A) Build the partial launch now.\n" +
			"Confidence: 71% (60% - 80%). Drives it: it is what the command means.\n\n" +
			"(B) Leave it exactly as it is.\n" +
			"Confidence: 55% (45% - 65%). Drives it: the gate has one firing.\n\n" +
			"I do not recommend deciding today.\n" +
			"(B) above is the cheaper path if you disagree.";
		expect(run(transcriptWith(text))).toBeNull();
	});
});

describe("a status marker carrying nothing after the colon (mantahostels#2013)", () => {
	/* The shape that filed a blocked session Completed: a priced round, a
	 * recommendation, a clean-tree report, and a bare marker under it. `round`
	 * passes every other check, so the bare marker is all that is refused. */
	const round =
		"❓ **Q2** — revised order\n\n" +
		"(A) Cut spawns in the heaviest test files.\n" +
		"Confidence: 55% (42% - 66%). The baseline shows only half is addressable.\n\n" +
		"(B) Gate suite launches at one at a time.\n" +
		`Confidence: ${priced(LIKELY_TOP)}. The arithmetic is straightforward.\n\n` +
		"Relation: independent, so any combination is takeable.\n\n" +
		"Recommendation: (B), then (A) on the top five files only.\n\n" +
		"Nothing is uncommitted.";

	it("blocks the bare marker that ended a round recommending an answer", () => {
		const text = `${round}\n\nneeds input:`;
		const reason = runInJob(transcriptWith(text))?.reason ?? "";
		expect(reason).toContain("bare `needs input:`");
		expect(reason).toContain("carrying nothing after the colon");
	});

	it("allows the same round once the marker says what it is for", () => {
		const text = `${round}\n\nneeds input: whether to take (B) before (A).`;
		expect(runInJob(transcriptWith(text))).toBeNull();
	});

	it("blocks a bare result: too", () => {
		const reason =
			runInJob(transcriptWith("Landed the fix and pushed it.\n\nresult:"))
				?.reason ?? "";
		expect(reason).toContain("bare `result:`");
	});

	it("blocks a bare waiting:", () => {
		const reason =
			runInJob(transcriptWith("Dispatched the sweep.\n\nwaiting:"))?.reason ??
			"";
		expect(reason).toContain("bare `waiting:`");
	});

	it("treats a marker followed only by whitespace as bare", () => {
		const reason =
			runInJob(transcriptWith(`${round}\n\nneeds input:   `))?.reason ?? "";
		expect(reason).toContain("carrying nothing after the colon");
	});

	it("judges the last marker, not a bare one quoted above a real one", () => {
		// A message pasting this guard's own block text back quotes a marker near
		// the top; the one at the end is what the classifier files on.
		const text =
			"Blocked earlier with:\n\nneeds input:\n\n" +
			`${round}\n\nneeds input: whether to take (B) before (A).`;
		expect(runInJob(transcriptWith(text))).toBeNull();
	});

	it("blocks a bare marker sitting below a filled one of another kind, naming the bare one", () => {
		const text = "Landed it.\n\nresult: the guard is in.\n\nneeds input:";
		const reason = runInJob(transcriptWith(text))?.reason ?? "";
		expect(reason).toContain("bare `needs input:`");
	});

	it("allows a filled marker below a bare one of ANOTHER kind", () => {
		// The marker list is walked in a fixed order, so taking the first kind
		// found rather than the one latest in the text would block this.
		const text =
			"Blocked earlier on a bare:\n\nneeds input:\n\n" +
			"Then finished it.\n\nresult: the guard is in and pushed.";
		expect(runInJob(transcriptWith(text))).toBeNull();
	});

	it("does not fire in an interactive session, which has no status line", () => {
		expect(run(transcriptWith(`${round}\n\nneeds input:`))).toBeNull();
	});

	it("does not fire on a turn carrying no marker at all", () => {
		const reason =
			runInJob(transcriptWith("Landed the fix. I'll push it next."))?.reason ??
			"";
		expect(reason).toContain("neither status marker");
		expect(reason).not.toContain("carrying nothing after the colon");
	});
});

describe("a `needs input:` with no round (mantahostels#2583)", () => {
	const prose =
		"Both commits are in and the issue is closed.\n\n" +
		"needs input: whether to fire the sweep now, or leave it to 01:00 UTC.";

	it("blocks it in a background job, and says what to write instead", () => {
		const reason = runInJob(transcriptWith(prose))?.reason ?? "";
		expect(reason).toContain("with no `❓ **Qn**` round above it");
		expect(reason).toContain("(A) <option>");
		expect(reason).toContain("Confidence: 70% (60% - 80%)");
	});

	it("allows it in an interactive session, where he can ask again", () => {
		expect(run(transcriptWith(prose))).toBeNull();
	});

	it("allows a `needs input:` that does sit under a round", () => {
		const text = `${GOOD}\n\nneeds input: which of (A) or (B) to take.`;
		expect(runInJob(transcriptWith(text))).toBeNull();
	});

	it("does not fire where the governing marker is `result:`", () => {
		const text = "Shipped it, nothing outstanding.\n\nresult: the guard is in.";
		const reason = runInJob(transcriptWith(text))?.reason ?? "";
		expect(reason).not.toContain("round above it");
	});

	it("does not fire on a `needs input:` a later marker supersedes", () => {
		const text =
			"needs input: whether to push.\n\nOn reflection, it is running:\n\n" +
			"waiting: the suite.";
		const reason = runInJob(transcriptWith(text))?.reason ?? "";
		expect(reason).not.toContain("round above it");
	});

	it("spends its own block counter, not the round-shape one", () => {
		runInJob(transcriptWith(prose));
		expect(
			fs.existsSync(
				path.join(markersDir(dir), `.needs-input-round-nagged-${sid}`),
			),
		).toBe(true);
		expect(
			fs.existsSync(
				path.join(markersDir(dir), `.priced-options-nagged-${sid}`),
			),
		).toBe(false);
	});
});

describe("the bucket-deciding checks keep their own block budget (mantahostels#2544)", () => {
	/* A round with one unpriced option, and its `needs input:` marker present so
	 * nothing but the cosmetic defect fires: the shared `.priced-options-nagged-`
	 * counter and no other. */
	const unpriced = `${GOOD.replace(`${GOOD_B} `, "")}\n\nneeds input: the expiry period.`;
	/* A finished report with no marker of any kind — the turn that decides how
	 * the job is filed. */
	const noMarker = "Both commits are in, #2532 is closed. Nothing else ran.";

	/** Spend the shared counter to its cap with `text`, asserting each block. */
	function spendShared(text: string) {
		const transcript = transcriptWith(text);
		for (let i = 0; i < 3; i++) expect(runInJob(transcript)).not.toBeNull();
		expect(runInJob(transcript)).toBeNull();
	}

	it("still refuses an unmarked final turn after three round-shape blocks", () => {
		spendShared(unpriced);
		const reason = runInJob(transcriptWith(noMarker))?.reason ?? "";
		expect(reason).toContain("carrying neither status marker");
	});

	it("still refuses an unmarked final turn after three waiting-on-nothing blocks", () => {
		/* Every short `gh` call settles before the turn ends, so an owed
		 * `waiting:` is refused. */
		spendShared("Dispatched it.\n\nwaiting: the notification.");
		const reason = runInJob(transcriptWith(noMarker))?.reason ?? "";
		expect(reason).toContain("carrying neither status marker");
	});

	/* One row per bucket-deciding limb but `unmarkedStop`, which is `noMarker`
	 * above, each with a phrase only that limb's own refusal carries. */
	const bucket: [string, string, string][] = [
		[
			"a result: with the report below it",
			"result: assessed.\n\nMore report below.",
			"still running",
		],
		[
			"a result: that still asks for approval",
			"result: assessed.\n\nSay the word and I'll wire it in.",
			"say the word",
		],
		[
			"a needs input: trailed by promised work",
			`${GOOD}\n\nneeds input: the expiry period. I'll then wire it in.`,
			"promises to keep working",
		],
		[
			"a round carrying no needs input: line",
			GOOD,
			"nothing but a human will wake this session",
		],
		[
			"a status marker with nothing after its colon",
			`${GOOD}\n\nneeds input:`,
			"carrying nothing after the colon",
		],
		[
			"a needs input: with the round below it (#228)",
			`needs input: the expiry period.\n\n${GOOD}`,
			"characters sit below it",
		],
	];

	it.each(bucket)(
		"still refuses %s after three round-shape blocks, in the wording of that limb",
		(_what, text, expected) => {
			spendShared(unpriced);
			expect(runInJob(transcriptWith(text))?.reason ?? "").toContain(expected);
		},
	);

	/* The converse: each bucket limb spent to its own cap leaves the unmarked
	 * check still armed. */
	it.each(bucket)(
		"spending %s's own counter leaves the unmarked check armed",
		(_what, text, expected) => {
			const own = transcriptWith(text);
			for (let i = 0; i < 3; i++)
				expect(runInJob(own)?.reason ?? "").toContain(expected);
			const reason = runInJob(transcriptWith(noMarker))?.reason ?? "";
			expect(reason).toContain("carrying neither status marker");
		},
	);

	it("still caps the unmarked check itself at three, so no loop is unbounded", () => {
		const transcript = transcriptWith(noMarker);
		for (let i = 0; i < 3; i++) expect(runInJob(transcript)).not.toBeNull();
		expect(runInJob(transcript)).toBeNull();
	});
});

/*
 * The session ceiling (mantahostels#2786): every shape and filing limb shares one
 * allowance, on top of the per-limb caps.
 */
describe("the ceiling every shape and filing limb shares (mantahostels#2786)", () => {
	/* One turn per limb, so no single counter caps out and only the ceiling can
	 * end the run. Each carries a defect a different prefix pays for. */
	const unpriced = `${GOOD.replace(`${GOOD_B} `, "")}\n\nneeds input: the expiry period.`;
	const turns = [
		unpriced,
		"Both commits are in. Nothing else ran.",
		"Landed it.\n\nresult:",
		"needs input: whether to widen the guard.",
		"result: assessed.\n\nSay the word and I'll wire it in.",
	];

	it("blocks five times and then goes quiet", () => {
		for (const text of turns)
			expect(runInJob(transcriptWith(text))).not.toBeNull();
		/* The first turn's own counter has two blocks left, so a sixth stop is
		 * allowed by the ceiling and by nothing else. */
		expect(runInJob(transcriptWith(unpriced))).toBeNull();
	});

	it("says it has gone quiet, rather than falling silent", () => {
		for (const text of turns.slice(0, 4)) runInJob(transcriptWith(text));
		const reason = runInJob(transcriptWith(turns[4]))?.reason ?? "";
		expect(reason).toContain("last Stop block of the session");
		expect(reason).toContain("get this one right unaided");
		/* #1067: the close-rivals check sits outside the ceiling. */
		expect(reason).toContain("checks count separately and may still block");
		for (const name of EXEMPT_NAMES) expect(reason).toContain(name);
	});

	/* The positive half: the notice belongs on the FIFTH block and no earlier.
	 * Without this, a ceiling probe reading `SESSION_MAX - 2` would put it on
	 * blocks four and five alike and nothing would say so. */
	it("holds the notice back until the last block", () => {
		for (const text of turns.slice(0, 3)) runInJob(transcriptWith(text));
		const reason = runInJob(transcriptWith(turns[3]))?.reason ?? "";
		expect(reason).not.toContain("last Stop block of the session");
	});

	it("tells the session when reply shape has spent its share", () => {
		for (const text of turns.slice(0, 3)) runInJob(transcriptWith(text));
		const reason = runInJob(transcriptWith(turns[3]))?.reason ?? "";
		expect(reason).toContain("will not refuse a turn for reply shape alone");
		expect(reason).toContain("checks count separately and may still block");
		for (const name of EXEMPT_NAMES) expect(reason).toContain(name);
	});

	it("never tells it twice, nor before", () => {
		for (const text of turns.slice(0, 2)) runInJob(transcriptWith(text));
		expect(runInJob(transcriptWith(turns[2]))?.reason ?? "").not.toContain(
			"for reply shape alone",
		);
		runInJob(transcriptWith(turns[3]));
		expect(runInJob(transcriptWith(turns[4]))?.reason ?? "").not.toContain(
			"for reply shape alone",
		);
	});

	/* The evidence limb's independence is proved in
	 * `guard-priced-options-green-suite.test.ts`, the only harness with a repo
	 * and a commit ledger; here the session committed nothing and the limb
	 * answers "" whatever the ceiling has spent, so asserting it here would pin
	 * nothing. */
});

/*
 * The ceiling's last block is the consequential tier's (mantahostels#3420):
 * shape stops one block short of it.
 */
describe("the ceiling is reserved by stake tier (mantahostels#3430)", () => {
	const unpriced = `${GOOD.replace(`${GOOD_B} `, "")}\n\nneeds input: the expiry period.`;
	const noRound = "needs input: whether to widen the guard.";
	const noMarker = "Both commits are in. Nothing else ran.";

	function spendFourOnShape() {
		for (let i = 0; i < 3; i++)
			expect(runInJob(transcriptWith(unpriced))).not.toBeNull();
		expect(runInJob(transcriptWith(noRound))).not.toBeNull();
	}

	it("still refuses an unmarked turn after four shape blocks, saying it is the last Stop block of the session", () => {
		spendFourOnShape();
		const reason = runInJob(transcriptWith(noMarker))?.reason ?? "";
		expect(reason).toContain("carrying neither status marker");
		expect(reason).toContain("last Stop block of the session");
	});

	it("lets a shape-only turn stop at SESSION_MAX - 1", () => {
		spendFourOnShape();
		/* `noRound`'s own counter has two blocks left: only the reserve allows it. */
		expect(runInJob(transcriptWith(noRound))).toBeNull();
		/* It spent nothing, so the reserved block is still there. */
		expect(runInJob(transcriptWith(noMarker))).not.toBeNull();
	});

	it("carries the shape reasons on a mixed turn in the reserved block", () => {
		spendFourOnShape();
		const mixed = `${noRound} I'll then wire it in.`;
		const reason = runInJob(transcriptWith(mixed))?.reason ?? "";
		expect(reason).toContain("promises to keep working");
		expect(reason).toContain("round above it");
	});

	it("tells a filing-only fourth block that shape has gone quiet", () => {
		for (let i = 0; i < 3; i++) runInJob(transcriptWith(unpriced));
		const reason = runInJob(transcriptWith(noMarker))?.reason ?? "";
		expect(reason).toContain("carrying neither status marker");
		expect(reason).toContain("will not refuse a turn for reply shape alone");
		expect(runInJob(transcriptWith(noRound))).toBeNull();
	});

	it("charges a waiting: on nothing to its own counter, not the shape one", () => {
		runInJob(transcriptWith("Dispatched it.\n\nwaiting: the notification."));
		expect(
			fs.existsSync(
				path.join(markersDir(dir), `.waiting-unverified-nagged-${sid}`),
			),
		).toBe(true);
		expect(
			fs.existsSync(
				path.join(markersDir(dir), `.priced-options-nagged-${sid}`),
			),
		).toBe(false);
	});
});

/* Spawned, not run in process: the guard's load-failure handler is an
 * `uncaughtException` listener, which a throw inside the test runner's own
 * `require` never reaches. */
describe("a lib that will not load (#2645)", () => {
	it("blocks the stop naming it, then lets the re-stop and an unread payload through", () => {
		const scripts = path.join(dir, "plugin", "scripts");
		fs.mkdirSync(path.join(scripts, "lib"), { recursive: true });
		const program = "guard-priced-options.js";
		for (const f of [
			program,
			...readProgramLibs(program).map((l) => `lib/${l}`),
		])
			fs.copyFileSync(path.join(__dirname, f), path.join(scripts, f));
		fs.rmSync(path.join(scripts, "lib", "shell-var-name.js"));
		const runBroken = (input: string) => {
			const r = runInProcess(path.join(scripts, program), [], {
				stdin: input,
				env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(dir, "config") },
			});
			expect(r.status).toBe(0);
			return r.stdout;
		};
		const payload = { session_id: sid, last_assistant_message: "Done." };

		const block = JSON.parse(runBroken(JSON.stringify(payload)));
		expect(block.decision).toBe("block");
		expect(block.reason).toContain("shell-var-name");
		expect(
			runBroken(JSON.stringify({ ...payload, stop_hook_active: true })),
		).toBe("");
		expect(runBroken("not json")).toBe("");
	});
});
