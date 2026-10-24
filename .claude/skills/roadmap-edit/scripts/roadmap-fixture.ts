/*
 * Test fixture builder for the roadmap-edit scripts.
 *
 * Both scripts parse reference-roadmap.html by slicing out the `const ITEMS`,
 * `const AREAS` and `const PHASES` literals and the docmeta version line, then
 * evaluating only those slices. A fixture therefore has to reproduce that exact
 * shape — the `\n];` array terminator especially, which is what the slicer looks
 * for — but nothing else about the page.
 *
 * Tests use these hermetic fixtures for behaviour, and the real
 * docs/reference-roadmap.html for a single smoke case each, so a change to the
 * live file's structure still trips something.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPTS_DIR, "../../../..");

export interface Card {
	id: string;
	p: number;
	a: string[];
	kind: string;
	state: string;
	t: string;
	b?: string;
	m?: string | [string, string][];
	mn?: string;
	needs?: string[];
	log?: string;
	c?: { type: string; k: string; x: string };
	why?: string;
	dw?: string;
	capOk?: Record<string, number>;
}

/** `dw` defaults to a short placeholder so existing fixtures satisfy the
 *  non-done-cards-need-dw ERROR without every caller setting one; a test of
 *  that check itself overrides with `dw: undefined`. */
export function card(over: Partial<Card> & { id: string }): Card {
	return {
		p: 0,
		a: ["ops"],
		kind: "action",
		state: "open",
		t: `card ${over.id}`,
		dw: "it is done.",
		...over,
	};
}

/** A structurally valid roadmap page containing exactly `cards`. */
/** `stamp` defaults to a fixed date for determinism; validate.js checks it
 *  against the wall clock, so its tests pass one explicitly (see `witaStamp`). */
export function roadmapHtml(
	cards: Card[],
	version = "v5.0",
	stamp = "1 July 2026, 10:00",
): string {
	const items = cards.map((c) => `  ${JSON.stringify(c)},`).join("\n");
	return [
		"<!doctype html><html><body>",
		`<p class="docmeta">${version} · updated ${stamp}</p>`,
		"<script>",
		'const AREAS = { ops:"Ops", eng:"Engineering" };',
		"const PHASES = [",
		'  {n:0, title:"Phase zero"},',
		'  {n:1, title:"Phase one"}',
		"];",
		"const ITEMS = [",
		items,
		"];",
		"</script></body></html>",
	].join("\n");
}

export interface Run {
	status: number;
	stdout: string;
	stderr: string;
}

/**
 * Run one of the scripts under node. A non-zero exit is the behaviour under test
 * in most of these cases, so this never throws on it — assert on `status`.
 */
export function run(script: string, args: string[]): Run {
	const r = spawnSync("node", [path.join(SCRIPTS_DIR, script), ...args], {
		encoding: "utf8",
		cwd: REPO_ROOT,
	});
	if (r.error) throw r.error;
	return {
		status: r.status ?? -1,
		stdout: r.stdout ?? "",
		stderr: r.stderr ?? "",
	};
}

/** A `witaStamp` offset over 24 hours back, so always an earlier WITA day. */
export const EARLIER_DAY_MIN = -26 * 60;
/** A `witaStamp` offset past validate.js's 10-minute allowance for a stamp
 *  ahead of the clock. */
export const AHEAD_MIN = 3 * 60;

/** A docmeta stamp `offsetMin` minutes from now (negative = past), in WITA and
 *  the en-GB form validate.js expects. Off the clock, so it can't age out. */
export function witaStamp(offsetMin = 0): string {
	const t = new Date(Date.now() + offsetMin * 60_000 + 8 * 60 * 60_000);
	const months = [
		"January",
		"February",
		"March",
		"April",
		"May",
		"June",
		"July",
		"August",
		"September",
		"October",
		"November",
		"December",
	];
	const p = (n: number) => String(n).padStart(2, "0");
	return (
		`${t.getUTCDate()} ${months[t.getUTCMonth()]} ${t.getUTCFullYear()}, ` +
		`${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`
	);
}
