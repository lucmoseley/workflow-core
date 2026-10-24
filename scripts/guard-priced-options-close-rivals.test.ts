// @vitest-environment node
/*
 * guard-priced-options-close-rivals.test.ts — the sixteenth refusal (#488): a
 * round whose top two rivals sit close is refused once, whatever `Checked:` or
 * `Unmeasured:` line it carries, and the same round number passes on its next
 * send (#1061). A founder message after the refusal retires the record (#659).
 * Driven through the guard's Stop entry in process, with fixture transcripts,
 * the way `self-plugin/hooks/hooks.json` runs it; config, project and repo
 * roots are redirected so counters and the fail-open log land in the temp
 * directory.
 *
 * The guard runs at every `Stop` (`self-plugin/hooks/hooks.json`,
 * `hooks/hooks.json`): loosen a case and the founder is asked to choose between
 * rivals no one checked could flip; break the one-refusal record and a
 * corrected round is refused for ever, or never.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweptMarkers } from "./lib/arbiter-testkit";
import {
	SHAPE_CAP,
	SHAPE_HELD_PASS,
	SHAPE_ONLY_PASS,
	SHAPE_TOO,
	STILL_WRONG,
	sessionCounters,
	withUnloadable,
} from "./lib/priced-options-testkit";
import { ruleText } from "./lib/rule-text";
import { stopGuardReason } from "./lib/stop-guard-testkit";
import {
	buildBashCall,
	failOpenLog,
	LATER,
	researchCalls,
	transcriptRecords,
	writeTranscript,
} from "./lib/transcript-testkit";

const GUARD = path.join(__dirname, "guard-priced-options.js");
const { markersDir } = createRequire(__filename)("./lib/marker-root.js");
const {
	CLOSE_CHECK_LOG,
	RESEARCH_LADDER_PREFIX,
	ROUND_CHECK_LOG,
	SESSION_MAX,
	SESSION_PREFIX,
	SHAPE_PREFIX,
	limbOf,
} = createRequire(__filename)("./lib/priced-options-limbs.js");
const { logPath } = createRequire(__filename)("./lib/refusal-log.js");
const closeLog = (root: string): string => logPath(root, CLOSE_CHECK_LOG);
const { readJsonl } = createRequire(__filename)("./lib/jev-log.js");

const {
	reset,
	stampAfter,
	founder,
	toolResult,
	notification,
	stopFeedback,
	siblingBlock,
	skillBody,
} = transcriptRecords("2026-09-27T10:00:00Z");

let dir: string;
let file: string;
let config: string;
let sid: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "close-rivals-"));
	file = path.join(dir, "transcript.jsonl");
	config = path.join(dir, "config");
	sid = `close-rivals-${Math.random().toString(36).slice(2)}`;
	reset();
	/* The research-ladder limb's cap spent, so a still-close re-send meets
	 * this limb alone; the ladder has its own file (#2006). */
	seed(RESEARCH_LADDER_PREFIX, limbOf(RESEARCH_LADDER_PREFIX).cap);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/** The refusal the guard writes for `message`, or "" where it allows the stop. */
const stop = (
	message: string,
	{
		job = false,
		transcript = file,
	}: { job?: boolean; transcript?: string } = {},
) => stopGuardReason(GUARD, { dir, sid, message, job, transcript });

/* Unstamped, so no close-rivals count sees them; they pass every round under
 * the under-researched-round limb (#1710), which this file tests only where
 * it meets a passed close question (#1844). */
const RESEARCH = researchCalls().map((call) => JSON.stringify(call));
const write = (...lines: string[]) =>
	writeTranscript(file, ...lines, ...RESEARCH);

type Opt = [string, string];
/** One round; each option is [letter, "figure% (low% - high%)"]. */
function round(
	opts: Opt[],
	{
		relation = "rivals for one slot",
		extra = "",
		n = 1,
	}: { relation?: string; extra?: string; n?: number } = {},
): string {
	const body = opts
		.map(([l, price]) => `(${l}) option ${l}\nConfidence: ${price}. why`)
		.join("\n\n");
	return (
		`❓ **Q${n}** — Which?\n\nRelation: ${relation}\n\n${body}\n\n` +
		`➡ (${opts[0][0]}).${extra ? `\n\n${extra}` : ""}`
	);
}
const withMarker = (m: string) => `${m}\n\nneeds input: which option for Q1`;

const BOTH: Opt[] = [
	["A", "55% (45% - 65%)"],
	["B", "45% (35% - 55%)"],
];
const OVERLAP_ONLY: Opt[] = [
	["A", "70% (50% - 90%)"],
	["B", "30% (20% - 55%)"],
];
/* Its 62 top is also low-top, so a first sight logs trigger `both`. */
const GAP_ONLY: Opt[] = [
	["A", "62% (58% - 66%)"],
	["B", "38% (34% - 42%)"],
];
const NEITHER: Opt[] = [
	["A", "80% (75% - 85%)"],
	["B", "20% (15% - 25%)"],
];

/* The refusal record's time is the wall clock at refusal, so a tool call or
 * founder message counts as following it only when stamped after it. */
const toolCallAt = (ms: number) =>
	JSON.stringify(
		buildBashCall("ls", "t2", { timestamp: new Date(ms).toISOString() }),
	);
/* Real-epoch, unlike `founder()`'s synthetic clock — needed to place a founder
 * message AFTER a refusal without also landing after every synthetic-clock
 * timestamp already in the transcript (the re-price the founder's message retires, below; #659). */
const founderAt = (ms: number, text = "still go") =>
	[
		JSON.stringify({
			type: "user",
			origin: { kind: "human" },
			timestamp: new Date(ms).toISOString(),
			message: { role: "user", content: text },
		}),
		...RESEARCH,
	].join("\n");
const append = (...lines: string[]) =>
	fs.appendFileSync(file, `${lines.join("\n")}\n`);
const recordFile = () =>
	path.join(markersDir(dir), `.close-rivals-record-${sid}`);
const UNMEASURED = "Unmeasured: which the founder prefers, because it is taste";
const REPRICED = "with no tool call since this check refused it";
/* Only a close question's own line prints it; a re-price's does not. */
const CLOSE = "so the recommendation could flip";
/* A shape defect on its own question, so a block can carry it beside a close one. */
const TITLED =
	"❓ **Q1** — Which?\n\nRelation: rivals\n\n" +
	"(A) **Title** x\nConfidence: 80% (75% - 85%). why\n\n" +
	"(B) y\nConfidence: 20% (15% - 25%). why";
