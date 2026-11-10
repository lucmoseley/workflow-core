// @vitest-environment node
/*
 * Pins issue-gate.js: the date and condition markers that hold an issue out of
 * pick-next.js's shortlist, the day a date gate lapses, the gate-basis checks,
 * the gating rule's hand-over, and the second-map refusal.
 *
 * Pure function tests with the clock passed in, because the time-of-day branch
 * is unreachable from a suite that cannot choose the hour it runs at.
 *
 * Breaking it hides a ticket on the morning its chase is due (the gate once
 * turned at UTC midnight, 08:00 in Lombok), or holds one on a marker nobody can
 * read. Tickets: mantahostels#85 (the date marker) and mantahostels#1419 (the
 * condition marker), #672, #823 and #4946 (the basis line), #717 (the second map);
 * the clock fix came from a code review, with no ticket of its own.
 */

import { describe, expect, it } from "vitest";
import { readRuleText } from "./rule-text";

const {
	gateOf,
	gateOnOf,
	resolveGate,
	basisFaults,
	introducedBasisFaults,
	basisRefusal,
	gateRuleHandover,
	isNewlyGated,
	UNFILLED_DESTINATION,
	secondMapVerdict,
} = require("./issue-gate.js");

/** 2026-08-24, 17:00 UTC — which is already the 25th in WITA (UTC+8). */
const WITA_25_UTC_24 = Date.parse("2026-08-24T17:00:00Z");
/** 2026-08-24, 02:00 UTC — the 24th on both clocks. */
const BOTH_24 = Date.parse("2026-08-24T02:00:00Z");
/** 2026-08-23, 17:00 UTC — already the 24th in WITA, still the 23rd in UTC. */
const WITA_24_UTC_23 = Date.parse("2026-08-23T17:00:00Z");

describe("the day a gate turns on", () => {
	it("is spent on the date it names, not the day after", () => {
		expect(gateOf("**Gated until:** 2026-08-24 — x", BOTH_24)).toMatchObject({
			active: false,
			daysLeft: 0,
		});
	});

	it("still holds the day before", () => {
		expect(
			gateOf(
				"**Gated until:** 2026-08-24 — x",
				Date.parse("2026-08-23T02:00:00Z"),
			),
		).toMatchObject({ active: true, daysLeft: 1 });
	});

	/*
	 * The eight hours that separate the two clocks. At 17:00 UTC on the 23rd it
	 * is already the 24th in Lombok, so a gate naming the 24th is spent — reading
	 * UTC would hold it for another seven hours of the founder's morning.
	 */
	it("lapses on WITA's midnight, not UTC's", () => {
		expect(
			gateOf("**Gated until:** 2026-08-24 — x", WITA_24_UTC_23),
		).toMatchObject({ active: false, daysLeft: 0 });
	});

	it("counts the days left on WITA's calendar too", () => {
		expect(
			gateOf("**Gated until:** 2026-08-26 — x", WITA_25_UTC_24),
		).toMatchObject({ active: true, daysLeft: 1 });
	});
});

describe("what it reads out of a body", () => {
	it("returns null where the body carries no marker", () => {
		expect(gateOf("no marker here", BOTH_24)).toBeNull();
	});

	it("ignores a marker that is not at the head of its own line", () => {
		expect(gateOf("see **Gated until:** 2026-09-01 — x", BOTH_24)).toBeNull();
	});

	it("takes the reason after an em dash, en dash or spaced hyphen", () => {
		for (const sep of ["—", "–", "-"])
			expect(
				gateOf(`**Gated until:** 2026-09-01 ${sep} chase #2 due`, BOTH_24),
			).toMatchObject({ iso: "2026-09-01", reason: "chase #2 due" });
	});

	it("keeps the date whole when there is no reason at all", () => {
		expect(gateOf("**Gated until:** 2026-09-01", BOTH_24)).toMatchObject({
			iso: "2026-09-01",
			reason: null,
		});
	});

	it("carries the whole tail back when the date is unreadable", () => {
		expect(gateOf("**Gated until:** next Tuesday — soon", BOTH_24)).toEqual({
			malformed: true,
			raw: "next Tuesday — soon",
			reason: null,
		});
	});

	it("reads the tail less its outer blanks, and a tail of blanks alone as malformed", () => {
		expect(
			gateOf("**Gated until:** \t 2026-09-01 — x y \t", BOTH_24),
		).toMatchObject({ iso: "2026-09-01", reason: "x y" });
		expect(gateOf("**Gated until:** \t ", BOTH_24)).toEqual({
			malformed: true,
			raw: " ",
			reason: null,
		});
	});

	it("rejects a well-shaped date that is not a real day, recording it as raw", () => {
		// 2026-02-30 parses in JS and silently becomes 2 March.
		expect(gateOf("**Gated until:** 2026-02-30 — typo", BOTH_24)).toMatchObject(
			{ malformed: true, raw: "2026-02-30" },
		);
	});

	it("skips a marker quoted inside a fenced code block (#612)", () => {
		const body = "```\n**Gated until:** 2020-01-01 — x\n```";
		expect(gateOf(body, BOTH_24)).toBeNull();
	});

	it("still reads a real marker that follows a fenced example", () => {
		const body = [
			"```",
			"**Gated until:** 2020-01-01 — example",
			"```",
			"**Gated until:** 2026-09-01 — the real one",
		].join("\n");
		expect(gateOf(body, BOTH_24)).toMatchObject({
			iso: "2026-09-01",
			reason: "the real one",
		});
	});
});

