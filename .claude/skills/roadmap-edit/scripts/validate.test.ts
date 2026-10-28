// @vitest-environment node
/*
 * validate.js gates every roadmap edit: it is the step that says whether an edit
 * hit the card it was aimed at. Its failure mode is silence — exiting 0 with a
 * check that never ran — so the regression cases below are mostly about *how* it
 * refuses, not what it accepts.
 *
 * Its two-layer split is mantahostels#696's; the card-shape ceilings are
 * mantahostels#2979's and mantahostels#3335's; the version pin is #54's.
 *
 * The CLI is spawned through roadmap-fixture's `run` against fake roadmaps in a
 * temp directory, so its exit code and printed report are real; the checks
 * alone are also loaded in process through `validateRoadmap`, the form
 * check-roadmap-valid.js calls.
 *
 * .husky/pre-commit refuses on it through check-roadmap-valid.js, and the
 * roadmap-edit loop has the session run it before committing, so loosening a
 * case lets a structurally broken or mis-aimed roadmap edit land on `main`.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AHEAD_MIN,
	card,
	EARLIER_DAY_MIN,
	roadmapHtml,
	run,
	witaStamp,
} from "./roadmap-fixture";

const SCRIPT = "validate.js";

/** n prose words, no markup. */
const plain = (n: number) => "word ".repeat(n).trim();

// validate.js is CommonJS and runs its CLI only under `require.main === module`,
// so requiring it here loads the checks without executing the command line.
const { validateRoadmap, EXPECTED_MAJOR } = createRequire(import.meta.url)(
	"./validate.js",
);