const { counter, seed } = sessionCounters(() => ({ dir, sid }));

describe("which questions are close", () => {
	beforeEach(() => write(founder()));

	it.each([
		["overlap alone", OVERLAP_ONLY],
		["gap alone", GAP_ONLY],
		["both", BOTH],
	])("refuses a pair close by %s", (_name, opts) => {
		expect(stop(round(opts as Opt[]))).toContain(CLOSE);
	});

	it("passes a pair that is neither", () => {
		expect(stop(round(NEITHER))).toBe("");
	});

	/* Two rivals 26 points apart top at 63, under the low-top line, so the
	 * wider one is refused as low-top alone. */
	it("counts a 25-point gap as close and a 26-point one as not", () => {
		expect(
			stop(
				round([
					["A", "62% (60% - 64%)"],
					["B", "37% (35% - 39%)"],
				]),
			),
		).toContain("25 points apart");
		const wider = stop(
			round(
				[
					["A", "63% (60% - 66%)"],
					["B", "37% (34% - 40%)"],
				],
				{ n: 2 },
			),
		);
		expect(wider).toContain("Q2: top option (A) 63% (60% - 66%)");
		expect(wider).not.toContain(CLOSE);
	});

	it("judges three rivals on the top two by headline figure", () => {
		const reason = stop(
			round([
				["A", "20% (15% - 25%)"],
				["B", "45% (40% - 50%)"],
				["C", "35% (30% - 40%)"],
			]),
		);
		expect(reason).toContain("(B) 45% (40% - 50%) against (C) 35% (30% - 40%)");
		expect(
			stop(
				round(
					[
						["A", "70% (65% - 75%)"],
						["B", "16% (10% - 20%)"],
						["C", "14% (10% - 18%)"],
					],
					{ n: 2 },
				),
			),
		).toBe("");
	});

	it("judges no pair in a combinable round", () => {
		expect(
			stop(
				round(
					[
						["A", "70% (50% - 90%)"],
						["B", "65% (45% - 85%)"],
					],
					{ relation: "independent, so any combination is takeable" },
				),
			),
		).toBe("");
	});

	it("leaves out an option declared unknowable, and passes a single remaining rival", () => {
		const m =
			"❓ **Q1** — Which?\n\nRelation: rivals for one slot\n\n" +
			"(A) option A\nConfidence: 70% (60% - 80%). why\n\n" +
			"(B) option B\nConfidence: unknowable — it turns on taste.\n\n➡ (A).";
		expect(stop(m)).toBe("");
	});
});

const NONE_LIKELY = "so none is likely right";
const YES_NO = "yes/no";
const COMBINABLE = "independent, so any combination is takeable";
const unknowable = (letter: string) =>
	`(${letter}) option ${letter}\nConfidence: unknowable — it turns on taste.`;

describe("a round whose top option is priced 65 or less (#2228, #2519)", () => {
	beforeEach(() => write(founder()));

	it.each([
		[
			"a 65/40 rival pair with bands apart",
			[
				["A", "65% (60% - 70%)"],
				["B", "40% (35% - 45%)"],
			],
			undefined,
			"both",
		],
		[
			"a three-way 65/20/15",
			[
				["A", "65% (60% - 70%)"],
				["B", "20% (15% - 25%)"],
				["C", "15% (10% - 20%)"],
			],
			undefined,
			"low-top",
		],
		[
			"a combinable round topped at 65",
			[
				["A", "65% (55% - 75%)"],
				["B", "30% (20% - 40%)"],
			],
			COMBINABLE,
			"low-top",
		],
		[
			"a yes/no at 65/35",
			[
				["A", "65% (60% - 70%)"],
				["B", "35% (30% - 40%)"],
			],
			YES_NO,
			"low-top",
		],
	])(
		"refuses %s once, then passes its next send",
		(_name, opts, relation, trigger) => {
			const sent = round(opts as Opt[], { relation });
			expect(stop(sent)).toContain(NONE_LIKELY);
			expect(stop(sent)).toBe("");
			expect(logLines()[0]).toEqual(
				expect.objectContaining({ kind: "refused", trigger }),
			);
		},
	);

	it.each([
		[
			"a 70/30 rival pair with bands apart",
			[
				["A", "70% (65% - 75%)"],
				["B", "30% (25% - 35%)"],
			],
			undefined,
		],
		[
			"a 75/25 rival pair with bands apart",
			[
				["A", "75% (70% - 80%)"],
				["B", "25% (20% - 30%)"],
			],
			undefined,
		],
		[
			"a combinable round topped at 70",
			[
				["A", "70% (60% - 80%)"],
				["B", "40% (30% - 50%)"],
			],
			COMBINABLE,
		],
	])("passes %s on first send", (_name, opts, relation) => {
		expect(stop(round(opts as Opt[], { relation }))).toBe("");
	});

	it("names the question, its top option with figure and band, and the 65 line", () => {
		const reason = stop(
			round(
				[
					["A", "65% (60% - 70%)"],
					["B", "20% (15% - 25%)"],
					["C", "15% (10% - 20%)"],
				],
				{ n: 2 },
			),
		);
		expect(reason).toContain(
			"Q2: top option (A) 65% (60% - 70%) — no option is priced above 65, so none is likely right. " +
				"What fact would make one option likely right, or show none is? Go and look for it.",
		);
		expect(reason).not.toContain(CLOSE);
		for (const test of [
			"the top option's band reaching down to the runner-up's",
			"25 points apart or fewer",
			"a top figure of 65 or less",
		])
			expect(reason).toContain(test);
	});

	it("gives a round both tests catch one refusal with one line naming both", () => {
		const reason = stop(round(BOTH));
		expect(reason.match(/^Q1: /gm)).toHaveLength(1);
		expect(reason).toMatch(
			/^Q1: .*could flip, and no option is priced above 65/m,
		);
		expect(counter(".close-rivals-nagged-")).toBe(1);
	});

	it("refuses a first send carrying a Checked: or Unmeasured: line", () => {
		for (const [n, extra] of [
			[1, "Checked: read the config; neither ships it"],
			[2, UNMEASURED],
		] as const)
			expect(
				stop(
					round(
						[
							["A", "60% (50% - 70%)"],
							["B", "30% (20% - 40%)"],
						],
						{ relation: COMBINABLE, extra, n },
					),
				),
			).toContain(NONE_LIKELY);
	});

	it("leaves an unknowable option out of the top figure", () => {
		const m =
			"❓ **Q1** — Which?\n\nRelation: rivals for one slot\n\n" +
			`${unknowable("A")}\n\n` +
			"(B) option B\nConfidence: 55% (45% - 65%). why\n\n➡ (B).";
		expect(stop(m)).toContain("Q1: top option (B) 55% (45% - 65%)");
	});

	it("leaves a block with no priced option unread", () => {
		const m =
			"❓ **Q1** — Which?\n\nRelation: rivals for one slot\n\n" +
			`${unknowable("A")}\n\n${unknowable("B")}\n\n➡ (A).`;
		expect(stop(m)).toBe("");
	});

	it("shares the close-rivals counter and cap, outside the session ceiling", () => {
		const lowTop = (n: number) =>
			round(
				[
					["A", "60% (50% - 70%)"],
					["B", "30% (20% - 40%)"],
				],
				{ relation: COMBINABLE, n },
			);
		expect(stop(round(BOTH))).toContain(CLOSE);
		for (const n of [2, 3]) expect(stop(lowTop(n))).toContain(NONE_LIKELY);
		expect(counter(".close-rivals-nagged-")).toBe(3);
		expect(counter(".priced-options-session-nagged-")).toBe(0);
		expect(stop(lowTop(4))).toBe("");
	});
});