describe("gateOnOf — the data-condition marker", () => {
	it("returns null where the body carries no marker", () => {
		expect(gateOnOf("no marker here")).toBeNull();
	});

	it("reads a condition, a command and an abort clause", () => {
		expect(
			gateOnOf(
				"**Gated on:** the cohort has cleared 21 days — check: `python3 scan.py` — abandon if: the label stops being applied",
			),
		).toEqual({
			condition: "the cohort has cleared 21 days",
			command: "`python3 scan.py`",
			abandonIf: "the label stops being applied",
		});
	});

	it("reads a condition with no command at all, which is valid", () => {
		expect(
			gateOnOf(
				"**Gated on:** an `opusplan` session has happened — abandon if: the mode is retired",
			),
		).toEqual({
			condition: "an `opusplan` session has happened",
			command: null,
			abandonIf: "the mode is retired",
		});
	});

	it("carries the whole tail back when the abort clause is missing", () => {
		// Required (mantahostels#1333): the only thing that ever retires a condition nobody
		// will meet, since a judge only strips one met.
		expect(
			gateOnOf("**Gated on:** enough samples exist — check: `npm run count`"),
		).toEqual({
			malformed: true,
			raw: "enough samples exist — check: `npm run count`",
			reason: "no `— abandon if:`",
		});
	});

	// mantahostels#1332 ruled the malformed line fails open, so the printer needs to tell
	// "nothing after the marker" from a valid command-less condition.
	it("is malformed when nothing follows the marker at all", () => {
		expect(gateOnOf("**Gated on:**")).toEqual({
			malformed: true,
			raw: "",
			reason: "no `— abandon if:`",
		});
	});

	// Also mantahostels#1332: an announced-but-empty clause retires nothing, so it is the
	// missing-clause case rather than a valid gate.
	it("is malformed when the abort clause is announced but left empty", () => {
		expect(gateOnOf("**Gated on:** enough samples — abandon if:")).toEqual({
			malformed: true,
			raw: "enough samples — abandon if:",
			reason: "empty `abandon if:` clause",
		});
	});

	it("ignores a marker that is not at the head of its own line", () => {
		expect(
			gateOnOf("write it as **Gated on:** x — abandon if: y, like so"),
		).toBeNull();
	});

	// CommonMark's un-indented-paragraph rule, the tolerance mantahostels#1419 shares with
	// the date marker rather than hand-copying.
	it("tolerates up to three spaces of indent and no more", () => {
		const line = "**Gated on:** c — abandon if: a";
		expect(gateOnOf(`   ${line}`)).toMatchObject({ condition: "c" });
		expect(gateOnOf(`    ${line}`)).toBeNull();
	});

	it("keeps a condition containing em dashes whole", () => {
		// The segments are dash-separated, so a naive split mangles exactly the
		// content it was meant to leave alone.
		expect(
			gateOnOf(
				"**Gated on:** eleven tickets — all of them, control included — have matured — check: `scan.py` — abandon if: the cohort freezes",
			),
		).toEqual({
			condition:
				"eleven tickets — all of them, control included — have matured",
			command: "`scan.py`",
			abandonIf: "the cohort freezes",
		});
	});

	// Matching the date marker's own separator set.
	it("takes the segment separator as an em dash, en dash or hyphen", () => {
		for (const sep of ["—", "–", "-"])
			expect(
				gateOnOf(`**Gated on:** c ${sep} check: cmd ${sep} abandon if: a`),
			).toEqual({ condition: "c", command: "cmd", abandonIf: "a" });
	});

	it("is malformed where the condition holds a second `— check: `", () => {
		const raw =
			"rerun — check: the corpus first — then confirm n > 30 — check: `scan.py` — abandon if: the label is retired";
		expect(gateOnOf(`**Gated on:** ${raw}`)).toEqual({
			malformed: true,
			raw,
			reason: "more than one `— check:`",
		});
	});

	it("is malformed where the tail holds a second `— abandon if: `", () => {
		const raw =
			"hold until we know — abandon if: unclear — check: cmd — abandon if: retired";
		expect(gateOnOf(`**Gated on:** ${raw}`)).toEqual({
			malformed: true,
			raw,
			reason: "more than one `— abandon if:`",
		});
	});

	it("is malformed where the condition is empty", () => {
		const raw = "— abandon if: it lapses";
		expect(gateOnOf(`**Gated on:** ${raw}`)).toEqual({
			malformed: true,
			raw,
			reason: "empty condition",
		});
	});

	// A fenced block is not indented, so AT_LINE_HEAD alone never excludes it (mantahostels#1435).
	it("skips a marker quoted inside a fenced code block", () => {
		const body = [
			"See the shape:",
			"```",
			"**Gated on:** rerun — check: the corpus first — then confirm n > 30 — abandon if: the label is retired",
			"```",
			"No live gate on this issue.",
		].join("\n");
		expect(gateOnOf(body)).toBeNull();
	});

	it("still reads a real marker that follows a fenced example", () => {
		const body = [
			"```",
			"**Gated on:** example — check: cmd — abandon if: a",
			"```",
			"**Gated on:** the real one — abandon if: it lapses",
		].join("\n");
		expect(gateOnOf(body)).toEqual({
			condition: "the real one",
			command: null,
			abandonIf: "it lapses",
		});
	});
});

