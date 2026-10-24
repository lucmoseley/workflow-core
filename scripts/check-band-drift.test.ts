// @vitest-environment node
/*
 * Pins that check-band-drift.js files or refreshes one tracking issue only when
 * a band reading falls below half its baseline on a large enough sample, and
 * another only when the share of tops at 70 rises above 1.5 times its own,
 * which questions it reads across the seats, and that it never fails.
 *
 * Drives the real script through lib/run-in-process.js, CLAUDE_CONFIG_DIR and
 * its three WFC_CLAUDE_CONFIG_* siblings pointed at a sandbox so the founder's
 * own transcript corpus is never read, `gh` stubbed at WFC_GH and the
 * sanctioned body writer at WFC_ISSUE_BODY (#487).
 *
 * Every fixture figure is derived from lib/band-baseline.js, the script's own
 * baseline, so a re-measured baseline moves no test.
 *
 * It runs under `npm run status`, the only watch on agents narrowing their
 * bands or pricing at 70 to slip past guard-priced-options.js's close-rivals
 * check: loosen a case and that evasion goes unreported, or the founder is
 * sent a false alarm.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	bandQuestions,
	NARROW_CLEAR,
	NARROW_OVERLAP,
	round,
	times,
	topQuestions,
	WIDE_CLEAR,
	writeTranscript,
} from "./lib/band-drift-fixture";
import { stubGhScript } from "./lib/gh-stub";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.join(__dirname, "check-band-drift.js");
const { TITLE, TOP_TITLE, LABEL } = require("./check-band-drift.js");
const {
	BAND_BASELINE,
	MIN_BAND_SAMPLE,
	TOP_BASELINE,
	MIN_TOP_SAMPLE,
} = require("./lib/band-baseline.js");

let sandbox: string;
let corpus: string;

beforeEach(() => {
	sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-band-drift-"));
	corpus = path.join(sandbox, "seat", "projects", "-some-project");
	fs.mkdirSync(corpus, { recursive: true });
});

afterEach(() => {
	fs.rmSync(sandbox, { recursive: true, force: true });
});

/**
 * A transcript in the corpus, dated now and top-level unless `ageDays` or
 * `sidechain` says otherwise.
 */
const transcript = (
	texts: string[],
	opts: { ageDays?: number; sidechain?: boolean; dir?: string } = {},
) => writeTranscript(opts.dir ?? corpus, texts, opts);

/** How many of `n` band questions overlap, to land at `ratio` of baseline. */
const overlapsAt = (n: number, ratio: number) =>
	Math.round(n * BAND_BASELINE.overlapShare * ratio);

/** How many of `n` tops sit at the line, at most `ratio` of baseline's share. */
const atLineAt = (n: number, ratio: number) =>
	Math.floor((n * TOP_BASELINE.atLine * ratio) / TOP_BASELINE.tops);

/*
 * A stub `gh` that records its argv and answers the three calls
 * lib/tracking-issue.js makes; `open` is what `issue list` says is open.
 */