describe("the escape lines", () => {
	const checked = "Checked: read the config; both ship it";

	it.each([
		["Checked:", checked],
		["Unmeasured:", UNMEASURED],
		["both", `${checked}\n\n${UNMEASURED}`],
		["neither", ""],
	])("refuses a first-sight question carrying %s (#1061)", (_name, line) => {
		write(founder());
		expect(stop(round(BOTH, { extra: line }))).toContain(CLOSE);
	});

	it.each([
		["Checked: added", "", checked],
		["Unmeasured: added", "", UNMEASURED],
		["no line, unchanged", "", ""],
		["the same line, unchanged", checked, checked],
		["a changed line", checked, "Checked: ran the probe; A wins on load"],
	])(
		"passes the same question's next send, %s, with no tool call since",
		(_name, first, second) => {
			write(founder());
			expect(stop(round(BOTH, { extra: first }))).toContain(CLOSE);
			expect(stop(round(BOTH, { extra: second }))).toBe("");
		},
	);

	it("passes the same question's next send after a tool call", () => {
		write(founder());
		expect(stop(round(BOTH))).toContain(CLOSE);
		append(toolCallAt(Date.now() + LATER));
		expect(stop(round(BOTH, { extra: UNMEASURED }))).toBe("");
	});

	it("passes an escape line resent unchanged from the send it was refused on", () => {
		write(founder());
		/* A record written before #1061 still carries the refused escape. */
		fs.mkdirSync(path.dirname(recordFile()), { recursive: true });
		fs.writeFileSync(
			recordFile(),
			JSON.stringify({
				at: Date.now(),
				questions: [
					{
						number: "1",
						bands: [
							{ letter: "A", figure: 55, low: 45, high: 65 },
							{ letter: "B", figure: 45, low: 35, high: 55 },
						],
						escape: "checked: read the config; both ship it",
					},
				],
			}),
		);
		expect(stop(round(BOTH, { extra: checked }))).toBe("");
	});

	it("passes an escape resent with only its spacing changed", () => {
		write(founder());
		fs.mkdirSync(path.dirname(recordFile()), { recursive: true });
		fs.writeFileSync(
			recordFile(),
			JSON.stringify({
				at: Date.now(),
				questions: [
					{
						number: "1",
						bands: [
							{ letter: "A", figure: 55, low: 45, high: 65 },
							{ letter: "B", figure: 45, low: 35, high: 55 },
						],
						escape: "checked: read the config; both ship it",
					},
				],
			}),
		);
		expect(
			stop(
				round(BOTH, { extra: "**Checked:**   read the config;  both ship it" }),
			),
		).toBe("");
	});

	it.each([
		["a task notification", notification],
		["a Stop block's feedback", stopFeedback],
		["a skill's expanded body", skillBody],
		["a tool result", toolResult],
	])("does not read %s as the founder speaking", (_name, rec) => {
		write(founder());
		expect(stop(round(BOTH))).toContain(CLOSE);
		/* Stamped after the refusal, where a founder message would retire it
		 * and let the re-price below through. */
		stampAfter(Date.now() + 90_000);
		append(rec());
		expect(stop(round(NEITHER))).toContain(REPRICED);
	});

	it.each(["Checked:", "**Checked:**", "Unmeasured:   ", "**Unmeasured:**"])(
		"refuses an escape line with nothing after its colon: %j",
		(line) => {
			write(founder());
			expect(stop(round(BOTH, { extra: line }))).toContain(CLOSE);
		},
	);

	it.each([
		"**Unmeasured:** the founder's taste, because nothing measures it",
		"**Unmeasured**: the founder's taste, because nothing measures it",
		"unmeasured: the founder's taste, because nothing measures it",
	])("refuses a first sight whatever the label's form: %j", (line) => {
		write(founder());
		expect(stop(round(BOTH, { extra: line }))).toContain(CLOSE);
	});

	it("refuses a first sight with the line anywhere in the flagged block", () => {
		write(founder());
		const m = round(BOTH).replace(
			"Relation:",
			"Unmeasured: the founder's taste, because nothing measures it\n\nRelation:",
		);
		expect(stop(m)).toContain(CLOSE);
	});

	it("refuses each close question of a round, escape line or not, naming each with its rival bands", () => {
		write(founder());
		const q1 = round(BOTH, {
			extra: "Unmeasured: the founder's taste, because nothing measures it",
		});
		const q2 = round(GAP_ONLY, { n: 2 });
		const reason = stop(`${q1}\n\n${q2}`);
		expect(reason).toContain(
			"Q1: (A) 55% (45% - 65%) against (B) 45% (35% - 55%)",
		);
		expect(reason).toContain(
			"Q2: (A) 62% (58% - 66%) against (B) 38% (34% - 42%)",
		);
	});

	it("reads no transcript to refuse a first sight", () => {
		const gone = { transcript: path.join(dir, "gone.jsonl") };
		expect(stop(round(BOTH, { extra: checked }), gone)).toContain(CLOSE);
		expect(failOpenLog(config)).not.toContain("close-rivals");
	});
});