let dir: string;
const write = (name: string, body: string) => {
	const p = path.join(dir, name);
	fs.writeFileSync(p, body);
	return p;
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "validate-test-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("argument handling", () => {
	it("prints usage and exits 1 with no arguments at all", () => {
		const r = run(SCRIPT, []);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("no roadmap file given");
		expect(r.stderr).toContain("usage:");
	});

	it("rejects a flag in the roadmap-file slot with usage naming the flag, not an ENOENT crash", () => {
		const r = run(SCRIPT, ["--original", "/tmp/whatever.html"]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("first argument must be the roadmap file path");
		expect(r.stderr).toContain('"--original"');
		expect(r.stderr).not.toContain("ENOENT");
	});

	it("rejects --original with no path after it", () => {
		const file = write("r.html", roadmapHtml([card({ id: "a" })]));
		const r = run(SCRIPT, [file, "--original"]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("--original was given without a path");
	});

	it("documents that --original has no default", () => {
		const r = run(SCRIPT, []);
		expect(r.stderr).toContain("no default");
	});
});

describe("--original: omitted versus unreadable", () => {
	it("passes and skips the scope diff when --original is omitted", () => {
		const file = write("ok.html", roadmapHtml([card({ id: "a" })]));
		const r = run(SCRIPT, [file]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("OK —");
		expect(r.stdout).not.toContain("scope:");
	});

	it("fails hard when --original is supplied but unreadable, saying the scope diff did not run", () => {
		const file = write("ok2.html", roadmapHtml([card({ id: "a" })]));
		const r = run(SCRIPT, [file, "--original", path.join(dir, "gone.html")]);
		expect(r.status).toBe(1);
		expect(r.stdout).toContain("ERRORS");
		expect(r.stdout).toContain("scope diff therefore did not run");
		expect(r.stdout).toContain("FAIL");
	});

	it("fails when --original exists but is not a roadmap", () => {
		const file = write("ok3.html", roadmapHtml([card({ id: "a" })]));
		const junk = write("junk.html", "<html>not a roadmap</html>");
		const r = run(SCRIPT, [file, "--original", junk]);
		expect(r.status).toBe(1);
		expect(r.stdout).toContain("could not be read as a roadmap");
	});
});

describe("scope diff", () => {
	it("reports added and removed ids against the baseline", () => {
		const before = write(
			"before.html",
			roadmapHtml([card({ id: "keep" }), card({ id: "drop" })]),
		);
		const after = write(
			"after.html",
			roadmapHtml([card({ id: "keep" }), card({ id: "new" })], "v5.1"),
		);
		const r = run(SCRIPT, [after, "--original", before]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("added:   new");
		expect(r.stdout).toContain("removed: drop");
		expect(r.stdout).toContain("v5.0 → v5.1");
	});

	it("warns when the version did not move", () => {
		const before = write("b2.html", roadmapHtml([card({ id: "a" })]));
		const after = write(
			"a2.html",
			roadmapHtml([card({ id: "a" }), card({ id: "b" })]),
		);
		const r = run(SCRIPT, [after, "--original", before]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("version unchanged");
	});
});

// CARD SHAPE (mantahostels#2979) is a length proxy for a rule no script can read.
describe("card shape ceiling", () => {
	/** A body of exactly n prose words in one paragraph. */
	const words = (n: number) => `<p>${"word ".repeat(n).trim()}</p>`;

	it("warns on a body this edit grew past the ceiling, naming the card, both word counts and the rule section", () => {
		const before = write(
			"cs-before.html",
			roadmapHtml([card({ id: "a", b: words(10) })]),
		);
		const after = write(
			"cs-after.html",
			roadmapHtml([card({ id: "a", b: words(300) })], "v5.1"),
		);
		const r = run(SCRIPT, [after, "--original", before]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("CARD SHAPE");
		expect(r.stdout).toContain('"a" body grew to 300 words (was 10)');
		expect(r.stdout).toContain("§What a card holds");
	});

	it("warns on any net growth of a body already over the ceiling, naming the card and both word counts", () => {
		const before = write(
			"cs-b9.html",
			roadmapHtml([card({ id: "a", b: words(900) })]),
		);
		const after = write(
			"cs-a9.html",
			roadmapHtml([card({ id: "a", b: words(910) })], "v5.1"),
		);
		const r = run(SCRIPT, [after, "--original", before]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain('"a" body grew to 910 words (was 900)');
	});

	it("warns on a new card over the ceiling, which baselines at zero, naming the card and its word count", () => {
		const before = write("cs-b2.html", roadmapHtml([card({ id: "a" })]));
		const after = write(
			"cs-a2.html",
			roadmapHtml(
				[card({ id: "a" }), card({ id: "new", b: words(300) })],
				"v5.1",
			),
		);
		const r = run(SCRIPT, [after, "--original", before]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain('"new" body grew to 300 words (was 0)');
	});

	it("stays silent on an oversized body this edit left alone", () => {
		const big = card({ id: "a", b: words(900) });
		const before = write("cs-b3.html", roadmapHtml([big]));
		const after = write(
			"cs-a3.html",
			roadmapHtml([big, card({ id: "b" })], "v5.1"),
		);
		const r = run(SCRIPT, [after, "--original", before]);
		expect(r.status).toBe(0);
		expect(r.stdout).not.toContain("CARD SHAPE");
	});

	it("warns on an oversized body this edit shortened but left over, naming the card and both word counts", () => {
		const before = write(
			"cs-b4.html",
			roadmapHtml([card({ id: "a", b: words(900) })]),
		);
		const after = write(
			"cs-a4.html",
			roadmapHtml([card({ id: "a", b: words(400) })], "v5.1"),
		);
		const r = run(SCRIPT, [after, "--original", before]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain('"a" body is now 400 words (was 900)');
	});

	it("warns on an oversized body reworded at the same length, naming the card and both word counts", () => {
		const before = write(
			"cs-b10.html",
			roadmapHtml([card({ id: "a", b: words(900) })]),
		);
		const after = write(
			"cs-a10.html",
			roadmapHtml(
				[card({ id: "a", b: `<p>${"other ".repeat(900).trim()}</p>` })],
				"v5.1",
			),
		);
		const r = run(SCRIPT, [after, "--original", before]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain('"a" body is now 900 words (was 900)');
	});

	it("stays silent on an oversized body when only another field changed", () => {
		const before = write(
			"cs-b11.html",
			roadmapHtml([card({ id: "a", b: words(900), mn: "old" })]),
		);
		const after = write(
			"cs-a11.html",
			roadmapHtml([card({ id: "a", b: words(900), mn: "new" })], "v5.1"),
		);
		const r = run(SCRIPT, [after, "--original", before]);
		expect(r.status).toBe(0);
		expect(r.stdout).not.toContain("CARD SHAPE");
	});

	it("stays silent on an oversized body trimmed under the ceiling", () => {
		const before = write(
			"cs-b12.html",
			roadmapHtml([card({ id: "a", b: words(900) })]),
		);
		const after = write(
			"cs-a12.html",
			roadmapHtml([card({ id: "a", b: words(250) })], "v5.1"),
		);
		const r = run(SCRIPT, [after, "--original", before]);
		expect(r.status).toBe(0);
		expect(r.stdout).not.toContain("CARD SHAPE");
	});

	it("stays silent where growth stops short of the ceiling", () => {
		const before = write(
			"cs-b5.html",
			roadmapHtml([card({ id: "a", b: words(10) })]),
		);
		const after = write(
			"cs-a5.html",
			roadmapHtml([card({ id: "a", b: words(250) })], "v5.1"),
		);
		const r = run(SCRIPT, [after, "--original", before]);
		expect(r.status).toBe(0);
		expect(r.stdout).not.toContain("CARD SHAPE");
	});

	/* Each padding below is 240 words of prose plus 61 raw tokens of markup:
	 * under the ceiling once stripped, over it if it is not. */
	it("counts words, not tags", () => {
		const padded = `<p>${"word ".repeat(240)}${"<br> ".repeat(60)}</p>`;
		const before = write("cs-b6.html", roadmapHtml([card({ id: "a" })]));
		const after = write(
			"cs-a6.html",
			roadmapHtml([card({ id: "a", b: padded })], "v5.1"),
		);
		const r = run(SCRIPT, [after, "--original", before]);
		expect(r.status).toBe(0);
		expect(r.stdout).not.toContain("CARD SHAPE");
	});

	it("counts words, not entities", () => {
		const padded = `${"word ".repeat(240)}${"&nbsp; ".repeat(30)}${"&#8212; ".repeat(31)}`;
		const before = write("cs-b8.html", roadmapHtml([card({ id: "a" })]));
		const after = write(
			"cs-a8.html",
			roadmapHtml([card({ id: "a", b: padded })], "v5.1"),
		);
		const r = run(SCRIPT, [after, "--original", before]);
		expect(r.status).toBe(0);
		expect(r.stdout).not.toContain("CARD SHAPE");
	});

	it("does not run at all without --original", () => {
		const after = write(
			"cs-a7.html",
			roadmapHtml([card({ id: "a", b: words(900) })]),
		);
		const r = run(SCRIPT, [after]);
		expect(r.status).toBe(0);
		expect(r.stdout).not.toContain("CARD SHAPE");
	});
});

/* The same touch-gated proxy on the three other fields SKILL.md §What a card
 * holds governs (mantahostels#3187). */
describe("the mn, c.x and log ceilings", () => {
	const callout = (x: string) => ({ type: "flag", k: "tag", x });
	const done = (over: { id: string; log?: string }) => ({
		...card({ ...over, state: "done" }),
		log: over.log ?? "shipped",
	});

	it("warns on an mn this edit grew past 30 words, naming the card, both word counts and what an mn holds", () => {
		const before = write(
			"mn-b1.html",
			roadmapHtml([card({ id: "a", mn: plain(5) })]),
		);
		const after = write(
			"mn-a1.html",
			roadmapHtml([card({ id: "a", mn: plain(31) })], "v5.1"),
		);
		const r = run(SCRIPT, [after, "--original", before]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			'"a" mn grew to 31 words (was 5), over the 30-word ceiling',
		);
		expect(r.stdout).toContain("the `m` choice and the execution surface");
	});

	it("stays silent on an mn of exactly 30 words", () => {
		const before = write("mn-b2.html", roadmapHtml([card({ id: "a" })]));
		const after = write(
			"mn-a2.html",
			roadmapHtml([card({ id: "a", mn: plain(30) })], "v5.1"),
		);
		const r = run(SCRIPT, [after, "--original", before]);
		expect(r.status).toBe(0);
		expect(r.stdout).not.toContain("CARD SHAPE");
	});

	it("warns on an over-cap mn this edit shortened but left over, naming the card and both word counts", () => {
		const before = write(
			"mn-b3.html",
			roadmapHtml([card({ id: "a", mn: plain(80) })]),
		);
		const after = write(
			"mn-a3.html",
			roadmapHtml([card({ id: "a", mn: plain(50) })], "v5.1"),
		);
		const r = run(SCRIPT, [after, "--original", before]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			'"a" mn is now 50 words (was 80), over the 30-word ceiling',
		);
	});

	it("warns on a c.x this edit grew past 80 words, naming the card, both word counts and what a callout holds", () => {
		const before = write(
			"cx-b1.html",
			roadmapHtml([card({ id: "a", c: callout(plain(10)) })]),
		);
		const after = write(
			"cx-a1.html",
			roadmapHtml([card({ id: "a", c: callout(plain(81)) })], "v5.1"),
		);
		const r = run(SCRIPT, [after, "--original", before]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			'"a" c.x grew to 81 words (was 10), over the 80-word ceiling',
		);
		expect(r.stdout).toContain("A callout states one situation");
	});

	it("stays silent on a c.x of exactly 80 words", () => {
		const before = write("cx-b3.html", roadmapHtml([card({ id: "a" })]));
		const after = write(
			"cx-a3.html",
			roadmapHtml([card({ id: "a", c: callout(plain(80)) })], "v5.1"),
		);
		const r = run(SCRIPT, [after, "--original", before]);
		expect(r.status).toBe(0);
		expect(r.stdout).not.toContain("CARD SHAPE");
	});

	it("warns on a log this edit grew past 80 words, naming the card, both word counts and what a log holds", () => {
		const before = write("log-b1.html", roadmapHtml([done({ id: "a" })]));
		const after = write(
			"log-a1.html",
			roadmapHtml([done({ id: "a", log: plain(81) })], "v5.1"),
		);
		const r = run(SCRIPT, [after, "--original", before]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			'"a" log grew to 81 words (was 1), over the 80-word ceiling',
		);
		expect(r.stdout).toContain("A log is one to two sentences");
	});

	it("stays silent on a log of exactly 80 words", () => {
		const before = write("log-b2.html", roadmapHtml([done({ id: "a" })]));
		const after = write(
			"log-a2.html",
			roadmapHtml([done({ id: "a", log: plain(80) })], "v5.1"),
		);
		const r = run(SCRIPT, [after, "--original", before]);
		expect(r.status).toBe(0);
		expect(r.stdout).not.toContain("CARD SHAPE");
	});

	/* The pre-commit gate runs this check on every roadmap commit, and many cards
	 * carry no `c` or no `log` — a read that throws refuses them all (mantahostels#3200). */
	it("does not throw on a card with no c, no log and no mn", () => {
		const before = write("nil-b.html", roadmapHtml([card({ id: "a" })]));
		const after = write(
			"nil-a.html",
			roadmapHtml([card({ id: "a" }), card({ id: "b" })], "v5.1"),
		);
		const r = run(SCRIPT, [after, "--original", before]);
		expect(r.status).toBe(0);
		expect(r.stdout).not.toContain("CARD SHAPE");
	});

	it("counts words in c.x, not tags", () => {
		const before = write("cx-b2.html", roadmapHtml([card({ id: "a" })]));
		const after = write(
			"cx-a2.html",
			roadmapHtml(
				[
					card({
						id: "a",
						c: callout(`<p>${plain(78)}</p>${"<br> ".repeat(20)}`),
					}),
				],
				"v5.1",
			),
		);
		const r = run(SCRIPT, [after, "--original", before]);
		expect(r.status).toBe(0);
		expect(r.stdout).not.toContain("CARD SHAPE");
	});
});

describe("structural checks", () => {
	it("fails on a duplicate id, naming it", () => {
		const file = write(
			"dup.html",
			roadmapHtml([card({ id: "a" }), card({ id: "a" })]),
		);
		const r = run(SCRIPT, [file]);
		expect(r.status).toBe(1);
		expect(r.stdout).toContain('duplicate id "a"');
	});

	it("fails on a needs pointing at a missing id", () => {
		const file = write(
			"dep.html",
			roadmapHtml([card({ id: "a", needs: ["ghost"] })]),
		);
		const r = run(SCRIPT, [file]);
		expect(r.status).toBe(1);
		expect(r.stdout).toContain('needs missing id "ghost"');
	});

	it("fails when a card precedes its same-phase prerequisite", () => {
		const file = write(
			"order.html",
			roadmapHtml([
				card({ id: "first", needs: ["second"] }),
				card({ id: "second" }),
			]),
		);
		const r = run(SCRIPT, [file]);
		expect(r.status).toBe(1);
		expect(r.stdout).toContain("breaks execution order");
	});

	it("fails on a done card with no log", () => {
		const file = write(
			"nolog.html",
			roadmapHtml([card({ id: "a", state: "done" })]),
		);
		const r = run(SCRIPT, [file]);
		expect(r.status).toBe(1);
		expect(r.stdout).toContain("has no log");
	});

	it("fails on a callout label over 20 chars", () => {
		const file = write(
			"label.html",
			roadmapHtml([
				card({
					id: "a",
					c: { type: "flag", k: "a label far too long to render", x: "why" },
				}),
			]),
		);
		const r = run(SCRIPT, [file]);
		expect(r.status).toBe(1);
		expect(r.stdout).toContain("callout label is");
	});

	it("fails on a non-done card with no dw, naming the card", () => {
		const file = write(
			"nodw.html",
			roadmapHtml([card({ id: "a", dw: undefined })]),
		);
		const r = run(SCRIPT, [file]);
		expect(r.status).toBe(1);
		expect(r.stdout).toContain('"a" is non-done and has no dw');
	});

	it("does not require dw on a done card", () => {
		const file = write(
			"done-nodw.html",
			roadmapHtml([
				card({ id: "a", state: "done", log: "shipped", dw: undefined }),
			]),
		);
		const r = run(SCRIPT, [file]);
		expect(r.status).toBe(0);
		expect(r.stdout).not.toContain("has no dw");
	});
});

describe("why: the roadmap's first ERROR-severity prose check (mantahostels#3186, mantahostels#3193)", () => {
	it("fails the moment why exceeds 40 words, with no --original needed, naming the card and its word count", () => {
		const file = write(
			"why-over.html",
			roadmapHtml([card({ id: "a", why: plain(41) })]),
		);
		const r = run(SCRIPT, [file]);
		expect(r.status).toBe(1);
		expect(r.stdout).toContain('"a" why is 41 words, over the 40-word cap');
	});

	it("stays silent on why of exactly 40 words", () => {
		const file = write(
			"why-ok.html",
			roadmapHtml([card({ id: "a", why: plain(40) })]),
		);
		const r = run(SCRIPT, [file]);
		expect(r.status).toBe(0);
		expect(r.stdout).not.toContain("why is");
	});

	it("is silent when why is absent — it's optional", () => {
		const file = write("why-absent.html", roadmapHtml([card({ id: "a" })]));
		const r = run(SCRIPT, [file]);
		expect(r.status).toBe(0);
		expect(r.stdout).not.toContain("why is");
	});
});

describe("dw's touch-gated WARN ceiling (60 words, mantahostels#3190)", () => {
	it("warns on a dw this edit grew past 60 words, naming the card, both word counts and what a dw holds", () => {
		const before = write(
			"dw-b1.html",
			roadmapHtml([card({ id: "a", dw: plain(5) })]),
		);
		const after = write(
			"dw-a1.html",
			roadmapHtml([card({ id: "a", dw: plain(61) })], "v5.1"),
		);
		const r = run(SCRIPT, [after, "--original", before]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			'"a" dw grew to 61 words (was 5), over the 60-word ceiling',
		);
		expect(r.stdout).toContain(
			"A done-when/start-when is the completion condition",
		);
	});

	it("stays silent on a dw of exactly 60 words", () => {
		const before = write("dw-b2.html", roadmapHtml([card({ id: "a" })]));
		const after = write(
			"dw-a2.html",
			roadmapHtml([card({ id: "a", dw: plain(60) })], "v5.1"),
		);
		const r = run(SCRIPT, [after, "--original", before]);
		expect(r.status).toBe(0);
		expect(r.stdout).not.toContain("CARD SHAPE");
	});

	it("warns on an over-cap dw this edit shortened but left over, naming the card and both word counts", () => {
		const before = write(
			"dw-b3.html",
			roadmapHtml([card({ id: "a", dw: plain(80) })]),
		);
		const after = write(
			"dw-a3.html",
			roadmapHtml([card({ id: "a", dw: plain(61) })], "v5.1"),
		);
		const r = run(SCRIPT, [after, "--original", before]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain('"a" dw is now 61 words (was 80)');
	});
});

describe("capOk exemption discipline (mantahostels#3189)", () => {
	it("warns MALFORMED EXEMPTION on a key outside the four ceilinged fields, naming the card and the key", () => {
		const file = write(
			"capok-badkey.html",
			roadmapHtml([card({ id: "a", capOk: { dw: 1234 } })]),
		);
		const r = run(SCRIPT, [file]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			'MALFORMED EXEMPTION: "a" capOk key "dw" is not one of the ceilinged fields',
		);
	});

	it("warns MALFORMED EXEMPTION on a non-positive-integer value, naming the card, the field and the value", () => {
		const file = write(
			"capok-badval.html",
			roadmapHtml([card({ id: "a", capOk: { mn: 0 } })]),
		);
		const r = run(SCRIPT, [file]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			'MALFORMED EXEMPTION: "a" capOk.mn value 0 is not a positive integer issue number',
		);
	});

	it("warns STALE EXEMPTION when the named field is at or under its ceiling, naming the card, the field and its word count", () => {
		const file = write(
			"capok-stale.html",
			roadmapHtml([card({ id: "a", mn: "short note", capOk: { mn: 3189 } })]),
		);
		const r = run(SCRIPT, [file]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			'STALE EXEMPTION: "a" capOk.mn (#3189) names a field now at 2 words, at or under its 30-word ceiling',
		);
	});

	it("stays silent when the exempted field is genuinely over its ceiling", () => {
		const file = write(
			"capok-live.html",
			roadmapHtml([card({ id: "a", mn: plain(31), capOk: { mn: 3189 } })]),
		);
		const r = run(SCRIPT, [file]);
		expect(r.status).toBe(0);
		expect(r.stdout).not.toContain("EXEMPTION");
	});

	it("reads `b` for a capOk.b exemption", () => {
		const file = write(
			"capok-b.html",
			roadmapHtml([card({ id: "a", b: "short body", capOk: { b: 3189 } })]),
		);
		const r = run(SCRIPT, [file]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			'STALE EXEMPTION: "a" capOk.b (#3189) names a field now at 2 words, at or under its 250-word ceiling',
		);
	});

	it('reads `c.x` for a capOk."c.x" exemption', () => {
		const file = write(
			"capok-cx.html",
			roadmapHtml([
				card({
					id: "a",
					c: { type: "flag", k: "tag", x: "short callout" },
					capOk: { "c.x": 3189 },
				}),
			]),
		);
		const r = run(SCRIPT, [file]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			'STALE EXEMPTION: "a" capOk.c.x (#3189) names a field now at 2 words, at or under its 80-word ceiling',
		);
	});

	it("still fires CARD SHAPE on an exempted field that grows past its ceiling", () => {
		const before = write(
			"capok-grow-b.html",
			roadmapHtml([card({ id: "a", mn: plain(31), capOk: { mn: 3189 } })]),
		);
		const after = write(
			"capok-grow-a.html",
			roadmapHtml(
				[card({ id: "a", mn: plain(32), capOk: { mn: 3189 } })],
				"v5.1",
			),
		);
		const r = run(SCRIPT, [after, "--original", before]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			'"a" mn grew to 32 words (was 31), over the 30-word ceiling',
		);
		expect(r.stdout).not.toContain("EXEMPTION");
	});

	it("silences CARD SHAPE on a touch of an exempted field that does not grow it", () => {
		const before = write(
			"capok-touch-b.html",
			roadmapHtml([card({ id: "a", mn: plain(40), capOk: { mn: 3189 } })]),
		);
		const after = write(
			"capok-touch-a.html",
			roadmapHtml(
				[card({ id: "a", mn: plain(35), capOk: { mn: 3189 } })],
				"v5.1",
			),
		);
		const r = run(SCRIPT, [after, "--original", before]);
		expect(r.status).toBe(0);
		expect(r.stdout).not.toContain("CARD SHAPE");
	});

	it("does not silence a touch of a field the exemption does not name", () => {
		const before = write(
			"capok-other-b.html",
			roadmapHtml([card({ id: "a", mn: plain(40), capOk: { b: 3189 } })]),
		);
		const after = write(
			"capok-other-a.html",
			roadmapHtml(
				[card({ id: "a", mn: plain(35), capOk: { b: 3189 } })],
				"v5.1",
			),
		);
		const r = run(SCRIPT, [after, "--original", before]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain('"a" mn is now 35 words (was 40)');
	});

	it("does not let a malformed capOk.dw silence a dw touch", () => {
		const before = write(
			"capok-dw-b.html",
			roadmapHtml([card({ id: "a", dw: plain(70), capOk: { dw: 3189 } })]),
		);
		const after = write(
			"capok-dw-a.html",
			roadmapHtml(
				[card({ id: "a", dw: plain(65), capOk: { dw: 3189 } })],
				"v5.1",
			),
		);
		const r = run(SCRIPT, [after, "--original", before]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain('"a" dw is now 65 words (was 70)');
	});

	it("does not let a malformed capOk value silence a touch", () => {
		const before = write(
			"capok-zero-b.html",
			roadmapHtml([card({ id: "a", mn: plain(40), capOk: { mn: 0 } })]),
		);
		const after = write(
			"capok-zero-a.html",
			roadmapHtml([card({ id: "a", mn: plain(35), capOk: { mn: 0 } })], "v5.1"),
		);
		const r = run(SCRIPT, [after, "--original", before]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain('"a" mn is now 35 words (was 40)');
	});

	it("is silent on a card with no capOk at all", () => {
		const file = write("capok-none.html", roadmapHtml([card({ id: "a" })]));
		const r = run(SCRIPT, [file]);
		expect(r.status).toBe(0);
		expect(r.stdout).not.toContain("EXEMPTION");
	});
});

// m is optional (mantahostels#831): absent, it means
// the Opus 5.5 · medium default and is not warned on. When present it must be
// one of the closed exception codes.
describe("m-code discipline", () => {
	it("prints no warning when m is absent", () => {
		const file = write("no-m.html", roadmapHtml([card({ id: "a" })]));
		const r = run(SCRIPT, [file]);
		expect(r.status).toBe(0);
		expect(r.stdout).not.toContain("no m (model/effort) field");
	});

	it("accepts the two closed string codes with no m-code warning", () => {
		const file = write(
			"good-m.html",
			roadmapHtml([card({ id: "a", m: "max" }), card({ id: "b", m: "—" })]),
		);
		const r = run(SCRIPT, [file]);
		expect(r.stdout).not.toContain("unrecognised m code");
	});

	it("warns on a retired tier spelling", () => {
		const file = write(
			"bad-m.html",
			roadmapHtml([card({ id: "a", m: "S/H" })]),
		);
		const r = run(SCRIPT, [file]);
		expect(r.stdout).toContain('has unrecognised m code "S/H"');
	});

	it("warns on a retired tier spelling carried by a done card (#2344)", () => {
		const file = write(
			"done-retired.html",
			roadmapHtml([card({ id: "a", state: "done", m: "S/H", log: "shipped" })]),
		);
		const r = run(SCRIPT, [file]);
		expect(r.stdout).toContain('has unrecognised m code "S/H"');
	});

	it("accepts a leg-scoped array whose entries are all max", () => {
		const file = write(
			"leg-good.html",
			roadmapHtml([card({ id: "a", m: [["design", "max"]] })]),
		);
		const r = run(SCRIPT, [file]);
		expect(r.stdout).not.toContain("bad leg-scoped m entry");
	});

	it("warns on a leg-scoped entry that isn't max", () => {
		const file = write(
			"leg-bad.html",
			roadmapHtml([card({ id: "a", m: [["build", "S/H"]] })]),
		);
		const r = run(SCRIPT, [file]);
		expect(r.stdout).toContain("bad leg-scoped m entry");
	});
});

// The docmeta stamp is written from reckoning, not copied, and has gone wrong
// both ways in the live roadmap (mantahostels#3499).
describe("docmeta stamp sanity", () => {
	it("accepts a stamp written now", () => {
		const file = write(
			"stamp-now.html",
			roadmapHtml([card({ id: "a" })], "v5.0", witaStamp()),
		);
		const r = run(SCRIPT, [file]);
		expect(r.status).toBe(0);
		expect(r.stdout).not.toContain("STAMP");
	});

	it("fails when the stamp is in the future, naming the Asia/Makassar timezone to stamp in", () => {
		const file = write(
			"stamp-future.html",
			roadmapHtml([card({ id: "a" })], "v5.0", witaStamp(AHEAD_MIN)),
		);
		const r = run(SCRIPT, [file]);
		expect(r.status).toBe(1);
		expect(r.stdout).toContain("STAMP IN THE FUTURE");
		expect(r.stdout).toContain("TZ=Asia/Makassar");
	});

	// Guards the design choice: age is not the test, so same-day lag is silent.
	it("tolerates an older stamp that still carries today's date", () => {
		const stamp = `${witaStamp().split(",")[0]}, 00:01`;
		const file = write(
			"stamp-recent.html",
			roadmapHtml([card({ id: "a" })], "v5.0", stamp),
		);
		const r = run(SCRIPT, [file]);
		expect(r.status).toBe(0);
		expect(r.stdout).not.toContain("STAMP");
	});

	it("warns, without failing, when the stamp carries a past date", () => {
		const file = write(
			"stamp-misdated.html",
			roadmapHtml([card({ id: "a" })], "v5.0", witaStamp(EARLIER_DAY_MIN)),
		);
		const r = run(SCRIPT, [file]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("STAMP MISDATED");
	});

	it("warns as STAMP UNREADABLE when the stamp is not in the expected en-GB form", () => {
		const file = write(
			"stamp-junk.html",
			roadmapHtml([card({ id: "a" })], "v5.0", "2026-08-02T11:36"),
		);
		const r = run(SCRIPT, [file]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("STAMP UNREADABLE");
	});
});

describe("validateRoadmap()'s judgeStampDay: false (#1602)", () => {
	it("leaves a stamp from an earlier day unjudged", () => {
		const { warnings } = validateRoadmap(
			roadmapHtml(
				[card({ id: "a" })],
				`v${EXPECTED_MAJOR}.0`,
				witaStamp(EARLIER_DAY_MIN),
			),
			null,
			{ judgeStampDay: false },
		);
		expect(warnings.join("\n")).not.toContain("STAMP");
	});

	it("still errors on a stamp in the future", () => {
		const { errors } = validateRoadmap(
			roadmapHtml(
				[card({ id: "a" })],
				`v${EXPECTED_MAJOR}.0`,
				witaStamp(AHEAD_MIN),
			),
			null,
			{ judgeStampDay: false },
		);
		expect(errors.join("\n")).toContain("STAMP IN THE FUTURE");
	});
});

// Characterisation (mantahostels#696): the CLI became a thin wrapper over validateRoadmap(),
// so these pin the wrapper's own output — the report's sections and the exit
// code it derives from them.
describe("the report the CLI prints", () => {
	it("prints every section, in order, for a clean file with a baseline", () => {
		const before = write("rep-b.html", roadmapHtml([card({ id: "a" })]));
		const after = write(
			"rep-a.html",
			roadmapHtml([card({ id: "a" }), card({ id: "b", p: 1 })], "v5.1"),
		);
		const r = run(SCRIPT, [after, "--original", before]);
		expect(r.status).toBe(0);
		// Order matters as much as presence: a caller reading this report scans
		// it top-down.
		// `cards:` carries the total, then the per-phase breakdown in phase order.
		const lines = r.stdout.split("\n").map((l) => l.trimEnd());
		const at = (needle: string) => {
			const i = lines.findIndex((l) => l.includes(needle));
			expect(i, `report has no line containing ${needle}`).toBeGreaterThan(-1);
			return i;
		};
		expect([
			at("── roadmap validation ─"),
			at(`file:      ${after}`),
			at("version:   v5.1 · 1 July 2026, 10:00"),
			at("cards:     2  (P0:1 P1:1)"),
			at("scope:     1 → 2 cards, v5.0 → v5.1"),
			at("  added:   b"),
			at("  removed: (none)"),
		]).toEqual([0, 1, 2, 3, 4, 5, 6]);
	});

	it("says NOT FOUND rather than crashing when the version line is missing", () => {
		const html = roadmapHtml([card({ id: "a" })]).replace(
			/<p class="docmeta">[^<]*<\/p>/,
			"",
		);
		const r = run(SCRIPT, [write("nover.html", html)]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("version:   NOT FOUND");
	});

	// Warnings never move the exit code — only errors do. A gate reading this
	// script's status must not start failing on a judgement-call warning.
	it("exits 0 with warnings and no errors, and does not print FAIL", () => {
		const file = write(
			"warn-only.html",
			roadmapHtml([card({ id: "a", m: "S/H" })]),
		);
		const r = run(SCRIPT, [file]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("WARNINGS (");
		expect(r.stdout).not.toContain("FAIL");
		expect(r.stdout).toContain("OK —");
	});

	// The roadmap file itself, unlike the baseline, has nothing to report on, so
	// it stays a FATAL on stderr with no report printed at all.
	it("is fatal, with no report, when the roadmap file cannot be read", () => {
		const r = run(SCRIPT, [path.join(dir, "absent.html")]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("FATAL:");
		expect(r.stderr).toContain("ENOENT");
		expect(r.stdout).not.toContain("roadmap validation");
	});

	it("is fatal when the roadmap file is not a roadmap", () => {
		const r = run(SCRIPT, [write("notaroadmap.html", "<html></html>")]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('FATAL: could not find "const ITEMS = ["');
	});

	/*
	 * `run` spawns, so stdout is a real pipe. node drops what is still buffered
	 * on one at process.exit, and 64 KiB is the pipe buffer: 2,000 errors clear
	 * it, and the verdict line is written last.
	 */
	it("prints a FAIL report longer than the pipe buffer whole, verdict line included (#1444)", () => {
		const cards = Array.from({ length: 2000 }, (_, i) =>
			card({ id: `c${i}`, needs: [`missing-prerequisite-${i}`] }),
		);
		const r = run(SCRIPT, [write("many-errors.html", roadmapHtml(cards))]);
		expect(r.status).toBe(1);
		expect(r.stdout.length).toBeGreaterThan(64 * 1024);
		expect(r.stdout).toContain(
			'"c1999" needs missing id "missing-prerequisite-1999"',
		);
		expect(r.stdout.trimEnd()).toMatch(
			/FAIL — do not ship until errors are resolved\.$/,
		);
	});
});

// The callable seam the CLI now sits on.
describe("schema drift on a small roadmap (mantahostels#3519)", () => {
	const dropped = (n: number) =>
		validateRoadmap(
			roadmapHtml(Array.from({ length: n }, (_, i) => card({ id: `c${i}` }))),
		).warnings.filter((w: string) => w.includes("no longer used anywhere"));

	it("does not call a field retired on a roadmap too small to use it", () => {
		expect(dropped(24)).toEqual([]);
	});

	it("still does on one large enough that the field's absence means something", () => {
		expect(dropped(25)).toHaveLength(1);
	});

	it("reports a new field whatever the roadmap's size", () => {
		const { warnings } = validateRoadmap(
			roadmapHtml([
				{ ...card({ id: "a" }), novel: 1 } as ReturnType<typeof card>,
			]),
		);
		expect(warnings.join("\n")).toContain(
			"card field(s) not in KNOWN_ITEM_FIELDS: novel",
		);
	});
});

// An adopter's own copy of validate.js is the core's unmodified file, so its
// EXPECTED_MAJOR is the core's schema-review checkpoint, not the adopter's —
// init-adopter.js seeds .claude/workflow-core.json's `roadmapMajorPin` with
// the adopter's own day-one major instead (#54).
describe("VERSION TRIPWIRE pin (#54)", () => {
	it("takes an injected pin over the core's own EXPECTED_MAJOR", () => {
		const { warnings } = validateRoadmap(
			roadmapHtml([card({ id: "a" })], `v${EXPECTED_MAJOR + 2}.0`),
			null,
			{ expectedMajor: EXPECTED_MAJOR + 2 },
		);
		expect(warnings.join("\n")).not.toContain("VERSION TRIPWIRE");
	});

	it("still warns VERSION TRIPWIRE once the roadmap's own major moves past the injected pin", () => {
		const { warnings } = validateRoadmap(
			roadmapHtml([card({ id: "a" })], `v${EXPECTED_MAJOR + 3}.0`),
			null,
			{ expectedMajor: EXPECTED_MAJOR + 2 },
		);
		expect(warnings.join("\n")).toContain("VERSION TRIPWIRE");
	});

	it("falls back to the core's own pin with no expectedMajor injected and no adopter config on disk", () => {
		const { warnings } = validateRoadmap(
			roadmapHtml([card({ id: "a" })], `v${EXPECTED_MAJOR}.0`),
			null,
			{ root: dir },
		);
		expect(warnings.join("\n")).not.toContain("VERSION TRIPWIRE");
	});
});

describe("resolveExpectedMajor()'s own read off .claude/workflow-core.json (#54)", () => {
	const { resolveExpectedMajor } = createRequire(import.meta.url)(
		"./validate.js",
	);
	it("reads a declared roadmapMajorPin", () => {
		fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, ".claude/workflow-core.json"),
			JSON.stringify({ roadmapMajorPin: 3 }),
		);
		const warnings: string[] = [];
		expect(resolveExpectedMajor(warnings, dir)).toEqual({
			major: 3,
			isAdopterOwned: true,
		});
		expect(warnings).toEqual([]);
	});

	it("reads a declared roadmapMajorPin equal to the core's own EXPECTED_MAJOR as adopter-owned", () => {
		fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, ".claude/workflow-core.json"),
			JSON.stringify({ roadmapMajorPin: EXPECTED_MAJOR }),
		);
		const warnings: string[] = [];
		expect(resolveExpectedMajor(warnings, dir)).toEqual({
			major: EXPECTED_MAJOR,
			isAdopterOwned: true,
		});
	});

	it("falls back silently with no config file", () => {
		const warnings: string[] = [];
		expect(resolveExpectedMajor(warnings, dir)).toEqual({
			major: EXPECTED_MAJOR,
			isAdopterOwned: false,
		});
		expect(warnings).toEqual([]);
	});

	it("falls back with a warning on a config that does not parse", () => {
		fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, ".claude/workflow-core.json"),
			"{ not json",
		);
		const warnings: string[] = [];
		expect(resolveExpectedMajor(warnings, dir)).toEqual({
			major: EXPECTED_MAJOR,
			isAdopterOwned: false,
		});
		expect(warnings.join("\n")).toContain("VERSION TRIPWIRE PIN");
		expect(warnings.join("\n")).toContain("does not parse");
	});

	it("falls back with a warning on a config that is not an object", () => {
		fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
		fs.writeFileSync(path.join(dir, ".claude/workflow-core.json"), "null");
		const warnings: string[] = [];
		expect(resolveExpectedMajor(warnings, dir)).toEqual({
			major: EXPECTED_MAJOR,
			isAdopterOwned: false,
		});
		expect(warnings.join("\n")).toContain("VERSION TRIPWIRE PIN");
		expect(warnings.join("\n")).toContain("does not hold an object");
	});

	it("falls back with a warning on a non-number roadmapMajorPin", () => {
		fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, ".claude/workflow-core.json"),
			JSON.stringify({ roadmapMajorPin: "7" }),
		);
		const warnings: string[] = [];
		expect(resolveExpectedMajor(warnings, dir)).toEqual({
			major: EXPECTED_MAJOR,
			isAdopterOwned: false,
		});
		expect(warnings.join("\n")).toContain("VERSION TRIPWIRE PIN");
		expect(warnings.join("\n")).toContain("is not a number");
	});
});

describe("validateRoadmap()", () => {
	it("returns the verdict as data, with no baseline", () => {
		const result = validateRoadmap(
			roadmapHtml([card({ id: "a" }), card({ id: "b", p: 1 })], "v5.4"),
		);
		expect(result.errors).toEqual([]);
		expect(result.cardCount).toBe(2);
		expect(result.phaseCounts).toEqual({ 0: 1, 1: 1 });
		expect(result.version).toMatchObject({ major: 5, minor: 4, raw: "v5.4" });
		// No baseline means no diff ran — distinct from a diff that found nothing.
		expect(result.scope).toBeNull();
		expect(result.added).toEqual([]);
		expect(result.removed).toEqual([]);
	});

	it("names errors and warnings separately", () => {
		const result = validateRoadmap(
			roadmapHtml([card({ id: "a" }), card({ id: "a", m: "S/H" })]),
		);
		expect(result.errors).toContain('duplicate id "a"');
		expect(result.warnings.join("\n")).toContain(
			'has unrecognised m code "S/H"',
		);
	});

	it("diffs card ids against a baseline passed as HTML", () => {
		const result = validateRoadmap(
			roadmapHtml([card({ id: "keep" }), card({ id: "new" })], "v5.1"),
			roadmapHtml([card({ id: "keep" }), card({ id: "drop" })]),
		);
		expect(result.added).toEqual(["new"]);
		expect(result.removed).toEqual(["drop"]);
		expect(result.scope).toMatchObject({
			countBefore: 2,
			countAfter: 2,
			versionBefore: "v5.0",
			versionAfter: "v5.1",
		});
	});

	// How the CLI reports an unreadable --original without losing every other
	// check: it hands the read failure over as the Error itself.
	it("treats a baseline handed over as an Error as an error naming the path and the unrun scope diff, not a skip", () => {
		const result = validateRoadmap(
			roadmapHtml([card({ id: "a" })]),
			new Error("ENOENT: no such file or directory, open '/gone.html'"),
			{ originalLabel: "/gone.html" },
		);
		expect(result.scope).toBeNull();
		expect(result.errors.join("\n")).toContain(
			'--original was supplied ("/gone.html")',
		);
		expect(result.errors.join("\n")).toContain(
			"scope diff therefore did not run",
		);
	});

	it("throws when the roadmap html itself cannot be parsed, naming const ITEMS", () => {
		expect(() => validateRoadmap("<html></html>")).toThrow(/const ITEMS/);
	});
});