describe("resolveGate — the shared reading of the pair", () => {
	it("holds on an active date gate alone", () => {
		expect(
			resolveGate("**Gated until:** 2026-08-26 — x", WITA_25_UTC_24),
		).toMatchObject({ conflict: false, gateHolds: true, gateOnHolds: false });
	});

	it("does not hold on a lapsed date gate", () => {
		expect(
			resolveGate("**Gated until:** 2026-08-24 — x", BOTH_24),
		).toMatchObject({ conflict: false, gateHolds: false, gateOnHolds: false });
	});

	it("holds on a well-formed condition gate alone", () => {
		expect(
			resolveGate("**Gated on:** c — abandon if: a", BOTH_24),
		).toMatchObject({ conflict: false, gateHolds: false, gateOnHolds: true });
	});

	it("does not hold on a malformed condition gate", () => {
		expect(resolveGate("**Gated on:** c", BOTH_24)).toMatchObject({
			conflict: false,
			gateHolds: false,
			gateOnHolds: false,
		});
	});

	it("holds neither where a body carries both markers", () => {
		const body =
			"**Gated until:** 2026-08-26 — x\n\n**Gated on:** c — abandon if: a";
		expect(resolveGate(body, WITA_25_UTC_24)).toMatchObject({
			conflict: true,
			gateHolds: false,
			gateOnHolds: false,
		});
	});

	it("forwards its clock to the date gate, the same as gateOf", () => {
		expect(
			resolveGate("**Gated until:** 2026-08-24 — x", BOTH_24).gate,
		).toEqual(gateOf("**Gated until:** 2026-08-24 — x", BOTH_24));
	});

	it("holds the same with or without a basis, which it only reports", () => {
		const until = "**Gated until:** 2026-08-26 — x";
		const on = "**Gated on:** c — abandon if: a";
		const basis = "\n**Gate basis:**  weekly export ";
		const held = (body: string) => {
			const { gateHolds, gateOnHolds } = resolveGate(body, WITA_25_UTC_24);
			return { gateHolds, gateOnHolds };
		};
		expect(held(until + basis)).toEqual(held(until));
		expect(held(on + basis)).toEqual(held(on));
		expect(resolveGate(until + basis, WITA_25_UTC_24).basis).toBe(
			"weekly export",
		);
		expect(resolveGate(until, WITA_25_UTC_24).basis).toBeNull();
	});

	it("holds neither where the body carries no marker at all", () => {
		expect(resolveGate("no marker here", BOTH_24)).toMatchObject({
			conflict: false,
			gateHolds: false,
			gateOnHolds: false,
		});
	});
});

const faultTexts = (body: string, own?: number): string[] =>
	basisFaults(body, own).map((f: { text: string }) => f.text);
const introducedTexts = (before: string, after: string): string[] =>
	introducedBasisFaults(before, after).map((f: { text: string }) => f.text);