describe("the refusal", () => {
	it("states the re-price rule in every close-rivals refusal", () => {
		write(founder());
		expect(stop(round(GAP_ONLY, { n: 2 }))).toContain(
			"Re-pricing is not a check",
		);
	});

	it("names the question, the pair, and states the whole rule", () => {
		write(founder());
		const reason = stop(round(BOTH));
		for (const part of [
			"A Stop guard refused this turn",
			"top two rivals sit close",
			"so the recommendation could flip",
			"Q1: (A) 55% (45% - 65%) against (B) 45% (35% - 55%)",
			"their bands overlap and their figures sit 10 points apart",
			"both apply",
			"narrowing the bands does not take a pair out of scope",
			"say what you ran and what it showed on a `Checked:` line",
			"why no cheap check reaches it on an `Unmeasured:` line",
			"so the recommendation could flip, and no option is priced above 65, so none is likely right",
			"What fact would make (B) beat (A), or make one option likely right? Go and look for it.",
			"whose top option is priced 65 or less",
			"rivals, yes/no or combinable: a top figure of 65 or less",
			"Name the fact that decides it, then look",
			"The line reports the look; it does not replace it",
			"judged later, in batch",
			"without a paid source",
			"`git`",
			"`gh` read",
			"throwaway script",
			"as far as any source you believe could answer it",
			'"are there further checks or research you can do"',
			"separates only rivals that are otherwise equal",
			"a search of precedent is no `Checked:` line on its own",
			"per use times how often and widely it repeats, against the cost of undoing the old way",
			"Merit wins once that look is done: only a gain small in total keeps the old way",
			"Every question a test catches is sent back once, whatever its `Checked:` or `Unmeasured:` line, so the line does not clear it",
			"the corrected question passes on its next send if no test still catches it",
			"Still caught, it passes only once each rung of the research ladder",
			"Re-pricing is not a check",
			"RE-SEND ONLY THE CORRECTED QUESTION",
		])
			expect(reason).toContain(part);
	});

	it("prints the house-decision rule for the look's stop, not a call or token budget (#1705)", () => {
		write(founder());
		const reason = stop(round(BOTH));
		const rule = ruleText("house-decision");
		expect(reason.replace(/\s+/g, " ")).toContain(rule.replace(/\s+/g, " "));
		expect(reason).not.toMatch(/10 tool calls|10k output tokens/);
	});

	it("rides in the one combined block with a shape defect", () => {
		write(founder());
		const reason = stop(`${TITLED}\n\n${round(BOTH, { n: 2 })}`);
		expect(reason).toContain("bold or titled name");
		expect(reason).toContain("Q2: (A) 55% (45% - 65%)");
		expect(reason.match(/A Stop guard refused this turn/g)).toHaveLength(1);
	});
});

describe("where it runs", () => {
	it.each([false, true])("behaves identically with job=%s", (job) => {
		write(founder());
		expect(stop(withMarker(round(BOTH)), { job })).toContain(CLOSE);
		expect(
			stop(
				withMarker(
					round(BOTH, {
						extra:
							"Unmeasured: the founder's taste, because nothing measures it",
					}),
				),
				{ job },
			),
		).toBe("");
	});
});

describe("its budget", () => {
	it("stops at its own cap of 3", () => {
		write(founder());
		for (let n = 1; n <= 3; n++)
			expect(stop(round(BOTH, { n }))).toContain(CLOSE);
		expect(stop(round(BOTH, { n: 4 }))).toBe("");
	});

	it("promises no refusal of the re-send on the refusal that spends its cap (#1808)", () => {
		write(founder());
		for (let n = 1; n <= 2; n++)
			expect(stop(round(BOTH, { n }))).toContain("is refused again");
		const last = stop(round(BOTH, { n: 3 }));
		expect(last).toContain(CLOSE);
		expect(last).not.toContain("refused again");
		expect(last).toContain(
			"Re-pricing is not a check. This is this check's last refusal this session, so it will not refuse the re-send: do the look before sending it.",
		);
	});

	it("counts outside the session ceiling, bounded only by its own cap (#1067)", () => {
		write(founder());
		const unpriced = withMarker(
			"❓ **Q1** — Which?\n\nRelation: rivals\n\n(A) x\n\n(B) y\n\n➡ (A).",
		);
		const close = (n: number) => withMarker(round(BOTH, { n }));
		expect(stop(unpriced, { job: true })).toContain("no Confidence line");
		expect(stop(unpriced, { job: true })).toContain("no Confidence line");
		expect(stop(close(2), { job: true })).toContain(CLOSE);
		expect(stop(close(3), { job: true })).toContain(CLOSE);
		/* Two ceiling blocks spent: the close blocks charged none,
		 * so its third is still refused and its own cap alone lets the fourth by. */
		expect(stop(close(4), { job: true })).toContain(CLOSE);
		expect(stop(close(5), { job: true })).toBe("");
		const filing = stop("Done.", { job: true });
		expect(filing).toContain("carrying neither status marker");
		expect(filing).not.toContain("last Stop block of the session");
	});

	it("leaves the ceiling counter unchanged on a block of its own", () => {
		write(founder());
		expect(stop(round(BOTH))).toContain(CLOSE);
		expect(counter(".priced-options-session-nagged-")).toBe(0);
		expect(counter(".close-rivals-nagged-")).toBe(1);
	});

	it("charges the ceiling once on a block it shares with another defect", () => {
		write(founder());
		expect(stop(`${TITLED}\n\n${round(BOTH, { n: 2 })}`)).toContain(CLOSE);
		expect(counter(".priced-options-session-nagged-")).toBe(1);
		expect(counter(".close-rivals-nagged-")).toBe(1);
		expect(counter(".priced-options-nagged-")).toBe(1);
	});

	it.each([
		["spent", 5],
		["at the shape reserve", 4],
	])(
		"still refuses with the ceiling %s, carrying only its own refusal (#1067)",
		(_, spent) => {
			write(founder());
			seed(".priced-options-session-nagged-", spent);
			const reason = stop(`${TITLED}\n\n${round(BOTH, { n: 2 })}`);
			expect(reason).toContain(CLOSE);
			expect(reason).not.toContain("bold or titled name");
			expect(reason).not.toContain("last Stop block of the session");
			expect(reason).not.toContain("for reply shape alone");
			expect(counter(".priced-options-session-nagged-")).toBe(spent);
			expect(counter(".close-rivals-nagged-")).toBe(1);
			expect(counter(".priced-options-nagged-")).toBe(0);
		},
	);

	it("says past the spent ceiling that only it and the evidence check still block", () => {
		write(founder());
		seed(".priced-options-session-nagged-", 5);
		seed(".close-rivals-nagged-", 2);
		const reason = stop(round(BOTH));
		expect(reason).toContain(CLOSE);
		expect(reason).toContain("session ceiling is spent");
		expect(reason).toContain(
			"Any per-counter notice below this one is superseded",
		);
	});

	it("charges the ceiling's last block, with its notice, on a close and filing turn at the reserve", () => {
		write(founder());
		seed(".priced-options-session-nagged-", 4);
		const reason = stop(round(BOTH), { job: true });
		expect(reason).toContain(CLOSE);
		expect(reason).toContain("last Stop block of the session");
		expect(counter(".priced-options-session-nagged-")).toBe(5);
		expect(counter(".close-rivals-nagged-")).toBe(1);
	});

	it("spends the shape tier's share, with its notice, on a close and shape turn", () => {
		write(founder());
		seed(".priced-options-session-nagged-", 3);
		const reason = stop(`${TITLED}\n\n${round(BOTH, { n: 2 })}`);
		expect(reason).toContain(CLOSE);
		expect(reason).toContain("bold or titled name");
		expect(reason).toContain("for reply shape alone");
		expect(counter(".priced-options-session-nagged-")).toBe(4);
	});

	it("leaves the reserved last block to the filing checks", () => {
		write(founder());
		seed(".priced-options-session-nagged-", 4);
		expect(stop(withMarker(round(BOTH)), { job: true })).toContain(CLOSE);
		expect(stop("Done.", { job: true })).toContain(
			"carrying neither status marker",
		);
	});
});

