// @vitest-environment node
/*
 * Pins that the turn-band instrument counts responses, and the crossing
 * response, exactly as `countTurns` does, beside its record and tool-call
 * scales (mantahostels#2618).
 *
 * A measurement that counts turns differently from the guard it calibrates
 * cannot calibrate it. The script shares the dedupe key with `countTurns` via
 * `turnRecords`, but it aggregates on top of that itself, so the agreement is
 * asserted here rather than assumed — including on the unkeyed records the
 * seam's own test cannot reach.
 *
 * Built by running the script end to end through runInProcess over a fixture
 * corpus at WFC_TRANSCRIPT_DIR and reading its printed table (#1369: nothing
 * is exported for its tests). A one-session corpus makes every percentile that
 * session's own figure, so a per-session count reads straight off the p50 row.
 *
 * The turn band in `scripts/guard-session-ceiling.js` rests on this figure:
 * let the two counts drift and the wind-up notice is re-tuned against a scale
 * it does not count on.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";
import { countTurns } from "./lib/transcript.js";

const SCRIPT = path.join(__dirname, "measure-turn-band.js");

/** One API response written as several records, all repeating one usage. */
const response = (id: string, ctx: number, records = 3) =>
	Array.from({ length: records }, (_, i) =>
		JSON.stringify({
			type: "assistant",
			requestId: id,
			uuid: `${id}-${i}`,
			message: {
				usage: { input_tokens: 2, cache_read_input_tokens: ctx - 2 },
				content: i === 0 ? [{ type: "text" }] : [{ type: "tool_use" }],
			},
		}),
	).join("\n");

const user = '{"type":"user","message":{"role":"user"}}';

/** A session of `k` one-record responses, none near the threshold. */
const sessionOf = (k: number, tag: string) =>
	[
		user,
		...Array.from({ length: k }, (_, i) => response(`${tag}${i}`, 1000, 1)),
	].join("\n");

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "measure-turn-band-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const num = (s: string) => Number(s.replace(/,/g, ""));

/** Run the script over `sessions`, one transcript file each, named in order. */
function run(sessions: Record<string, string>, args: string[] = []) {
	for (const [name, text] of Object.entries(sessions))
		fs.writeFileSync(path.join(dir, `${name}.jsonl`), text);
	const r = runInProcess(SCRIPT, args, {
		env: { ...process.env, WFC_TRANSCRIPT_DIR: dir },
	});
	const between = (from: string, to: string) => {
		const start = r.stdout.indexOf(from);
		const end = r.stdout.indexOf(to, start);
		return start < 0 ? "" : r.stdout.slice(start, end < 0 ? undefined : end);
	};
	const respSection = between("RESPONSES PER SESSION", "WHERE ");
	const crossSection = between("WHERE ", "PER RESPONSE");
	const perSection = between("PER RESPONSE", "The calibration");
	const responsesAt = (p: number) => {
		const m = respSection.match(new RegExp(`^ {2}p${p}\\s+([\\d,]+)$`, "m"));
		return m ? num(m[1]) : null;
	};
	/** The crossing at percentile `p` on the three scales, or null. */
	const crossingAt = (p: number) => {
		const m = crossSection.match(
			new RegExp(`^ {2}p${p}\\s+([\\d,]+)\\s+([\\d,]+)\\s+([\\d,]+)$`, "m"),
		);
		return m
			? {
					crossedAt: num(m[1]),
					crossedAtRecord: num(m[2]),
					crossedAtToolCall: num(m[3]),
				}
			: null;
	};
	const ratiosAt = (p: number) => {
		const m = perSection.match(
			new RegExp(
				`^ {2}p${p}\\s+([\\d.]+) assistant records\\s+([\\d.]+) tool calls$`,
				"m",
			),
		);
		return m ? { records: Number(m[1]), toolCalls: Number(m[2]) } : null;
	};
	const sessions_ = r.stdout.match(/^([\d,]+) `cli` sessions/m);
	return {
		...r,
		sessions: sessions_ ? num(sessions_[1]) : null,
		max: num(respSection.match(/^ {2}max\s+([\d,]+)$/m)?.[1] ?? "NaN"),
		responsesAt,
		crossingAt,
		ratiosAt,
		crossSection,
	};
}