function stubGh(open: { number: number; title: string }[] = []) {
	const log = path.join(sandbox, "gh-argv.log");
	fs.writeFileSync(
		path.join(sandbox, "issues.json"),
		JSON.stringify(
			open.map((o) => ({
				...o,
				labels: [{ name: LABEL }],
			})),
		),
	);
	const script = [
		"#!/bin/sh",
		`printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
		'if [ "$1" = "issue" ] && [ "$2" = "list" ]; then',
		`  cat ${JSON.stringify(path.join(sandbox, "issues.json"))}`,
		'elif [ "$1" = "issue" ] && [ "$2" = "view" ]; then',
		"  echo 'an older body'",
		'elif [ "$1" = "issue" ] && [ "$2" = "create" ]; then',
		"  echo https://github.com/o/r/issues/999",
		"fi",
		"exit 0",
	].join("\n");
	const bodyLog = path.join(sandbox, "issue-body-argv.log");
	const bodyScript = path.join(sandbox, "issue-body.js");
	fs.writeFileSync(
		bodyScript,
		`require("node:fs").appendFileSync(${JSON.stringify(bodyLog)}, process.argv.slice(2).join(" ") + "\\n");`,
	);
	const stub = stubGhScript(sandbox, script);
	const read = (f: string) =>
		fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
	return {
		env: { ...stub.env, WFC_ISSUE_BODY: bodyScript },
		calls: () => read(log),
		bodyCalls: () => read(bodyLog),
	};
}

const run = (
	gh: { env: Record<string, string> },
	args: string[] = [],
	seats: Partial<Record<"A" | "B" | "C", string>> = {},
) => {
	const seat = path.join(sandbox, "seat");
	const r = runInProcess(SCRIPT, args, {
		env: {
			...process.env,
			GITHUB_ACTIONS: "",
			CLAUDE_CONFIG_DIR: seats.A ?? seat,
			WFC_CLAUDE_CONFIG_A: seats.A ?? seat,
			WFC_CLAUDE_CONFIG_B: seats.B ?? seat,
			WFC_CLAUDE_CONFIG_C: seats.C ?? seat,
			...gh.env,
		},
	});
	return { status: r.status, out: r.stdout + r.stderr };
};

const N = MIN_BAND_SAMPLE + 20;

/** `n` band questions overlapping at the baseline rate: a steady reading. */
const steady = (n: number) => bandQuestions(n, overlapsAt(n, 1));

describe("readings at or above half the baseline", () => {
	it("files nothing and reports the reading", () => {
		transcript(steady(N));
		const gh = stubGh();
		const r = run(gh);
		expect(r.out).toContain(`OK: ${N} rival question(s) in the last 14d`);
		expect(r.out).toContain(`${N} with a 26–30-point gap`);
		expect(gh.calls()).toBe("");
		expect(r.status).toBe(0);
	});
});

describe("a reading below half its baseline", () => {
	it("files the tracking issue when the overlap share has halved", () => {
		transcript(bandQuestions(N, overlapsAt(N, 0.3)));
		const gh = stubGh();
		const r = run(gh);
		expect(r.out).toContain("price bands have narrowed");
		expect(r.out).toContain("Filed https://github.com/o/r/issues/999");
		expect(gh.calls()).toContain("issue create");
		expect(gh.calls()).toContain(TITLE);
		expect(gh.calls()).toContain(`--label ${LABEL}`);
		expect(gh.calls()).toContain("Overlap share in the 26–30-point band");
		expect(r.status).toBe(0);
	});

	it("files it when the top option's median band has halved", () => {
		const k = overlapsAt(N, 1);
		transcript([...times(k, NARROW_OVERLAP), ...times(N - k, NARROW_CLEAR)]);
		const gh = stubGh();
		const r = run(gh);
		expect(r.out).toContain("median top-option half-width ±3");
		expect(gh.calls()).toContain("issue create");
		expect(gh.calls()).toContain("Median top-option half-width is ±3");
		expect(gh.calls()).not.toContain("Overlap share in the");
		expect(r.status).toBe(0);
	});

	it("refreshes the one open issue rather than filing a second", () => {
		transcript(bandQuestions(N, overlapsAt(N, 0.3)));
		const gh = stubGh([{ number: 42, title: TITLE }]);
		const r = run(gh);
		expect(r.out).toContain("Refreshed #42.");
		expect(gh.calls()).not.toContain("issue create");
		expect(gh.bodyCalls()).toContain("replace 42");
		expect(r.status).toBe(0);
	});

	it("files nothing off a hand run's other window", () => {
		transcript(bandQuestions(N, overlapsAt(N, 0.3)));
		const gh = stubGh();
		const r = run(gh, ["--days", "7"]);
		expect(r.out).toContain("price bands have narrowed");
		expect(r.out).toContain("Not filed: --days 7");
		expect(gh.calls()).toBe("");
		expect(r.status).toBe(0);
	});

	it("reports a filing that fails without failing the run", () => {
		transcript(bandQuestions(N, overlapsAt(N, 0.3)));
		const failing = stubGhScript(sandbox, "", { failing: true });
		const r = run(failing);
		expect(r.out).toContain("Filing failed");
		expect(r.status).toBe(0);
	});
});

describe("too small a sample", () => {
	it("reports insufficient sample and files nothing, however low the reading", () => {
		const n = MIN_BAND_SAMPLE - 1;
		transcript(times(n, NARROW_CLEAR));
		const gh = stubGh();
		const r = run(gh);
		expect(r.out).toContain("insufficient sample");
		expect(gh.calls()).toBe("");
		expect(r.status).toBe(0);
	});
});

describe("what is read", () => {
	it("counts only assistant, non-sidechain records inside the window", () => {
		transcript(steady(N));
		transcript(times(5, WIDE_CLEAR), { sidechain: true });
		const old = transcript(times(5, WIDE_CLEAR), { ageDays: 20 });
		const s = Date.now() / 1000;
		fs.utimesSync(old, s, s); // a fresh mtime must not admit old records
		const r = run(stubGh());
		expect(r.out).toContain(`OK: ${N} rival question(s)`);
		expect(r.status).toBe(0);
	});

	it("leaves out a round whose options can be taken together", () => {
		transcript([
			...steady(N),
			...times(5, round([64, 57, 71], [36, 29, 43], "independent")),
		]);
		const r = run(stubGh());
		expect(r.out).toContain(`OK: ${N} rival question(s)`);
		expect(r.status).toBe(0);
	});

	it("reads every project under every seat, and a session copied to two seats once", () => {
		const other = path.join(sandbox, "seat", "projects", "-other-project");
		fs.mkdirSync(other);
		const file = transcript(steady(N), { dir: other });
		const seatB = path.join(sandbox, "seat-b", "projects", "-other-project");
		fs.mkdirSync(seatB, { recursive: true });
		fs.copyFileSync(file, path.join(seatB, path.basename(file)));
		const r = run(stubGh(), [], { B: path.join(sandbox, "seat-b") });
		expect(r.out).toContain(`OK: ${N} rival question(s)`);
		expect(r.status).toBe(0);
	});
});

describe("seats", () => {
	it("degrades quietly when a seat is absent", () => {
		transcript(steady(N));
		const r = run(stubGh(), [], { B: path.join(sandbox, "no-such-seat") });
		expect(r.out).toContain(`OK: ${N} rival question(s)`);
		expect(r.out).not.toContain("no-such-seat");
		expect(r.status).toBe(0);
	});

	it("is SKIP, never steady, when no seat can be read", () => {
		const gone = path.join(sandbox, "gone");
		const gh = stubGh();
		const r = run(gh, [], { A: gone, B: gone, C: gone });
		expect(r.out).toContain("SKIP");
		expect(r.out).toContain("not steady");
		expect(gh.calls()).toBe("");
		expect(r.status).toBe(0);
	});
});

describe("tops bunching at 70", () => {
	const T = MIN_TOP_SAMPLE + 20;

	it("files its own tracking issue when the share at 70 is over 1.5 times baseline", () => {
		transcript(topQuestions(T, atLineAt(T, 2)));
		const gh = stubGh();
		const r = run(gh);
		expect(r.out).toContain("top figures are bunching at 70");
		expect(r.out).toContain("Filed https://github.com/o/r/issues/999");
		expect(gh.calls()).toContain(TOP_TITLE);
		expect(gh.calls()).toContain(`--label ${LABEL}`);
		expect(gh.calls()).not.toContain(TITLE);
		expect(r.status).toBe(0);
	});

	it("files nothing at or below 1.5 times baseline", () => {
		transcript(topQuestions(T, atLineAt(T, 1.5)));
		const gh = stubGh();
		const r = run(gh);
		expect(r.out).toContain("OK: ");
		expect(r.out).toContain(`Top figures: ${T} priced top(s)`);
		expect(gh.calls()).toBe("");
		expect(r.status).toBe(0);
	});

	it("files nothing under the sample, however many sit at 70", () => {
		const n = MIN_TOP_SAMPLE - 1;
		transcript(topQuestions(n, n));
		const gh = stubGh();
		const r = run(gh);
		expect(r.out).toContain("Top figures: insufficient sample");
		expect(gh.calls()).toBe("");
		expect(r.status).toBe(0);
	});

	it.each([
		["yes/no", "yes/no"],
		["combinable", "independent"],
	])("counts a %s round at 70 toward the share", (_shape, relation) => {
		transcript(topQuestions(T, atLineAt(T, 2), relation));
		const gh = stubGh();
		run(gh);
		expect(gh.calls()).toContain(TOP_TITLE);
	});

	it("refreshes its open issue, and reports the band reading beside it", () => {
		transcript([...steady(N), ...topQuestions(T, atLineAt(N + T, 2))]);
		const gh = stubGh([{ number: 43, title: TOP_TITLE }]);
		const r = run(gh);
		expect(r.out).toContain("Refreshed #43.");
		expect(r.out).toContain(`${N} with a 26–30-point gap`);
		expect(gh.calls()).not.toContain("issue create");
		expect(r.status).toBe(0);
	});
});