/* A close pair whose (A) carries a bold title, a shape fault. */
const CLOSE_TITLED =
	"❓ **Q1** — Which?\n\nRelation: rivals\n\n" +
	"(A) **Title** x\nConfidence: 55% (45% - 65%). why\n\n" +
	"(B) y\nConfidence: 45% (35% - 55%). why\n\n➡ (A).";

describe("a misshapen close question, held on its shape only where the shape limb is silent (#1742)", () => {
	it("names the shape fault in the close refusal, past the spent ceiling", () => {
		write(founder());
		seed(SESSION_PREFIX, SESSION_MAX);
		const reason = stop(CLOSE_TITLED);
		expect(reason).toContain(CLOSE);
		expect(reason).toContain(SHAPE_TOO);
		expect(reason).toContain("bold or titled name");
		expect(reason).toContain(SHAPE_HELD_PASS);
	});

	it("refuses the unchanged second send on its shape, and passes it fixed", () => {
		write(founder());
		seed(SESSION_PREFIX, SESSION_MAX);
		expect(stop(CLOSE_TITLED)).toContain(CLOSE);
		append(toolCallAt(Date.now() + LATER));
		const reason = stop(CLOSE_TITLED);
		expect(reason).toContain(STILL_WRONG);
		expect(reason).toContain(SHAPE_ONLY_PASS);
		expect(reason).not.toContain(CLOSE);
		expect(reason).not.toContain(ruleText("house-decision"));
		expect(counter(".close-rivals-nagged-")).toBe(2);
		expect(readJsonl(closeLog(dir))?.lines.at(-1)).toEqual(
			expect.objectContaining({
				round: "1",
				kind: "refused-misshapen",
				slot: 2,
			}),
		);
		expect(stop(round(BOTH))).toBe("");
	});

	it("holds the shape where the shape limb's own cap is spent and the ceiling is not", () => {
		write(founder());
		seed(SHAPE_PREFIX, SHAPE_CAP);
		expect(stop(CLOSE_TITLED)).toContain(SHAPE_TOO);
		expect(stop(CLOSE_TITLED)).toContain(STILL_WRONG);
	});

	it("names the shape fault in a re-price refusal too", () => {
		write(founder());
		seed(SESSION_PREFIX, SESSION_MAX);
		stop(CLOSE_TITLED);
		const reason = stop(
			CLOSE_TITLED.replace("55% (45% - 65%)", "60% (50% - 70%)"),
		);
		expect(reason).toContain(REPRICED);
		expect(reason).toContain(SHAPE_TOO);
	});

	it("names the misshapen re-send beside a close question in one refusal", () => {
		write(founder());
		seed(SESSION_PREFIX, SESSION_MAX);
		stop(CLOSE_TITLED);
		append(toolCallAt(Date.now() + LATER));
		const reason = stop(`${CLOSE_TITLED}\n\n${round(BOTH, { n: 2 })}`);
		expect(reason).toContain("or re-sends one still misshapen");
		expect(reason).toContain(STILL_WRONG);
		expect(reason).toContain(`Q2: ${"(A) 55% (45% - 65%)"}`);
		expect(reason).toContain(SHAPE_HELD_PASS);
	});

	it("names no shape fault where the shape limb speaks", () => {
		write(founder());
		const first = stop(CLOSE_TITLED);
		expect(first).toContain(CLOSE);
		expect(first).toContain("bold or titled name");
		expect(first).not.toContain(SHAPE_TOO);
		const second = stop(CLOSE_TITLED);
		expect(second).toContain("bold or titled name");
		expect(second).not.toContain(STILL_WRONG);
		expect(counter(".close-rivals-nagged-")).toBe(1);
		expect(counter(SHAPE_PREFIX)).toBe(2);
	});
});