describe("measure-turn-band.js (mantahostels#2618, the band's calibration)", () => {
	it("counts responses exactly as countTurns does", () => {
		const text = [user, response("a", 50_000), response("b", 60_000)].join(
			"\n",
		);
		const r = run({ s: text });
		expect(r.status).toBe(0);
		expect(r.responsesAt(50)).toBe(countTurns(text, "main"));
		expect(r.max).toBe(countTurns(text, "main"));
	});

	it("agrees with countTurns on unkeyed records too, which key-set arithmetic misses", () => {
		const bare = JSON.stringify({
			type: "assistant",
			message: { usage: { input_tokens: 1 } },
		});
		const text = [user, response("a", 50_000), bare, bare].join("\n");
		const r = run({ s: text });
		expect(r.responsesAt(50)).toBe(countTurns(text, "main"));
		expect(r.responsesAt(50)).toBe(3);
	});

	it("records the crossing as a response ordinal, not a record one", () => {
		// Three responses of three records each; the third crosses. On the record
		// scale that is the 7th line.
		const text = [
			user,
			response("a", 50_000),
			response("b", 60_000),
			response("c", 250_000),
		].join("\n");
		expect(run({ s: text }).crossingAt(50)?.crossedAt).toBe(3);
	});

	it("reports no crossing, not a zero crossing, where the threshold is never reached", () => {
		const r = run({ s: [user, response("a", 50_000)].join("\n") });
		expect(r.status).toBe(0);
		expect(r.crossSection).toContain("no session crosses it");
		expect(r.crossingAt(50)).toBeNull();
	});

	it("counts the record and tool-call scales alongside the response one", () => {
		const text = [user, response("a", 50_000), response("b", 60_000)].join(
			"\n",
		);
		const r = run({ s: text });
		// 2 responses, 6 records, 4 tool calls: 3.00 records and 2.00 tool
		// calls per response.
		expect(r.responsesAt(50)).toBe(2);
		expect(r.ratiosAt(50)).toEqual({ records: 3, toolCalls: 2 });
	});

	it("counts the crossing on each scale where it happened, never converted", () => {
		const text = [
			user,
			response("a", 50_000),
			response("b", 60_000),
			response("c", 250_000),
		].join("\n");
		// Each response here is 3 records — a text block then two tool_use blocks
		// — so the 3rd response is the 7th record, and at that record the tool
		// count still stands at the 4 the first two responses made.
		expect(run({ s: text }).crossingAt(50)).toEqual({
			crossedAt: 3,
			crossedAtRecord: 7,
			crossedAtToolCall: 4,
		});
	});

	it("excludes a session with no user turn, so an sdk-py run is not pooled", () => {
		const r = run({
			cli: [user, response("a", 50_000)].join("\n"),
			sdk: response("b", 50_000),
		});
		expect(r.sessions).toBe(1);

		fs.rmSync(path.join(dir, "cli.jsonl"));
		const none = runInProcess(SCRIPT, [], {
			env: { ...process.env, WFC_TRANSCRIPT_DIR: dir },
		});
		expect(none.status).toBe(2);
		expect(none.stderr).toContain("No `cli` session");
	});

	it("counts a session that peaks past the threshold and falls back as crossing, at its first reach", () => {
		const text = [user, response("a", 300_000), response("b", 10_000)].join(
			"\n",
		);
		expect(run({ s: text }).crossingAt(50)?.crossedAt).toBe(1);
	});
});

describe("its percentiles", () => {
	it("are nearest-rank, so p50 of ten sessions is the fifth", () => {
		const sessions = Object.fromEntries(
			Array.from({ length: 10 }, (_, i) => [
				`s${i}`,
				sessionOf(i + 1, `s${i}-`),
			]),
		);
		const r = run(sessions);
		expect(r.responsesAt(50)).toBe(5);
		expect(r.responsesAt(90)).toBe(9);
		expect(r.max).toBe(10);
	});

	/* The corpus is read in directory order, which is not response order. */
	it("sort what they are given rather than trusting the order", () => {
		const r = run({
			a: sessionOf(9, "a"),
			b: sessionOf(1, "b"),
			c: sessionOf(5, "c"),
		});
		expect(r.responsesAt(50)).toBe(5);
	});

	it("are never printed over an empty population", () => {
		const r = run({ s: sessionOf(2, "s") });
		expect(r.crossSection).toContain("no session crosses it");
		expect(r.crossingAt(50)).toBeNull();

		fs.rmSync(path.join(dir, "s.jsonl"));
		const empty = runInProcess(SCRIPT, [], {
			env: { ...process.env, WFC_TRANSCRIPT_DIR: dir },
		});
		expect(empty.status).toBe(2);
		expect(empty.stdout).not.toContain("p50");
	});
});
