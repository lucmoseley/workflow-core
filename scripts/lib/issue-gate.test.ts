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
 * condition marker), #672 and #823 (the basis line), #717 (the second map);
 * the clock fix came from a code review, with no ticket of its own.
 */

import { describe, expect, it } from "vitest";

const {
	gateOf,
	gateOnOf,
	resolveGate,
	basisFaults,
	introducedBasisFaults,
	basisRefusal,
	gateRuleHandover,
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

describe("basisFaults — a wait with nothing behind it (#672)", () => {
	it("names a gate line and each prose wait where no basis is written", () => {
		expect(
			basisFaults(
				"**Gated on:** census lands — abandon if: never\nre-run it after a week live",
			),
		).toEqual([
			"**Gated on:** census lands — abandon if: never",
			"after a week",
		]);
		expect(basisFaults("Re-measure about two weeks after the reword")).toEqual([
			"two weeks after",
		]);
		expect(
			basisFaults("run it a day after the fix, or four weeks later"),
		).toEqual(["a day after", "four weeks later"]);
	});

	it("is empty once a basis is written anywhere in the body", () => {
		expect(
			basisFaults(
				"**Gated until:** 2026-09-29 — a day\n**Gate basis:** counters live 24 hours",
			),
		).toEqual([]);
	});

	it("ignores measurement windows, fenced blocks and inline code", () => {
		for (const body of [
			"80 asks in 30 days",
			"```\n**Gated until:** 2026-10-05\nafter a week\n```",
			"the phrase `after a week` is an example",
		])
			expect(basisFaults(body)).toEqual([]);
	});

	it("counts only what an edit adds, a moved date included", () => {
		const old = "**Gated until:** 2026-10-05 — x\nafter a week live";
		expect(introducedBasisFaults(old, `${old}\nnote`)).toEqual([]);
		expect(introducedBasisFaults(old, old.replace("10-05", "10-12"))).toEqual([
			"**Gated until:** 2026-10-12 — x",
		]);
	});
});

describe("basisFaults — each window its basis names (#823)", () => {
	const gate816 =
		"**Gated on:** the repo is created — abandon if: 7 days pass after the repo is created";

	it("names the window, not a missing basis, where the first basis is empty", () => {
		const body = `${gate816}\n**Gate basis:**\n**Gate basis:** 3 days`;
		expect(basisRefusal(basisFaults(body), body)).toContain(
			"a window the `**Gate basis:**` line does not name",
		);
	});

	it("refuses a gate whose abandon clause carries a window the basis omits", () => {
		const body = `${gate816}, or 3 days pass with no reply\n**Gate basis:** the vendor answers in 3 days`;
		const faults = basisFaults(body);
		expect(faults).toEqual(["7 days"]);
		const refusal = basisRefusal(faults, body);
		expect(refusal).toContain('"7 days", a window the `**Gate basis:**` line');
		expect(refusal).toContain("never that it holds up");
	});

	it("passes a basis naming every window, by length rather than spelling", () => {
		expect(
			basisFaults(
				`${gate816}\n**Gate basis:** a week: the 3-day reply window, doubled and rounded up`,
			),
		).toEqual([]);
		expect(
			basisFaults(
				"wait two weeks after launch\n**Gate basis:** traffic stabilises within 14 days",
			),
		).toEqual([]);
	});

	it("checks prose waits and every gate line, but not a window in inline code", () => {
		expect(
			basisFaults(
				"**Gated until:** 2026-10-09 — 5 days after the fix\nre-run it four weeks later\n**Gate basis:** the fix soaks 5 days",
			),
		).toEqual(["four weeks"]);
		expect(
			basisFaults(
				"**Gated on:** x — check: `grep '2 days'` — abandon if: never\n**Gate basis:** none needed",
			),
		).toEqual([]);
	});

	it("reads no window in a frequency or a check: command", () => {
		expect(
			basisFaults(
				"**Gated on:** the cron has run once a day — check: gh run list --created 2 days — abandon if: never\n**Gate basis:** n/a",
			),
		).toEqual([]);
	});

	it("catches a word between the window and 'after' as a prose wait", () => {
		expect(basisFaults("abandon it once 7 days pass after creation")).toEqual([
			"7 days pass after",
		]);
		for (const body of [
			"within 30 days and after launch",
			"We spent two weeks right after launch",
		])
			expect(basisFaults(body)).toEqual([]);
	});

	it("refuses only the window an edit adds, naming it, so an old body stays editable", () => {
		const old = `${gate816}\n**Gate basis:** the vendor answers in 3 days`;
		expect(introducedBasisFaults(old, `${old}\nnote`)).toEqual([]);
		expect(
			introducedBasisFaults(old, `${old}\nre-check it 2 months later`),
		).toEqual(["2 months"]);
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