describe("a re-priced question", () => {
	beforeEach(() => {
		write(founder(), toolCallAt(Date.now() - 60_000));
		expect(stop(round(BOTH))).toContain(CLOSE);
	});

	it.each([
		["to a clear split", round(NEITHER)],
		[
			"to a clear split with an escape line",
			round(NEITHER, { extra: UNMEASURED }),
		],
		[
			"with an escape line, still close",
			round(GAP_ONLY, { extra: UNMEASURED }),
		],
		[
			"in its bands alone",
			round([
				["A", "55% (50% - 60%)"],
				["B", "45% (40% - 50%)"],
			]),
		],
	])("is refused again with no tool call since, %s", (_name, message) => {
		const reason = stop(message);
		expect(reason).toContain(REPRICED);
		expect(reason).toContain("Q1: re-priced from (A) 55% (45% - 65%)");
	});

	it("keeps the refused figures, so re-sending the new ones is still a re-price", () => {
		expect(stop(round(NEITHER))).toContain(REPRICED);
		/* A third call here would read as this describe block's fourth close-rivals
		 * refusal (the beforeEach's own refusal spends the first), tripping the
		 * per-session cap of 3 and passing for the wrong reason. */
		expect(stop(round(NEITHER))).toContain(REPRICED);
		const record = JSON.parse(fs.readFileSync(recordFile(), "utf8"));
		expect(record.questions).toEqual([
			{
				number: "1",
				bands: [
					{ letter: "A", figure: 55, low: 45, high: 65 },
					{ letter: "B", figure: 45, low: 35, high: 55 },
				],
				refusedAt: expect.any(Number),
				cites: [],
			},
		]);
	});

	it("passes after a tool call", () => {
		append(toolCallAt(Date.now() + LATER));
		expect(stop(round(NEITHER))).toBe("");
	});

	it("passes still close after a tool call, being already refused (#1061)", () => {
		append(toolCallAt(Date.now() + LATER));
		expect(stop(round(GAP_ONLY))).toBe("");
	});

	it("passes at unchanged figures with an escape line added, no tool call since", () => {
		expect(stop(round(BOTH, { extra: UNMEASURED }))).toBe("");
	});

	it("is no re-price once the founder spoke after the refusal (#659)", () => {
		append(founderAt(Date.now() + LATER));
		expect(stop(round(NEITHER))).toBe("");
	});

	it("is refused afresh, close, once the founder spoke after the refusal (#659)", () => {
		append(founderAt(Date.now() + LATER));
		const reason = stop(round(BOTH, { extra: UNMEASURED }));
		expect(reason).toContain(CLOSE);
		expect(reason).not.toContain(REPRICED);
	});

	it("leaves a question of another number alone", () => {
		expect(stop(round(NEITHER, { n: 2 }))).toBe("");
	});

	it("is a new question once a Stop was let through", () => {
		expect(stop(round(BOTH, { extra: UNMEASURED }))).toBe("");
		expectOnlyThePass();
		expect(stop(round(NEITHER))).toBe("");
	});
});

describe("the refusal record", () => {
	beforeEach(() => write(founder()));

	it("is written to the markers directory, swept, and keeps each question's own refusal time across refusals", () => {
		stop(round(BOTH));
		const first = JSON.parse(fs.readFileSync(recordFile(), "utf8"));
		expect(first.questions).toEqual([
			{
				number: "1",
				bands: [
					{ letter: "A", figure: 55, low: 45, high: 65 },
					{ letter: "B", figure: 45, low: 35, high: 55 },
				],
				refusedAt: expect.any(Number),
				cites: [],
			},
		]);
		expect(typeof first.at).toBe("number");
		append(toolCallAt(Date.now() + LATER));
		stop(round(GAP_ONLY, { n: 2 }));
		const second = JSON.parse(fs.readFileSync(recordFile(), "utf8"));
		expect(
			second.questions.map((q: { number: string; refusedAt: number }) => [
				q.number,
				q.refusedAt === first.questions[0].refusedAt,
			]),
		).toEqual([
			["2", false],
			["1", true],
		]);
		const record = path.basename(recordFile());
		expect(sweptMarkers([record])).toEqual([record]);
	});

	/* Both questions refused in one turn, so each test below has two blocks of
	 * the cap left. */
	const q1AndQ2 = `${round(BOTH)}\n\n${round(BOTH, { n: 2 })}`;
	const both = () => expect(stop(q1AndQ2)).toContain(CLOSE);

	it("keeps a question the refused turn did not re-send, until a tool call", () => {
		both();
		expect(stop(round(NEITHER))).toContain(REPRICED);
		expect(stop(round(NEITHER, { n: 2 }))).toContain(REPRICED);
	});

	it("keeps a question the refused turn did not re-send after a tool call, as already refused (#1061)", () => {
		both();
		append(toolCallAt(Date.now() + LATER));
		const reason = stop(`${round(GAP_ONLY)}\n\n${round(BOTH, { n: 3 })}`);
		expect(reason).toContain("Q3:");
		expect(reason).not.toContain("Q1:");
		/* Q2 re-priced, but measured since its own refusal. */
		expect(
			stop(`${round(NEITHER, { n: 2 })}\n\n${round(BOTH, { n: 3 })}`),
		).toBe("");
	});

	it("reads a record written before #1098, each question refused at the record's own time", () => {
		const at = Date.now() - 120_000;
		fs.writeFileSync(
			recordFile(),
			JSON.stringify({
				at,
				questions: [
					{
						number: "1",
						bands: [
							{ letter: "A", figure: 55, low: 45, high: 65 },
							{ letter: "B", figure: 45, low: 35, high: 55 },
						],
					},
				],
			}),
		);
		expect(stop(round(NEITHER))).toContain(REPRICED);
		append(toolCallAt(at + LATER));
		expect(stop(round(NEITHER))).toBe("");
	});

	it("keeps an already-refused question recorded when another question blocks its turn", () => {
		expect(stop(round(BOTH))).toContain("Q1:");
		const reason = stop(q1AndQ2);
		expect(reason).toContain("Q2:");
		expect(reason).not.toContain("Q1:");
		expect(stop(q1AndQ2)).toBe("");
	});

	it.each([
		["malformed", () => fs.writeFileSync(recordFile(), "{not json")],
		[
			"holding a band with no figure",
			() =>
				fs.writeFileSync(
					recordFile(),
					JSON.stringify({
						at: Date.now(),
						questions: [{ number: "1", bands: [{ letter: "A" }] }],
					}),
				),
		],
		[
			"holding a question that is no object",
			() =>
				fs.writeFileSync(
					recordFile(),
					JSON.stringify({ at: Date.now(), questions: [null] }),
				),
		],
		[
			"carrying no questions",
			() => fs.writeFileSync(recordFile(), JSON.stringify({ at: Date.now() })),
		],
		[
			"unreadable",
			() => {
				fs.rmSync(recordFile(), { recursive: true, force: true });
				fs.mkdirSync(recordFile());
			},
		],
	])("fails open where it is %s, and logs it", (_name, spoil) => {
		stop(round(BOTH));
		spoil();
		/* The close resend first: a Stop let through rewrites the record. */
		expect(stop(round(BOTH, { extra: UNMEASURED }))).toBe("");
		spoil();
		expect(stop(round(NEITHER))).toBe("");
		spoil();
		/* Treated as already refused: a question never refused passes too. */
		expect(stop(round(BOTH, { n: 2 }))).toBe("");
		expect(failOpenLog(config)).toContain(
			"re-price allowed, caught question passed",
		);
	});

	it("fails open where the transcript cannot say, and logs it", () => {
		stop(round(BOTH));
		fs.rmSync(file);
		expect(stop(round(NEITHER))).toBe("");
		expect(failOpenLog(config)).toContain("re-price allowed");
	});
});