describe("basisFaults — a wait with nothing behind it (#672)", () => {
	it("names a gate line and each prose wait where no basis is written", () => {
		expect(
			faultTexts(
				"**Gated on:** census lands — abandon if: never\nre-run it after a week live",
			),
		).toEqual([
			"**Gated on:** census lands — abandon if: never",
			"after a week",
		]);
		expect(faultTexts("Re-measure about two weeks after the reword")).toEqual([
			"two weeks after",
		]);
		expect(
			faultTexts("run it a day after the fix, or four weeks later"),
		).toEqual(["a day after", "four weeks later"]);
	});

	it("is empty once a basis is written anywhere in the body", () => {
		expect(
			faultTexts(
				"**Gated until:** 2026-09-29 — a day\n**Gate basis:** counters live 24 hours (#616)",
			),
		).toEqual([]);
	});

	it("ignores measurement windows, fenced blocks and inline code", () => {
		for (const body of [
			"80 asks in 30 days",
			"```\n**Gated until:** 2026-10-05\nafter a week\n```",
			"the phrase `after a week` is an example",
		])
			expect(faultTexts(body)).toEqual([]);
	});

	it("counts only what an edit adds, a moved date included", () => {
		const old = "**Gated until:** 2026-10-05 — x\nafter a week live";
		expect(introducedTexts(old, `${old}\nnote`)).toEqual([]);
		expect(introducedTexts(old, old.replace("10-05", "10-12"))).toEqual([
			"**Gated until:** 2026-10-12 — x",
		]);
	});
});

describe("basisFaults — each window its basis names (#823)", () => {
	const gate816 =
		"**Gated on:** the repo is created — abandon if: 7 days pass after the repo is created";

	it("prints the basis template from its span", () => {
		const body = `${gate816}\n**Gate basis:**\n**Gate basis:** 3 days`;
		expect(basisRefusal(basisFaults(body))).toContain(
			`§Gating an issue. ${readRuleText("gate-basis-line")}`,
		);
	});

	it("names the window, not a missing basis, where the first basis is empty", () => {
		const body = `${gate816}\n**Gate basis:**\n**Gate basis:** 3 days`;
		expect(basisRefusal(basisFaults(body))).toContain(
			"a window the `**Gate basis:**` line does not name",
		);
	});

	it("refuses a gate whose abandon clause carries a window the basis omits", () => {
		const body = `${gate816}, or 3 days pass with no reply\n**Gate basis:** the vendor answers in 3 days (#790)`;
		const faults = basisFaults(body);
		expect(faults).toEqual([{ kind: "unnamed-window", text: "7 days" }]);
		const refusal = basisRefusal(faults);
		expect(refusal).toContain('"7 days", a window the `**Gate basis:**` line');
		expect(refusal).toContain("and never judges it");
	});

	it("passes a basis naming every window, by length rather than spelling", () => {
		expect(
			faultTexts(
				`${gate816}\n**Gate basis:** a week: the 3-day reply window, doubled and rounded up (#790)`,
			),
		).toEqual([]);
		expect(
			faultTexts(
				"wait two weeks after launch\n**Gate basis:** traffic stabilises within 14 days (#12)",
			),
		).toEqual([]);
	});

	it("checks prose waits and every gate line, but not a window in inline code", () => {
		expect(
			faultTexts(
				"**Gated until:** 2026-10-09 — 5 days after the fix\nre-run it four weeks later\n**Gate basis:** the fix soaks 5 days (#12)",
			),
		).toEqual(["four weeks"]);
		expect(
			faultTexts(
				"**Gated on:** x — check: `grep '2 days'` — abandon if: never\n**Gate basis:** none needed",
			),
		).toEqual([]);
	});

	it("reads no window in a frequency or a check: command", () => {
		expect(
			faultTexts(
				"**Gated on:** the cron has run once a day — check: gh run list --created 2 days — abandon if: never\n**Gate basis:** n/a",
			),
		).toEqual([]);
	});

	it("catches a word between the window and 'after' as a prose wait", () => {
		expect(faultTexts("abandon it once 7 days pass after creation")).toEqual([
			"7 days pass after",
		]);
		for (const body of [
			"within 30 days and after launch",
			"We spent two weeks right after launch",
		])
			expect(faultTexts(body)).toEqual([]);
	});

	it("refuses only the window an edit adds, naming it, so an old body stays editable", () => {
		const old = `${gate816}\n**Gate basis:** the vendor answers in 3 days`;
		expect(introducedTexts(old, `${old}\nnote`)).toEqual([]);
		expect(introducedTexts(old, `${old}\nre-check it 2 months later`)).toEqual([
			"2 months",
		]);
	});
});

