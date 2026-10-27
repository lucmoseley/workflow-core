/*
 * Rival rounds and the transcripts that carry them, shared by the tests of
 * scripts/check-band-drift.js and of its entry in check-cleared-trackers.js,
 * so the two build one corpus shape (#487).
 */

import fs from "node:fs";
import path from "node:path";
import { LOW_TOP } from "./close-rivals";

type Band = [number, number, number];

/** One round with two rivals, each `[figure, low, high]`. */
export const round = (a: Band, b: Band, relation = "rivals for one slot") =>
	[
		"Some preamble.",
		"",
		"❓ **Q1** Which one?",
		"",
		"(A) the first",
		`Confidence: ${a[0]}% (${a[1]}% - ${a[2]}%). drives it`,
		"",
		"(B) the second",
		`Confidence: ${b[0]}% (${b[1]}% - ${b[2]}%). drives it`,
		"",
		`Relation: ${relation}.`,
	].join("\n");

/* A 28-point gap, in the 26-30 band, in four shapes. */
export const WIDE_OVERLAP = round([64, 50, 78], [36, 22, 50]);
export const WIDE_CLEAR = round([64, 57, 71], [36, 29, 43]);
/* Top option ±3; the runner-up's wide band still overlaps it. */
export const NARROW_OVERLAP = round([64, 61, 67], [36, 11, 61]);
export const NARROW_CLEAR = round([64, 61, 67], [36, 33, 39]);

export const times = (n: number, text: string) =>
	Array.from({ length: n }, () => text);

/*
 * Rounds topped at the first figure the low-top test passes, and two steps
 * over it, each with a 40-point or wider gap so that none lands in the 26-30
 * band. `relation` sets the shape of the rounds at the line.
 */
const AT_LINE = LOW_TOP + 5;
const buildAtLine = (relation?: string) =>
	round([AT_LINE, AT_LINE - 5, AT_LINE + 5], [25, 20, 30], relation);
const buildOverLine = () =>
	round([AT_LINE + 10, AT_LINE + 5, AT_LINE + 15], [20, 15, 25]);

/** `n` priced tops, `at` of them at the line in `relation`'s shape. */
export const topQuestions = (n: number, at: number, relation?: string) => [
	...times(at, buildAtLine(relation)),
	...times(n - at, buildOverLine()),
];

/** `n` band questions, `overlapping` of them with overlapping bands. */
export const bandQuestions = (n: number, overlapping: number) => [
	...times(overlapping, WIDE_OVERLAP),
	...times(n - overlapping, WIDE_CLEAR),
];

let seq = 0;

/** A top-level transcript under `dir` holding one assistant record per text. */
export function writeTranscript(
	dir: string,
	texts: string[],
	opts: { ageDays?: number; sidechain?: boolean } = {},
) {
	const at = new Date(
		Date.now() - (opts.ageDays ?? 0) * 86_400_000,
	).toISOString();
	const lines = texts.map((text) =>
		JSON.stringify({
			type: "assistant",
			uuid: `u-${++seq}`,
			timestamp: at,
			...(opts.sidechain ? { isSidechain: true } : {}),
			message: { role: "assistant", content: [{ type: "text", text }] },
		}),
	);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `sess-${++seq}.jsonl`);
	fs.writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
}