describe("the re-price refusal's budget", () => {
	beforeEach(() => write(founder()));

	it("spends the close-rivals counter and stops at its cap", () => {
		expect(stop(round(BOTH))).toContain(CLOSE);
		expect(stop(round(NEITHER))).toContain(REPRICED);
		expect(stop(round(NEITHER))).toContain(REPRICED);
		expect(stop(round(NEITHER))).toBe("");
	});

	it("counts outside the session ceiling, bounded only by its own cap (#1067)", () => {
		const unpriced = withMarker(
			"❓ **Q2** — Which?\n\nRelation: rivals\n\n(A) x\n\n(B) y\n\n➡ (A).",
		);
		expect(stop(unpriced, { job: true })).toContain("no Confidence line");
		expect(stop(unpriced, { job: true })).toContain("no Confidence line");
		expect(stop(withMarker(round(BOTH)), { job: true })).toContain(CLOSE);
		expect(stop(withMarker(round(NEITHER)), { job: true })).toContain(REPRICED);
		expect(stop(withMarker(round(NEITHER)), { job: true })).toContain(REPRICED);
		expect(stop(withMarker(round(NEITHER)), { job: true })).toBe("");
	});
});

const logLines = (): Record<string, unknown>[] =>
	readJsonl(closeLog(dir))?.lines ?? [];
const kinds = () => logLines().map((line) => line.kind);
const expectOnlyThePass = () =>
	expect(JSON.parse(fs.readFileSync(recordFile(), "utf8")).questions).toEqual([
		{ number: "1", passedAt: expect.any(Number) },
	]);

describe("the close-check log (#1101)", () => {
	beforeEach(() => write(founder()));

	const pairOf = (opts: Opt[]) => {
		const [top, runnerUp] = opts.map(([letter, price]) => {
			const [figure, low, high] = (price.match(/\d+/g) ?? []).map(Number);
			return { letter, figure, low, high };
		});
		return { top, runnerUp };
	};

	it("logs a first-sight refusal with every field and the cap slot it used", () => {
		expect(stop(round(BOTH))).toContain(CLOSE);
		expect(stop(round(OVERLAP_ONLY, { n: 2 }))).toContain(CLOSE);
		expect(logLines()).toEqual([
			{
				at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
				session: sid,
				repo: path.basename(dir),
				round: "1",
				kind: "refused",
				pair: pairOf(BOTH),
				slot: 1,
				trigger: "both",
			},
			expect.objectContaining({
				round: "2",
				kind: "refused",
				pair: pairOf(OVERLAP_ONLY),
				slot: 2,
				trigger: "close",
			}),
		]);
	});

	it("logs which test caught a first-sight refusal", () => {
		stop(
			round(
				[
					["A", "60% (50% - 70%)"],
					["B", "30% (20% - 40%)"],
				],
				{ relation: COMBINABLE },
			),
		);
		expect(logLines()).toEqual([
			expect.objectContaining({ kind: "refused", trigger: "low-top" }),
		]);
	});

	it("logs a re-price refusal with its slot and the figures it was re-sent at", () => {
		stop(round(BOTH));
		expect(stop(round(NEITHER))).toContain(REPRICED);
		expect(logLines()[1]).toEqual(
			expect.objectContaining({
				round: "1",
				kind: "refused-reprice",
				pair: pairOf(NEITHER),
				slot: 2,
			}),
		);
	});

	it("logs a refused question let through, with the tool calls since and the pair as refused", () => {
		stop(round(BOTH));
		append(toolCallAt(Date.now() + LATER));
		expect(stop(round(NEITHER))).toBe("");
		expect(logLines()[1]).toEqual({
			at: expect.any(String),
			session: sid,
			repo: path.basename(dir),
			round: "1",
			kind: "passed-after-refusal",
			pair: pairOf(NEITHER),
			toolCalls: 1,
			refusedPair: pairOf(BOTH),
			stillClose: false,
			rungs: { rulings: 0, web: 0, subagent: 0 },
			flipped: false,
			citesNewFact: false,
		});
		expectOnlyThePass();
		expect(kinds()).toEqual(["refused", "passed-after-refusal"]);
	});

	it("logs a refused question re-sent untooled as still close, at zero tool calls", () => {
		stop(round(BOTH));
		expect(stop(round(BOTH, { extra: UNMEASURED }))).toBe("");
		expect(logLines()[1]).toEqual(
			expect.objectContaining({ toolCalls: 0, stillClose: true }),
		);
	});

	it("logs null tool calls where the transcript cannot say", () => {
		stop(round(BOTH));
		fs.rmSync(file);
		expect(stop(round(NEITHER))).toBe("");
		expect(logLines()[1]).toEqual(
			expect.objectContaining({
				kind: "passed-after-refusal",
				toolCalls: null,
			}),
		);
	});

	it("logs a pass only at the Stop that lets the question through", () => {
		stop(round(BOTH));
		append(toolCallAt(Date.now() + LATER));
		expect(stop(`${round(BOTH)}\n\n${TITLED.replace("Q1", "Q2")}`)).toContain(
			"bold or titled name",
		);
		expect(kinds()).toEqual(["refused"]);
		expect(stop(round(BOTH))).toBe("");
		expect(kinds()).toEqual(["refused", "passed-after-refusal"]);
	});

	it("logs a refused question the passing send leaves out, having re-sent it on a blocked one", () => {
		stop(round(BOTH));
		append(toolCallAt(Date.now() + LATER));
		expect(stop(`${round(NEITHER)}\n\n${round(BOTH, { n: 2 })}`)).toContain(
			"Q2:",
		);
		append(toolCallAt(Date.now() + 120_000));
		expect(stop(round(NEITHER, { n: 2 }))).toBe("");
		expect(logLines().map((line) => [line.round, line.kind])).toEqual([
			["1", "refused"],
			["2", "refused"],
			["2", "passed-after-refusal"],
			["1", "passed-after-refusal"],
		]);
		expect(logLines()[3]).toEqual(
			expect.objectContaining({
				pair: null,
				toolCalls: 2,
				refusedPair: pairOf(BOTH),
				stillClose: null,
			}),
		);
	});

	it("logs the close question the spent cap lets through", () => {
		for (let n = 1; n <= 3; n++) stop(round(BOTH, { n }));
		expect(stop(round(BOTH, { n: 4 }))).toBe("");
		expect(
			logLines().map((line) => [line.round, line.kind, line.slot]),
		).toEqual([
			["1", "refused", 1],
			["2", "refused", 2],
			["3", "refused", 3],
			["4", "passed-at-cap", undefined],
			["3", "passed-after-refusal", undefined],
			["2", "passed-after-refusal", undefined],
			["1", "passed-after-refusal", undefined],
		]);
		expect(logLines()[3]).toEqual(
			expect.objectContaining({ pair: pairOf(BOTH), trigger: "both" }),
		);
	});

	it("logs a caught question passed on an unreadable record", () => {
		fs.mkdirSync(recordFile(), { recursive: true });
		expect(stop(round(BOTH))).toBe("");
		expect(logLines()).toEqual([
			expect.objectContaining({
				round: "1",
				kind: "passed-unreadable",
				pair: pairOf(BOTH),
				trigger: "both",
			}),
		]);
	});

	it("logs nothing for a question that is not close", () => {
		expect(stop(round(NEITHER))).toBe("");
		expect(fs.existsSync(closeLog(dir))).toBe(false);
	});

	it("keeps its decision where the log will not take a write, and logs that", () => {
		fs.mkdirSync(closeLog(dir), { recursive: true });
		expect(stop(round(BOTH))).toContain(CLOSE);
		expect(counter(".close-rivals-nagged-")).toBe(1);
		expect(failOpenLog(config)).toContain(
			"log .close-check-log.jsonl would not be written",
		);
		expect(stop(round(BOTH))).toBe("");
	});

	it("keeps its decision, logging one fail-open line, where refusal-log will not load (#1747)", () => {
		withUnloadable("refusal-log", () => {
			expect(stop(round(BOTH))).toContain(CLOSE);
		});
		expect(
			failOpenLog(config).match(
				/log \.close-check-log\.jsonl would not be written/g,
			),
		).toHaveLength(1);
	});

	it("is named outside every swept marker family", () => {
		expect(sweptMarkers([path.basename(closeLog(dir))])).toEqual([]);
	});
});