describe("basisFaults — the wordings the #4929 audit found escaping (#4946)", () => {
	const fault = (body: string) => faultTexts(body);

	it("reads an hour window as a wait and as a window, `24 h` the length of a day", () => {
		expect(fault("re-measure once it has run 8 hours on 585143e")).toEqual([
			"has run 8 hours",
		]);
		expect(fault("24 h have run since 14a8534be")).toEqual([
			"24 h have run since",
		]);
		const gate =
			"**Gated on:** 24 h have run since 14a8534be — abandon if: it is reverted";
		expect(fault(`${gate}\n**Gate basis:** #12 ruled a day`)).toEqual([]);
		expect(fault(`${gate}\n**Gate basis:** #12 ruled 3 days`)).toEqual([
			"24 h",
		]);
		expect(
			fault(
				"**Gated on:** 24 hrs of data — abandon if: never\n**Gate basis:** #12 ruled 3 days",
			),
		).toEqual(["24 hrs"]);
	});

	it("still reads every wait the reading before #4949 read", () => {
		for (const [body, wait] of [
			["Check in 7 days after launch.", "7 days after"],
			["Wait 3-4 days after launch.", "4 days after"],
			["past 2 days after the fix", "2 days after"],
		])
			expect(fault(body)).toEqual([wait]);
		expect(
			fault(
				"**Gated on:** 3-4 hours of data — abandon if: never\n**Gate basis:** #12 ruled a week",
			),
		).toEqual(["4 hours"]);
	});

	it("reads a determiner or an ordinal as a count of one", () => {
		for (const [body, wait] of [
			["count them over the week after #4807 landed", "the week after"],
			["over the first week after the build", "the first week after"],
			["read it the next day after the fix", "the next day after"],
			["over the first full day after landing", "the first full day after"],
			["flips if week one shows the cap spent", "week one"],
			["flips if week 1 shows the cap spent", "week 1"],
		])
			expect(fault(body)).toEqual([wait]);
		expect(fault("Ship it the day after the merge.")).toEqual([]);
		expect(
			fault(
				"count them over the week after it lands\n**Gate basis:** #12 ruled 3 days",
			),
		).toEqual(["the week"]);
		expect(
			fault(
				"count them over the week after it lands\n**Gate basis:** #12 ruled 7 days",
			),
		).toEqual([]);
	});

	it("reads through a modifier between the count and the unit", () => {
		expect(fault("the first retro 7 or more days after the fix lands")).toEqual(
			["7 or more days after"],
		);
		expect(
			fault(
				"**Gated on:** 7 consecutive UTC days after the later landing each hold 48 hours — abandon if: never\n**Gate basis:** #2821 ruled it",
			),
		).toEqual(["7 consecutive UTC days", "48 hours"]);
	});

	it("reads a wait counted from an event", () => {
		for (const [body, wait] of [
			["sessions on 3 days since that pin landed", "3 days since"],
			["seven days have passed since the fix", "seven days have passed since"],
			["3 days has run since the fix", "3 days has run since"],
			[
				"24 h of suite-queue logs have accrued since #3864 closed",
				"24 h of suite-queue logs have accrued since",
			],
		])
			expect(fault(body)).toEqual([wait]);
	});

	it("reads accumulated running time", () => {
		expect(fault("once the test has run a week in all three repos")).toEqual([
			"has run a week",
		]);
		expect(fault("it reads a full day of drops")).toEqual(["a full day of"]);
	});

	it("reads a hyphen window before a wait noun, with no 'after'", () => {
		for (const [body, wait] of [
			["gated on a 7-day post-rollout reading", "7-day post-rollout reading"],
			["start its 14-day trial", "14-day trial"],
			["a one-week soak", "one-week soak"],
			[
				"the body sets a one-week measurement window",
				"one-week measurement window",
			],
		])
			expect(fault(body)).toEqual([wait]);
	});

	it("reads a determiner window before 'window' or 'of <noun>', then 'after'", () => {
		expect(fault("the 24 h window after cutover has closed")).toEqual([
			"the 24 h window after",
		]);
		expect(
			fault(
				"**Gated until:** 2026-10-31 — the week of memwatch after #2741's archive landed\n**Gate basis:** #12 ruled 3 days",
			),
		).toEqual(["the week"]);
	});

	it("still reads the controls", () => {
		expect(fault("a week after landing")).toEqual(["a week after"]);
		expect(fault("7 days pass after the repo is created")).toEqual([
			"7 days pass after",
		]);
	});

	it("leaves a measurement span, a frequency and a quoted wording alone", () => {
		for (const body of [
			"80 asks in 30 days",
			"over the last 24 hours",
			"the cron runs once a day",
			"it polls every 2 hours after boot",
			"the wording `the week after` is an example",
			"```\n24 h have run since\n```",
			// Each a span the widened patterns matched over every issue body (#4949).
			"away mode ran 3-4 hours after his return",
			"two workers spun for ~7.5 h after their session ended",
			"earlier reviews were answered 20 min to 6 h after filing",
			"about 4.5 suite-min in 7 h after #1216",
			"it fails only after 14 h with no push",
			"flag it at once rather than after 24 hours",
			"the founder learned of it about 3.5 hours later",
			"ci.yml still runs it, up to ~12 hours from now",
			"its 24-hour window waits on an mtime",
			"every seat's week and 5-hour readings",
			"the 7-day status window stays as recorded",
			"a 4-week baseline window",
			"177 candidates in a normal 2-day window",
			"re-running the count over a later 30-day window",
			"232.4 h session-blocked in its 7.15-day window",
			"drives the issue past 2 days since its first launch",
			"two suites have run 2 h beside it",
			"the ledger holds it for the full hour after the triage launch",
		])
			expect(fault(body)).toEqual([]);
	});
});

