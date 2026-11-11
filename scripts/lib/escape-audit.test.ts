// @vitest-environment node
/*
 * Which questions got past the close-rivals check — close ones on an escape
 * line, and every re-send of a refused one (#671 step 3, #4945) — read from
 * fixture transcripts.
 *
 * The fixtures are hand-built transcript lines in a temp dir, read through
 * lib/close-rivals.js's `rivalPair` and lib/round-marker.js's
 * `splitQuestions`, so the audit judges a round exactly as the guard does.
 *
 * audit-escape-lines.js reports this share at session start, and the #671
 * loosening is kept or reversed on it; a loosened case miscounts what got past
 * and tilts that call.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rivalPair } from "./close-rivals.js";
import audit from "./escape-audit.js";
import { splitQuestions } from "./round-marker.js";
import { buildBashCall } from "./transcript-testkit";

const deps = { rivalPair, splitQuestions };

const IN_660 = "2026-09-28T09:00:00Z";
const PRE = "2026-09-27T12:00:00Z";

const round = (line = "Checked: read the config; B ships it") =>
	"❓ **Q1** — Which?\n\nRelation: rivals for one slot\n\n" +
	"(A) option A\nConfidence: 55% (45% - 65%). why\n\n" +
	"(B) option B\nConfidence: 45% (35% - 55%). why\n\n" +
	`${line}\n\n➡ (A).`;

const assistant = (text: string, at = IN_660) =>
	JSON.stringify({
		type: "assistant",
		timestamp: at,
		message: { role: "assistant", content: [{ type: "text", text }] },
	});
const toolUse = (at = IN_660) =>
	JSON.stringify(buildBashCall("ls", "t", { timestamp: at }));
const toolResult = () =>
	JSON.stringify({
		type: "user",
		timestamp: IN_660,
		message: {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }],
		},
	});
const founder = () =>
	JSON.stringify({
		type: "user",
		timestamp: IN_660,
		message: { role: "user", content: "go" },
	});
const feedback = (text: string) =>
	JSON.stringify({
		type: "user",
		isMeta: true,
		timestamp: IN_660,
		message: { role: "user", content: `Stop hook feedback:\n${text}` },
	});
const delivery = () =>
	JSON.stringify({
		type: "user",
		isMeta: true,
		origin: { kind: "plugin", name: "wfc-delivery" },
		timestamp: IN_660,
		message: {
			role: "user",
			content: [{ type: "text", text: "Delivered by the wfc-delivery mod" }],
		},
	});
const CLOSE_REFUSAL = feedback(
	"…whose top two rivals sit close…\n\nQ1: (A) 55% against (B) 45% — so the recommendation could flip.",
);
const NOT_CLOSE = (line = "") =>
	round(line)
		.replace("55% (45% - 65%)", "80% (75% - 85%)")
		.replace("45% (35% - 55%)", "20% (15% - 25%)");

const items = (...lines: string[]) =>
	audit.itemsIn(lines.join("\n"), "s1", deps);

describe("what got past", () => {
	it("takes a close question with an escape line that ended its turn", () => {
		const [item] = items(founder(), assistant(round()), founder());
		expect(item).toMatchObject({
			session: "s1",
			window: "660",
			sight: "first",
			escape: "checked",
		});
		expect(item.text).toContain("Checked: read the config");
	});

	it("takes the last message of a transcript", () => {
		expect(items(founder(), assistant(round()))).toHaveLength(1);
	});

	it("takes a refused question's re-send, close or not and with no escape line, beside its refused block and the calls between (#4945)", () => {
		const [item, ...rest] = items(
			founder(),
			assistant(round()),
			CLOSE_REFUSAL,
			toolUse(),
			toolResult(),
			assistant(NOT_CLOSE()),
			founder(),
		);
		expect(rest).toEqual([]);
		expect(item).toMatchObject({ sight: "after-refusal", escape: "none" });
		expect(item.refusedText).toContain("55% (45% - 65%)");
		expect(item.text).toContain("80% (75% - 85%)");
		expect(item.calls).toBe("→ Bash: ls\n← ok");
	});

	it("takes a low-top question's re-send (#4945)", () => {
		const lowTop = round("")
			.replace("55% (45% - 65%)", "60% (55% - 65%)")
			.replace("45% (35% - 55%)", "20% (15% - 25%)");
		const got = items(
			founder(),
			assistant(lowTop),
			feedback(
				"…whose top two rivals sit close…\n\nQ1: top option (A) 60% — no option is priced above 65, so none is likely right.",
			),
			assistant(lowTop.replace("60% (55% - 65%)", "70% (65% - 75%)")),
		);
		expect(got.map((i) => i.sight)).toEqual(["after-refusal"]);
	});

	it("pairs a re-send refused again with the block as first refused", () => {
		const [item] = items(
			founder(),
			assistant(round()),
			CLOSE_REFUSAL,
			assistant(NOT_CLOSE()),
			feedback(
				"…whose top two rivals sit close…\n\nQ1: re-priced from (A) 55% to (A) 80% with no tool call since this check refused it.",
			),
			toolUse(),
			toolResult(),
			assistant(NOT_CLOSE("Checked: ran ls; A")),
		);
		expect(item.refusedText).toContain("55% (45% - 65%)");
		expect(item.calls).toMatch(
			/^said: [\s\S]*80% \(75% - 85%\)[\s\S]*\n→ Bash: ls\n← ok$/,
		);
	});

	it("gives a re-send its whole message and the session's text between calls (#5003)", () => {
		const said = `I ran the count.\n\n${NOT_CLOSE("Checked: ls showed it; A")}`;
		const [item] = items(
			founder(),
			assistant(round()),
			CLOSE_REFUSAL,
			assistant("Checking the log first."),
			toolUse(),
			toolResult(),
			assistant(said),
		);
		expect(item.message).toBe(said);
		expect(item.text).not.toContain("I ran the count.");
		expect(item.calls).toBe("said: Checking the log first.\n→ Bash: ls\n← ok");
	});

	it("gives `(no tool call)` as the calls where none came between", () => {
		const [item] = items(
			founder(),
			assistant(round()),
			CLOSE_REFUSAL,
			assistant(NOT_CLOSE()),
		);
		expect(item.calls).toBe("(no tool call)");
	});

	it("takes on first sight a question the turn's refusal did not name", () => {
		const two = `${round()}\n\n${round().replace("Q1", "Q2")}`;
		const got = items(founder(), assistant(two), CLOSE_REFUSAL, assistant(two));
		expect(got.map((i) => i.sight)).toEqual(["after-refusal", "first"]);
	});

	it("keeps a refusal past a mod's delivery, which is not the founder speaking (#4945)", () => {
		const got = items(
			founder(),
			assistant(round()),
			CLOSE_REFUSAL,
			delivery(),
			toolUse(),
			toolResult(),
			assistant(NOT_CLOSE()),
		);
		expect(got.map((i) => [i.sight, i.calls])).toEqual([
			["after-refusal", "→ Bash: ls\n← ok"],
		]);
	});

	it("retires a refusal once its re-send passes", () => {
		const got = items(
			founder(),
			assistant(round()),
			CLOSE_REFUSAL,
			assistant(NOT_CLOSE()),
			delivery(),
			assistant(round()),
		);
		expect(got.map((i) => i.sight)).toEqual(["after-refusal", "first"]);
	});

	it("reads only the close-rivals refusal's own flagged lines, not another limb's (#4945)", () => {
		const two = `${round()}\n\n${NOT_CLOSE().replace("Q1", "Q2")}`;
		const got = items(
			founder(),
			assistant(two),
			feedback(
				"This turn puts a choice to the founder whose top two rivals sit close, or…:\n\n" +
					"Q1: (A) 55% against (B) 45% — so the recommendation could flip.\n\n" +
					"Two tests make a pair close.\n\n" +
					"Q2: 6 tool calls since the founder last spoke, under the 10",
			),
			assistant(two),
		);
		expect(got.map((i) => [i.round, i.sight])).toEqual([
			["1", "after-refusal"],
		]);
	});

	it("drops a send a Stop hook refused, and marks the resend after-refusal", () => {
		const got = items(
			founder(),
			assistant(round()),
			CLOSE_REFUSAL,
			toolUse(),
			toolResult(),
			assistant(
				round("Unmeasured: the founder's taste, because nothing measures it"),
			),
			founder(),
		);
		expect(got.map((i) => [i.sight, i.escape])).toEqual([
			["after-refusal", "unmeasured"],
		]);
	});

	it("finds #1061's refuse-once text as the close-rivals refusal", () => {
		const got = items(
			founder(),
			assistant(round()),
			feedback(
				"This turn puts a choice to the founder whose top two rivals sit close, " +
					"or re-prices one this check refused:\n\n" +
					"Q1: (A) 55% (45% - 65%) against (B) 45% (35% - 55%) — their bands " +
					"overlap and their figures sit 10 points apart, so the recommendation " +
					"could flip. What fact would make (B) beat (A)? Go and look for it.\n\n" +
					"Every close question is sent back once, whatever its `Checked:` or " +
					"`Unmeasured:` line, so the line does not clear it: the corrected " +
					"question passes on its next send (#1061).",
			),
			assistant(round("Checked: ran it; A wins")),
		);
		expect(got.map((i) => i.sight)).toEqual(["after-refusal"]);
	});

	it("marks first sight where the turn's refusal was another limb's", () => {
		const got = items(
			founder(),
			assistant(round()),
			feedback("bold or titled name"),
			assistant(round("Checked: ran it; A wins")),
		);
		expect(got.map((i) => i.sight)).toEqual(["first"]);
	});

	it("resets the refusal at the next turn", () => {
		const got = items(
			founder(),
			assistant(round()),
			CLOSE_REFUSAL,
			assistant(round("Checked: ran it; A wins")),
			founder(),
			assistant(round("Checked: ran another; B wins")),
		);
		expect(got.map((i) => i.sight)).toEqual(["after-refusal", "first"]);
	});

	it("drops text followed by a tool call, the Stop guard never having read it", () => {
		expect(items(founder(), assistant(round()), toolUse(), founder())).toEqual(
			[],
		);
	});

	it.each([
		["no escape line", round("")],
		["an empty escape line", round("**Checked:**")],
		[
			"a pair not close",
			round()
				.replace("55% (45% - 65%)", "80% (75% - 85%)")
				.replace("45% (35% - 55%)", "20% (15% - 25%)"),
		],
	])("ignores %s", (_name, text) => {
		expect(items(founder(), assistant(text), founder())).toEqual([]);
	});

	it("ignores rounds before #488's escape lines shipped", () => {
		expect(
			items(founder(), assistant(round(), "2026-09-27T09:00:00Z")),
		).toEqual([]);
	});
});

describe("the windows", () => {
	it.each([
		[PRE, "pre-660"],
		[IN_660, "660"],
		["2026-09-28T11:16:00Z", "671"],
		["2026-10-10T02:00:00Z", "1061"],
	])("files %s under %s", (at, window) => {
		expect(items(assistant(round(), at))[0].window).toBe(window);
	});

	it("keys an item stably by session and block", () => {
		const a = items(assistant(round()))[0].key;
		expect(items(assistant(round()))[0].key).toBe(a);
		expect(audit.itemsIn(assistant(round()), "s2", deps)[0].key).not.toBe(a);
	});
});

describe("the stores", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "escape-audit-"));
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it("writes the items index without any question text or calls", () => {
		audit.writeItems(dir, [
			...items(assistant(round())),
			...items(
				assistant(round()),
				CLOSE_REFUSAL,
				toolUse(),
				toolResult(),
				assistant(NOT_CLOSE()),
			),
		]);
		const written = fs
			.readdirSync(dir, { recursive: true, withFileTypes: true })
			.filter((e) => e.isFile())
			.map((e) => fs.readFileSync(path.join(e.parentPath, e.name), "utf8"));
		expect(written).toHaveLength(1);
		expect(written[0]).not.toMatch(/Checked:|Confidence|→ Bash/);
		expect(audit.readItems(dir)?.items[0].window).toBe("660");
	});

	it("reads no index before a batch has run", () => {
		expect(audit.readItems(dir)).toBeNull();
	});

	it("keeps the last verdict per key and skips a torn line", () => {
		audit.appendVerdict(dir, { key: "k", at: IN_660, outcome: "outage" });
		audit.appendVerdict(dir, { key: "k", at: IN_660, outcome: "bears" });
		fs.appendFileSync(audit.verdictsPath(dir), '{"key":');
		expect(audit.readVerdicts(dir).get("k")?.outcome).toBe("bears");
	});
});