describe("a pass another Stop hook refuses (#1844)", () => {
	beforeEach(() => write(founder()));

	const passOnResend = () => {
		expect(stop(round(BOTH))).toContain(CLOSE);
		expect(stop(round(BOTH, { extra: UNMEASURED }))).toBe("");
	};

	it("does not refuse the re-send again, nor log it twice", () => {
		passOnResend();
		append(siblingBlock());
		expect(stop(round(BOTH, { extra: UNMEASURED }))).toBe("");
		expect(kinds()).toEqual(["refused", "passed-after-refusal"]);
		expect(counter(".close-rivals-nagged-")).toBe(1);
	});

	it("does not log twice a close question it passed at its cap", () => {
		seed(".close-rivals-nagged-", 3);
		expect(stop(round(BOTH))).toBe("");
		append(siblingBlock());
		expect(stop(round(BOTH))).toBe("");
		expect(kinds()).toEqual(["passed-at-cap"]);
	});

	it("leaves the re-send to this limb, so the under-researched-round limb does not judge it", () => {
		writeTranscript(file, founder());
		passOnResend();
		append(siblingBlock());
		/* Not close, so only the passed number keeps that limb off it. */
		expect(stop(round(NEITHER))).toBe("");
	});

	it("keeps the pass through this guard's own block on the re-send", () => {
		passOnResend();
		append(siblingBlock());
		expect(stop(`${round(BOTH)}\n\n${round(GAP_ONLY, { n: 2 })}`)).toContain(
			"Q2:",
		);
		append(stopFeedback());
		expect(stop(`${round(BOTH)}\n\n${round(GAP_ONLY, { n: 2 })}`)).toBe("");
		expect(kinds()).toEqual([
			"refused",
			"passed-after-refusal",
			"refused",
			"passed-after-refusal",
		]);
	});

	it("leaves to the under-researched-round limb a question it passed, re-sent close (#1949)", () => {
		expect(stop(round(NEITHER))).toBe("");
		const roundLines = () =>
			readJsonl(logPath(dir, ROUND_CHECK_LOG))?.lines.length;
		const logged = roundLines();
		append(siblingBlock());
		expect(stop(round(BOTH))).toBe("");
		expect(kinds()).toEqual([]);
		expect(roundLines()).toBe(logged);
	});

	it("judges afresh a reused number the under-researched-round limb passed, once the founder speaks", () => {
		expect(stop(round(NEITHER))).toBe("");
		append(siblingBlock());
		append(founder(), ...RESEARCH);
		expect(stop(round(BOTH))).toContain(CLOSE);
	});

	it("retires the pass where the transcript cannot say at the re-send", () => {
		passOnResend();
		append(siblingBlock());
		fs.rmSync(file);
		expect(stop(round(BOTH))).toContain(CLOSE);
	});

	it.each([
		["the founder speaks", () => founder()],
		["a task notification wakes the session", () => notification()],
	])("judges a reused number afresh once %s", (_name, next) => {
		passOnResend();
		append(siblingBlock());
		append(next(), ...RESEARCH);
		expect(stop(round(BOTH))).toContain(CLOSE);
	});
});