describe("basisFaults — the warrant a basis carries (#4946)", () => {
	const week = "**Gated until:** 2099-01-01 — a week after it lands";
	const warrantFaults = (basis: string, own?: number) =>
		basisFaults(`${week}\n**Gate basis:** a week. ${basis}`, own)
			.filter((f: { kind: string }) => f.kind === "no-warrant")
			.map((f: { text: string }) => f.text.replace(/^a week\. /, ""));

	// The bases as their issues wrote them.
	const stands = {
		"#4865 now":
			"before #4807, 27 of 449 lander attempts (6.0%, 5–10 Nov, #4855) were STALE-PROSE refusals. With 0 such refusals in 150 attempts, the 95% upper bound on the remaining rate is 3/150 = 2% (rule of three), a third of the baseline.",
		"#3432":
			'15 commits is #1556 Q4 (A)\'s "about 15", made exact by spec #1612 §The re-measure trigger (`THRESHOLD` in `scripts/report-remeasure-due.js`); no date fits, since no mantahostels card carries one for its RLS, money or reward-code code (#3431).',
		"#2827":
			"#2821 (the verifying figure) ruled each step gets its own 7-day reading, from the UTC day after it lands, on days of at least 48 active session-hours; fewer days or thinner days fall under that ruling's floor.",
		"#4781":
			"the 20 runs and the 0 to 20 load spread are this ticket's own data floor from #4757; `load1AtStart` first landed in 6e5453ba4 on 9 Nov, at about 6 whole or half-suite runs a day, so nothing sooner than several days of runs can meet it.",
		"#4862":
			"#4791's own gate: a day of the reclaimer's log ends 2026-11-11 08:26 +08 (00:26 UTC); nothing sooner keeps the two trials apart",
		"#4893":
			"the 10 Nov 2026 baseline on #4884 was read over a 24 h window to 06:42 UTC, so the comparison needs the same 24 h shape, all of it on 7.0; nothing shorter matches the baseline.",
	};
	const falls = {
		"#4865 first":
			"#4807 (the stale-registry-row fix) landed on `main` at fc92c9f15 on 2026-11-10 05:13 UTC; the body sets a one-week measurement window, and nothing sooner covers a full week of lander runs.",
		"#4530":
			"the carry reached `main` at 2026-11-06T02:38:12Z (queue log `land` event for `queue/implement-4514-152aad` at `4d74950a9`), and the ticket's window is the 7 days after that; no shorter window answers its question.",
		"#2649 gate":
			"the acceptance's one-week window, opened by #2741's landing because rotation deleted trimmed blocks before it; nothing sooner holds a week of blocks.",
		"#3803":
			"the no-wait try began 27 Oct 16:06 UTC (#3278), so a week of tries ends 3 Nov 16:06 UTC; the first full day after that is 4 Nov, and nothing sooner holds a week.",
		"#3806":
			"the fourth acceptance criterion sets the 24 h; the markers and exit lines show the change live from its commit on this checkout, so nothing sooner gives the window it names.",
		"#4850 first":
			"a week of minutes covers every weekday load pattern on Windows. The 24 h sample above has only 91 heavy-paging minutes, too few to set a line.",
		"#4852 first, as #4929 quotes it":
			"a week takes in weekday and weekend load, and nothing shorter separates a workday spike from the baseline.",
	};

	it.each(Object.entries(stands))("passes %s's basis", (_issue, basis) => {
		expect(warrantFaults(basis)).toEqual([]);
	});

	it.each(Object.entries(falls))("refuses %s's basis", (_issue, basis) => {
		expect(warrantFaults(basis)).toEqual([basis]);
	});

	it("passes a count derivation: a baseline, a bound, the count that results and a source", () => {
		const derived =
			"baseline 27/449 attempts (6.0%, `jq -s length .queue-log.jsonl`); pass = 0 refusals in 69 attempts";
		expect(warrantFaults(derived)).toEqual([]);
		for (const short of [
			// no source
			"baseline 27/449 attempts (6.0%); pass = 0 refusals in 69 attempts",
			// no bound
			"baseline 27/449 attempts (`jq`); pass = 0 refusals in 69 attempts",
			// no count but the baseline's own
			"baseline 27/449 attempts (6.0%, `jq`), so 449 attempts again",
			// the window, a date, a year and a clock time are no count
			"7 days; baseline 27/449 (6.0%), `jq`",
			"baseline 27/449 attempts (6.0%, `jq`) measured on 10 Nov",
			"baseline 27/449 attempts (6.0%, `jq`), read in Nov 2026 at 16:06 UTC",
			// nor is zero
			"baseline 27/449 attempts (6.0%, `jq`); pass = 0 refusals",
			// a web address is no source
			"baseline 27/449 attempts (6.0%), 69 attempts, see https://example.com/log.txt",
		])
			expect(warrantFaults(short)).toEqual([short]);
	});

	it("passes a named cycle with a measured figure and a source", () => {
		expect(
			warrantFaults(
				"the weekly export: 4 of 28 days carry it (`scripts/export-log.js`)",
			),
		).toEqual([]);
		expect(
			warrantFaults(
				"one daily work cycle, at about 490 blocks a day (d8731ae6b)",
			),
		).toEqual([]);
		const bare = "one daily work cycle (d8731ae6b)";
		expect(warrantFaults(bare)).toEqual([bare]);
	});

	it("takes the body's own number as no warrant and no source", () => {
		const own =
			"#4253 asks for 24 h of live work after cutover; #4248 (the cutover) closed 2026-11-05T02:04:59Z, so the reading cannot be taken before 2026-11-06T02:05Z.";
		expect(warrantFaults(own)).toEqual([]);
		expect(warrantFaults(own, 4253)).toEqual([own]);
		expect(
			warrantFaults("lucmoseley/mantahostels#4253 ruled it", 4253),
		).toEqual([]);
		const selfSourced = "baseline 27/449 (6.0%, #77); pass = 0 in 69 attempts";
		expect(warrantFaults(selfSourced, 77)).toEqual([selfSourced]);
	});

	it("takes an issue named only as the event the window starts from as no warrant", () => {
		for (const anchored of [
			"#12 landed on 5 Nov, and the body asks for a week",
			"the week after #12",
			"it went live on 5 Nov (#12)",
		])
			expect(warrantFaults(anchored)).toEqual([anchored]);
		expect(warrantFaults("#12 ruled 7 days after the change lands")).toEqual(
			[],
		);
	});

	it("owes no warrant on an event-only gate", () => {
		expect(
			basisFaults(
				"**Gated on:** it lands — check: `true` — abandon if: it is dropped\n**Gate basis:** the landing sets it",
			),
		).toEqual([]);
	});

	it("holds an untouched legacy basis through an edit, and judges a rewritten one", () => {
		const legacy = `${week}\n**Gate basis:** the body sets a week`;
		expect(introducedBasisFaults(legacy, `${legacy}\nnote`)).toEqual([]);
		expect(
			introducedBasisFaults(
				legacy,
				legacy.replace(
					"the body sets a week",
					"a week is what the ticket asks",
				),
			),
		).toEqual([{ kind: "no-warrant", text: "a week is what the ticket asks" }]);
		expect(
			introducedBasisFaults(
				legacy,
				legacy.replace("the body sets a week", "#12 ruled a week"),
			),
		).toEqual([]);
	});

	it("judges a legacy basis beneath a gate line the edit moved or added", () => {
		const legacy =
			"**Gated until:** 2099-01-01 — a week after it lands\n**Gate basis:** the body sets a week";
		const fault = [{ kind: "no-warrant", text: "the body sets a week" }];
		expect(
			introducedBasisFaults(legacy, legacy.replace("2099-01-01", "2099-02-01")),
		).toEqual(fault);
		const prose =
			"Read it a week after it lands.\n**Gate basis:** the body sets a week";
		expect(
			introducedBasisFaults(prose, `**Gated until:** 2099-01-01 — x\n${prose}`),
		).toEqual(fault);
	});

	it("judges a basis whose text is a window the old body wrote", () => {
		const bare =
			"**Gated until:** 2099-01-01 — a week after it lands\n**Gate basis:** a week";
		const fault = [{ kind: "no-warrant", text: "a week" }];
		expect(
			introducedBasisFaults(bare, bare.replace("2099-01-01", "2099-02-01")),
		).toEqual(fault);
		const wait =
			"Read it a week after it lands.\n**Gate basis:** #12 ruled a week";
		expect(
			introducedBasisFaults(wait, wait.replace("#12 ruled a week", "a week")),
		).toEqual(fault);
	});

	it("refuses naming the basis and the template", () => {
		const refusal = basisRefusal(
			basisFaults(`${week}\n**Gate basis:** the body sets a week`),
		);
		expect(refusal).toContain(
			'the basis "the body sets a week", which carries no warrant. Every gate line',
		);
		expect(refusal).toContain(
			`§Gating an issue. ${readRuleText("gate-basis-line")}`,
		);
		expect(refusal.split("The line's template:")).toHaveLength(2);
	});
});

describe("gateRuleHandover — the gating rule at the moment of use (#823)", () => {
	const gateBlock = "**Gated until:** 2026-10-09 — x\n**Gate basis:** y";
	const rule = () => "RULE TEXT";

	it("hands over the rule where a write adds or changes a gate line", () => {
		expect(gateRuleHandover("", gateBlock, rule)).toContain("RULE TEXT");
		expect(
			gateRuleHandover(gateBlock, gateBlock.replace("10-09", "10-11"), rule),
		).toContain("RULE TEXT");
	});

	it("points at the document where the rule cannot be read", () => {
		const unreadable = () => {
			throw new Error("no fragment");
		};
		expect(gateRuleHandover("", gateBlock, unreadable)).toContain(
			"§Gating an issue before relying on this gate",
		);
	});

	it("hands over nothing where the write adds no gate line", () => {
		expect(gateRuleHandover("", "a plain body", rule)).toBeNull();
		expect(gateRuleHandover(gateBlock, `${gateBlock}\nnote`, rule)).toBeNull();
		expect(
			gateRuleHandover("", "```\n**Gated until:** 2026-10-09\n```", rule),
		).toBeNull();
	});
});

describe("isNewlyGated — a gate that is progress (#3301)", () => {
	const gateBlock = "**Gated until:** 2026-10-09 — x\n**Gate basis:** y";

	it("holds where the write gives an ungated body its first gate line", () => {
		expect(isNewlyGated("a plain body", gateBlock)).toBe(true);
		expect(isNewlyGated("", "**Gated on:** #12 closes")).toBe(true);
	});

	it("holds nowhere else: a reworded, removed or fenced line", () => {
		expect(isNewlyGated(gateBlock, gateBlock.replace("10-09", "10-11"))).toBe(
			false,
		);
		expect(isNewlyGated(gateBlock, "a plain body")).toBe(false);
		expect(isNewlyGated("", "```\n**Gated until:** 2026-10-09\n```")).toBe(
			false,
		);
	});
});

describe("secondMapVerdict — no second map while the first is unfilled (#717)", () => {
	const mapLabels = ["wayfinder:map", "takes:wayfinder"];
	const map = (number: number, destination: string) => ({
		number,
		labels: [{ name: "wayfinder:map" }],
		body: `## Destination\n\n${destination}\n\n## Notes\n\nthe idea\n`,
	});

	it("refuses a map while an open map still reads the placeholder, naming it", () => {
		const v = secondMapVerdict(mapLabels, () => [
			map(9, "Ship the booking flow."),
			map(3, UNFILLED_DESTINATION),
		]);
		expect(v.refusal).toContain("#3 is an open wayfinder map");
		expect(v.refusal).toContain("Fill #3 instead");
		expect(v.refusal).not.toContain("#9");
	});

	it("names every unfilled map, lowest first", () => {
		const v = secondMapVerdict(mapLabels, () => [
			map(12, UNFILLED_DESTINATION),
			map(4, UNFILLED_DESTINATION),
		]);
		expect(v.refusal).toContain("#4, #12 are open wayfinder maps");
		expect(v.refusal).toContain("Fill #4 instead");
	});

	it("passes once every open map's Destination is filled, or there is none", () => {
		expect(
			secondMapVerdict(mapLabels, () => [map(3, "Ship the booking flow.")]),
		).toBeNull();
		expect(secondMapVerdict(mapLabels, () => [])).toBeNull();
	});

	it("never reads the maps for a create that is not a map", () => {
		let calls = 0;
		const read = () => {
			calls++;
			return [map(3, UNFILLED_DESTINATION)];
		};
		expect(secondMapVerdict(["takes:implement"], read)).toBeNull();
		expect(calls).toBe(0);
		secondMapVerdict(mapLabels, read);
		expect(calls).toBe(1);
	});

	it("returns an unreadable answer rather than a verdict", () => {
		expect(
			secondMapVerdict(mapLabels, () => {
				throw new Error("HTTP 502");
			}),
		).toEqual({ unreadable: expect.stringContaining("HTTP 502") });
		expect(secondMapVerdict(mapLabels, () => ({ message: "x" }))).toEqual({
			unreadable: expect.stringContaining("not a JSON array"),
		});
	});
});

describe("reading an open map's Destination", () => {
	/** Whether an open map with this body reads as still unfilled. */
	const unfilled = (body: string) =>
		secondMapVerdict(["wayfinder:map"], () => [{ number: 3, body }]) !== null;

	it("reads the section to the next heading, trimmed, and tolerates CRLF", () => {
		expect(
			unfilled(
				`## Destination\r\n\r\n  ${UNFILLED_DESTINATION}  \r\n## Notes\r\ny`,
			),
		).toBe(true);
		// A ### heading sits inside the section, so it is part of the text.
		expect(
			unfilled(`## Destination\n\n${UNFILLED_DESTINATION}\n### still x\n`),
		).toBe(false);
	});

	it("reads nothing where the body has no Destination heading", () => {
		expect(unfilled(`## Notes\n\n${UNFILLED_DESTINATION}`)).toBe(false);
	});
});
