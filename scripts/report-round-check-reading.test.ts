// @vitest-environment node
/*
 * report-round-check-reading.test.ts — the reading of the under-researched-
 * round check (#1711, spec #1701, rulings #1684 and #1691). Break it and the reading
 * lands on the wrong day, pools a repo against another's baseline, judges a
 * failure line or the flip the wrong way, or files its issue early or twice.
 *
 * Each case builds a scratch home of three seats and three git-initialised
 * repos, writes a fixture baseline, transcripts and round-check logs into
 * them, and runs the script in-process with `gh` stubbed, because the real
 * corpus is machine-local and the real issue must never be filed by a test.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stubGhScript } from "./lib/gh-stub";
import { readLogs } from "./lib/log-reading";
import { MARKERS_REL } from "./lib/marker-root";
import { ROUND_CHECK_LOG } from "./lib/priced-options-limbs";
import { appendEvents, logPath } from "./lib/refusal-log";
import { runInProcess } from "./lib/run-in-process";
import { seatDirs } from "./lib/seat-testkit";

const SCRIPT = path.join(__dirname, "report-round-check-reading.js");
/* Restated so a rename fails here rather than passing unseen. */
const TITLE =
	"Round-check reading: has sending under-researched rounds back once cut the founder's send-backs?";
const FILED = ".round-check-reading-filed";
const DATA = "docs/data/round-sendbacks-2026-10-14";
/* Spelt whole, not off DATA, so the read-graph pass sees this test read it. */
const REAL_BASELINE = path.join(
	__dirname,
	"..",
	"docs/data/round-sendbacks-2026-10-14/rounds.json",
);

const DAY = 86_400_000;
const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-20T00:00:00Z");
const iso = (t: number) => new Date(t).toISOString();
const ACCEPT = "accept recommendations";

type Repo = "workflow-core" | "mantahostels" | "fantasy-books";
type Cls = "a" | "b" | "c" | "d" | "e" | "f";

let home: string;
let seats: string[];
let systmp: string;
let roots: Record<Repo, string>;

/** `n` baseline rows for one repo on one side of the 10-call line, `sent` of
 *  them classed (b), the rest (a). */
const rows = (repo: string, n: number, sent: number, tools: number) =>
	Array.from({ length: n }, (_, i) => ({
		repo,
		tools_before: tools,
		close: false,
		class: i < sent ? "b" : "a",
	}));

/* workflow-core 20% below 10 calls and 10% at 10 or more; mantahostels 50%
 * and 10%; fantasy-books has rows at 10 or more only. A close row and a (d)
 * row show which rows the rates leave out; the (d) row at 11 calls is the
 * one first draft of 71 at 10–12. */
const FIXTURE_BASELINE = {
	rows: [
		...rows("workflow-core", 20, 4, 3),
		...rows("workflow-core", 20, 2, 15),
		...rows("mantahostels", 10, 5, 3),
		...rows("mantahostels", 10, 1, 15),
		...rows("fantasy-books", 10, 1, 15),
		{ repo: "workflow-core", tools_before: 3, close: true, class: "b" },
		{ repo: "workflow-core", tools_before: 11, close: false, class: "d" },
	],
};

const writeBaseline = (data: unknown) => {
	fs.mkdirSync(path.join(roots["workflow-core"], DATA), { recursive: true });
	fs.writeFileSync(
		path.join(roots["workflow-core"], DATA, "rounds.json"),
		JSON.stringify(data),
	);
};

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "round-reading-"));
	seats = seatDirs(home);
	for (const s of seats)
		fs.mkdirSync(path.join(s, "projects"), { recursive: true });
	systmp = path.join(home, "systmp");
	fs.mkdirSync(systmp);
	roots = {
		"workflow-core": path.join(home, "repos", "workflow-core"),
		mantahostels: path.join(home, "repos", "mantahostels"),
		"fantasy-books": path.join(home, "repos", "fantasy-books"),
	};
	for (const r of Object.values(roots)) {
		fs.mkdirSync(r, { recursive: true });
		execFileSync("git", ["init", "-q", r]);
	}
	writeBaseline(FIXTURE_BASELINE);
	fs.mkdirSync(path.join(roots["workflow-core"], ".claude-plugin"));
	fs.writeFileSync(
		path.join(roots["workflow-core"], ".claude-plugin", "plugin.json"),
		JSON.stringify({ name: "workflow-core" }),
	);
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

/** A session's transcript under the repo's slug, founder replies at the
 *  given times. */
const session = (
	repo: Repo,
	id: string,
	replies: { at: number; text: string }[],
) => {
	const dir = path.join(
		seats[0],
		"projects",
		roots[repo].replace(/[/.]/g, "-"),
	);
	fs.mkdirSync(dir, { recursive: true });
	const cwd = roots[repo];
	const lines = [
		{
			type: "user",
			cwd,
			timestamp: iso(T0 - DAY),
			message: { role: "user", content: "start" },
			origin: { kind: "human" },
		},
		...replies.map((r) => ({
			type: "user",
			cwd,
			timestamp: iso(r.at),
			origin: { kind: "human" },
			message: { role: "user", content: r.text },
		})),
	];
	fs.writeFileSync(
		path.join(dir, `${id}.jsonl`),
		`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
	);
};

/** One round-check log line, through the guard's own writer. */
const log = (
	repo: Repo,
	at: number,
	sessionId: string,
	{
		kind,
		round = "1",
		...extra
	}: { kind: string; round?: string } & Record<string, unknown>,
) =>
	appendEvents(
		roots[repo],
		[{ at: iso(at), session: sessionId, round, kind, ...extra }],
		ROUND_CHECK_LOG,
	);

interface Spec {
	kind: "refused" | "cap" | "unrefused";
	start?: number;
	texts?: string[];
	calls?: number | null;
	sinceRefusal?: (i: number) => number;
	extra?: Record<string, unknown>;
	answered?: boolean;
}

/** Default tool calls before a round's first send, by kind. */
const DEFAULT_CALLS = { refused: 4, cap: 4, unrefused: 15 };

/** The log lines of round `i` sent at `at`. */
const logRound = (
	{ repo, id, i, at }: { repo: Repo; id: string; i: number; at: number },
	spec: Spec,
) => {
	const round = String(i + 1);
	const callsBefore = "calls" in spec ? spec.calls : DEFAULT_CALLS[spec.kind];
	if (spec.kind !== "refused") {
		log(repo, at, id, {
			kind: spec.kind === "cap" ? "passed-at-cap" : "passed-unrefused",
			round,
			callsBefore,
			slot: 3,
			...spec.extra,
		});
		return;
	}
	log(repo, at - 60_000, id, { kind: "refused", round, callsBefore, slot: 1 });
	const since = spec.sinceRefusal?.(i) ?? 3;
	log(repo, at, id, {
		kind: "passed-after-refusal",
		round,
		callsBefore,
		slot: 1,
		sinceRefusal: since,
		tools: new Array(since).fill("Read"),
		resent: true,
		...spec.extra,
	});
};

/** `n` rounds of one kind in their own session, the i-th sent at
 *  `start + i h` and, unless `answered` is false, replied to a minute later
 *  with `texts[i]` (a bare accept where none). Returns each reply's key. */
const rounds = (repo: Repo, id: string, n: number, spec: Spec) => {
	const { start = T0 + HOUR, texts = [], answered = true } = spec;
	const replies = [];
	const keys = [];
	for (let i = 0; i < n; i++) {
		const at = start + i * HOUR;
		logRound({ repo, id, i, at }, spec);
		if (answered) {
			replies.push({ at: at + 60_000, text: texts[i] ?? ACCEPT });
			keys.push(`${id}@${iso(at + 60_000)}`);
		}
	}
	session(repo, id, replies);
	return keys;
};

const run = (
	now: number,
	args: string[] = ["--dry-run"],
	host: Repo = "workflow-core",
	env: Record<string, string> = {},
) =>
	runInProcess(
		SCRIPT,
		[...args, ...seats.flatMap((s) => ["--config-dir", s])],
		{
			env: {
				...process.env,
				CLAUDE_PROJECT_DIR: roots[host],
				CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
				WFC_NOW: iso(now),
				TMPDIR: systmp,
				...env,
			},
		},
	);

/** A --classes file giving each key its class. */
const classesFile = (classes: Record<string, Cls | string>) => {
	const file = path.join(home, "classes.json");
	fs.writeFileSync(file, JSON.stringify(classes));
	return file;
};

/** A dry run's stdout at `now`, exit 0 asserted. */
const read = (now = T0 + 8 * DAY, classes?: Record<string, string>) => {
	const args = ["--dry-run"];
	if (classes) args.push("--classes", classesFile(classes));
	const r = run(now, args);
	expect(r.status, r.stderr).toBe(0);
	return r.stdout;
};

const REMEDY =
	/Correct the file named above.*then re-run `node scripts\/report-round-check-reading\.js --dry-run`/;

/** Each key classed `cls`. */
const all = (keys: string[], cls: Cls) =>
	Object.fromEntries(keys.map((k) => [k, cls]));

/** 40 bare-accepted refused-then-answered workflow-core rounds: a reached
 *  reading at T0 + 7 days, where every line holds. */
const healthy = () =>
	rounds("workflow-core", "wc-refused", 40, { kind: "refused" });

describe("where it runs", () => {
	it("SKIPs outside workflow-core, exit 0", () => {
		const r = run(T0, ["--dry-run"], "mantahostels");
		expect(r.status).toBe(0);
		expect(r.stderr).toMatch(/SKIP: .*workflow-core's alone/);
		expect(r.stdout).toBe("");
	});

	it("reads every repo the baseline has rows for, and says there is no reading point while none is live", () => {
		const out = read(T0);
		expect(out).toMatch(/Reading point: none yet — no repo is live/);
		for (const repo of ["fantasy-books", "mantahostels", "workflow-core"])
			expect(out).toContain(
				`- ${repo}: no transcript records its working directory`,
			);
	});

	it("is BROKEN, exit 2, on a log line that is not JSON, naming it", () => {
		healthy();
		session("mantahostels", "m1", []);
		fs.mkdirSync(path.dirname(logPath(roots.mantahostels, ROUND_CHECK_LOG)), {
			recursive: true,
		});
		fs.writeFileSync(
			logPath(roots.mantahostels, ROUND_CHECK_LOG),
			"{not json\n",
		);
		const r = run(T0 + DAY);
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(
			/BROKEN: .*mantahostels.*\.round-check-log\.jsonl:1 is not JSON/,
		);
		expect(r.stderr).toMatch(REMEDY);
	});

	it("is BROKEN, exit 2, naming the baseline where it will not read", () => {
		healthy();
		fs.rmSync(path.join(roots["workflow-core"], DATA), { recursive: true });
		const r = run(T0 + DAY);
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/BROKEN: .*rounds\.json/);
		expect(r.stderr).toMatch(REMEDY);
	});

	it("is BROKEN, exit 2, on a --classes file naming a class outside a-f", () => {
		const [key] = healthy();
		const r = run(T0 + 8 * DAY, [
			"--dry-run",
			"--classes",
			classesFile({ [key]: "z" }),
		]);
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/BROKEN: .*has class "z", not one of a-f/);
		expect(r.stderr).toMatch(REMEDY);
	});
});

describe("the reading point", () => {
	it("prints the figures so far before it, with the 21-day ceiling as the latest point", () => {
		rounds("workflow-core", "wc", 3, { kind: "refused" });
		const out = read(T0 + 2 * DAY);
		expect(out).toMatch(/Not reached at /);
		expect(out).toMatch(
			/Reading point: 2026-11-10 00:59 at the latest \(21 days after the first log line\)/,
		);
		expect(out).toMatch(/THIN: 3 refused-then-answered round\(s\)/);
	});

	it("is 7 days after the first log line where the 40th answer came sooner", () => {
		healthy();
		expect(read(T0 + 7 * DAY - 2 * 60_000)).toMatch(/Not reached/);
		const out = read(T0 + 7 * DAY + HOUR);
		expect(out).toMatch(
			/Reading point: 2026-10-27 00:59 — the later of 7 days after the first log line \(2026-10-20 00:59\) and the 40th refused-then-answered round/,
		);
		expect(out).toMatch(/Reached/);
		expect(out).not.toMatch(/THIN/);
	});

	it("is the 40th answer where it came after 7 days, the clock running from the first repo's first line", () => {
		rounds("mantahostels", "m-early", 1, { kind: "unrefused" });
		rounds("workflow-core", "wc", 40, { kind: "refused", start: T0 + 6 * DAY });
		const fortieth = iso(T0 + 6 * DAY + 39 * HOUR + 60_000)
			.slice(0, 16)
			.replace("T", " ");
		const out = read(T0 + 9 * DAY);
		expect(out).toContain(`Reading point: ${fortieth} — the later of 7 days`);
		expect(out).toContain("after the first log line (2026-10-20 01:00)");
	});

	it("is capped at 21 days, reading thin", () => {
		rounds("workflow-core", "wc", 5, { kind: "refused" });
		const out = read(T0 + 22 * DAY);
		expect(out).toMatch(/Reached: figures are read up to 2026-11-10 00:59/);
		expect(out).toMatch(/THIN: 5 refused-then-answered round\(s\)/);
	});

	it("counts nothing whose reply lands after a reached point", () => {
		healthy();
		rounds("workflow-core", "wc-late", 10, {
			kind: "cap",
			start: T0 + 8 * DAY,
		});
		const out = read(T0 + 10 * DAY);
		expect(out).toMatch(
			/4\. Cap: rounds let through at the cap of 3 sent back: nothing to rate/,
		);
	});
});

describe("matching each repo to its own baseline", () => {
	it("pools the repos that clear the bar against their own baselines weighted to the window's mix", () => {
		rounds("workflow-core", "wc", 30, { kind: "refused" });
		rounds("mantahostels", "m", 10, { kind: "refused" });
		const out = read();
		expect(out).toContain(
			"   - workflow-core: 30 round(s), 0 of 30 (0%); baseline 4 of 20 (20%)",
		);
		expect(out).toContain(
			"   - mantahostels: 10 round(s), 0 of 10 (0%); baseline 5 of 10 (50%)",
		);
		/* (30 × 20% + 10 × 50%) ÷ 40 = 27.5%, halved for the line. */
		expect(out).toContain(
			"Pooled over mantahostels, workflow-core: 0 of 40 (0%). Repo-matched baseline 27.5%; line at half, 13.8%: holds.",
		);
	});

	it("weights each repo's baseline by its replies (a)–(c), so a (d) reply moves neither the rate nor the baseline", () => {
		const wc = rounds("workflow-core", "wc", 30, { kind: "refused" });
		rounds("mantahostels", "m", 10, { kind: "refused" });
		/* (20 × 20% + 10 × 50%) ÷ 30 = 30.0%, halved for the line. */
		expect(read(T0 + 8 * DAY, all(wc.slice(0, 10), "d"))).toContain(
			"Pooled over mantahostels, workflow-core: 0 of 30 (0%). Repo-matched baseline 30.0%; line at half, 15.0%: holds.",
		);
	});

	it("names and keeps out a repo with no baseline rows on its side, and one with fewer than 10 rounds", () => {
		healthy();
		rounds("mantahostels", "m", 9, { kind: "refused" });
		rounds("fantasy-books", "f", 12, { kind: "refused" });
		const out = read();
		expect(out).toContain(
			"   - fantasy-books: kept out — 12 round(s), and no baseline rows below 10 calls",
		);
		expect(out).toContain(
			"   - mantahostels: kept out — 9 round(s), under the 10 a repo needs; baseline 5 of 10 (50%)",
		);
		expect(out).toContain(
			"Pooled over workflow-core: 0 of 40 (0%). Repo-matched baseline 20.0%",
		);
	});

	it("counts a round once whatever its questions, and none for a question left out of the passing send or with no count", () => {
		healthy();
		/* Two questions passing at one Stop make one round. */
		rounds("mantahostels", "m-two", 10, {
			kind: "unrefused",
			extra: { round: "2" },
		});
		for (let i = 0; i < 10; i++)
			log("mantahostels", T0 + HOUR + i * HOUR, "m-two", {
				kind: "passed-unrefused",
				round: "1",
				callsBefore: 15,
				slot: 0,
			});
		rounds("mantahostels", "m-left-out", 10, {
			kind: "refused",
			extra: { resent: false },
		});
		rounds("mantahostels", "m-null", 10, {
			kind: "unrefused",
			calls: null,
		});
		const out = read();
		expect(out).toContain(
			"   - mantahostels: 10 round(s), 0 of 10 (0%); baseline 1 of 10 (10%)",
		);
		expect(out).toContain(
			"   - mantahostels: kept out — 0 round(s), under the 10 a repo needs; baseline 5 of 10 (50%)",
		);
		expect(out).toContain(
			"   - fantasy-books: kept out — 0 round(s), and no baseline rows below 10 calls",
		);
	});

	it("reads the landed baseline's per-repo rates and its 10–12 first-draft share", () => {
		writeBaseline(JSON.parse(fs.readFileSync(REAL_BASELINE, "utf8")));
		healthy();
		const out = read();
		expect(out).toContain("baseline 14 of 102 (14%)");
		expect(out).toContain("Baseline, over answered rounds, 71 of 712 (10%)");
	});
});

describe("the four failure lines, each firing alone", () => {
	it("all hold on a healthy reading", () => {
		healthy();
		expect(read()).toMatch(/Fired: none\.\n/);
	});

	it("line 1 fires at half the repo-matched baseline, once its replies are classed", () => {
		const keys = healthy();
		/* 4 of 40 is 10%, half of workflow-core's 20%. */
		const out = read(undefined, all(keys.slice(0, 4), "b"));
		expect(out).toMatch(/line at half, 10\.0%: FIRES — re-put the mechanism/);
		expect(out).toMatch(/Fired: line 1\./);
		expect(read(undefined, all(keys.slice(0, 3), "c"))).toMatch(
			/line at half, 10\.0%: holds\./,
		);
	});

	it("line 1 is undecided while an unclassed reply could tip it, giving the rate's range", () => {
		healthy();
		rounds("workflow-core", "wc-more", 4, {
			kind: "refused",
			texts: new Array(4).fill("why not B?"),
		});
		const out = read();
		expect(out).toMatch(
			/0 of 40 classed, 4 to class: between 0\.0% and 9\.1%.*holds/,
		);
		rounds("workflow-core", "wc-more", 5, {
			kind: "refused",
			texts: new Array(5).fill("why not B?"),
		});
		expect(read()).toMatch(
			/between 0\.0% and 11\.1%.*undecided until the 5 listed replies are classified/,
		);
		expect(read()).toMatch(
			/r, the share of send-backs the limb removes: between 0\.\d\d and 1\.00 until the listed replies are classified\. Price of refusing every round, 10\.8 ÷ r refusals per send-back saved: from 10\.8 to \d+\.\d\./,
		);
	});

	it("line 2 fires at 25% of passing re-sends after 1–2 tool calls since the refusal", () => {
		rounds("workflow-core", "wc", 40, {
			kind: "refused",
			sinceRefusal: (i) => (i < 10 ? 1 + (i % 2) : 3),
		});
		const out = read();
		expect(out).toMatch(/2\. Gaming at the re-send: 10 of 40 \(25%\).*FIRES/);
		expect(out).toMatch(/Fired: line 2\./);
	});

	it("line 2 holds just under 25%", () => {
		rounds("workflow-core", "wc", 40, {
			kind: "refused",
			sinceRefusal: (i) => (i < 9 ? 2 : 3),
		});
		expect(read()).toMatch(/2\. Gaming at the re-send: 9 of 40 .*holds\./);
	});

	it("line 3 fires at 20% of first drafts at 10–12 tool calls", () => {
		healthy();
		rounds("workflow-core", "wc-pad", 10, {
			kind: "unrefused",
			calls: 12,
			answered: false,
		});
		const out = read();
		expect(out).toMatch(
			/3\. Gaming at the threshold: 10 of 50 \(20%\) not-close first drafts sat at 10–12 tool calls\. Baseline, over answered rounds, 1 of 71 \(1%\)\. Line 20\.0%: FIRES/,
		);
		expect(out).toMatch(/Fired: line 3\./);
	});

	it("line 3 counts no first draft at 13 calls", () => {
		healthy();
		rounds("workflow-core", "wc-pad", 10, {
			kind: "unrefused",
			calls: 13,
			answered: false,
		});
		expect(read()).toMatch(/3\. .*0 of 50 .*holds\./);
	});

	it("line 4 fires at 20% of rounds let through at the cap sent back, read from 10 such rounds", () => {
		healthy();
		const keys = rounds("workflow-core", "wc-cap", 10, { kind: "cap" });
		const out = read(undefined, all(keys.slice(0, 2), "c"));
		expect(out).toMatch(
			/4\. Cap: .*sent back: 2 of 10 \(20%\).*FIRES — re-put the cap/,
		);
		expect(out).toMatch(/Fired: line 4\./);
		expect(read(undefined, all(keys.slice(0, 1), "b"))).toMatch(
			/4\. Cap: .*1 of 10 .*: holds\./,
		);
	});

	it("line 4 is unread under 10 rounds at the cap", () => {
		healthy();
		const keys = rounds("workflow-core", "wc-cap", 9, { kind: "cap" });
		expect(read(undefined, all(keys, "b"))).toMatch(
			/4\. Cap: .*unread — 9 answered, under the 10 it is read from/,
		);
	});
});

describe("r and the flip", () => {
	it("reports r and 10.8 ÷ r, and puts the flip where the limb works and the rate at 10 or more calls is within its band", () => {
		const keys = healthy();
		const ten = rounds("workflow-core", "wc-ten", 20, { kind: "unrefused" });
		/* 2 of 40 against 20%: r = 0.75, price 14.4. 2 of 20 at 10+: on its 10%. */
		const out = read(undefined, {
			...all(keys.slice(0, 2), "b"),
			...all(ten.slice(0, 2), "b"),
		});
		expect(out).toContain(
			"r, the share of send-backs the limb removes: 0.75. Price of refusing every round: 10.8 ÷ r = 14.4 refusals per send-back saved.",
		);
		expect(out).toMatch(/band 0\.0%–23\.1% at 20 rounds\. Flip: PUT/);
	});

	it("does not put the flip where the rate at 10 or more calls leaves its band", () => {
		healthy();
		const ten = rounds("workflow-core", "wc-ten", 20, { kind: "unrefused" });
		expect(read(undefined, all(ten.slice(0, 10), "b"))).toMatch(
			/Flip: not put — the rate at 10 or more calls is outside its band/,
		);
	});

	it("does not put the flip where the limb is not working", () => {
		const keys = healthy();
		const ten = rounds("workflow-core", "wc-ten", 20, { kind: "unrefused" });
		expect(
			read(undefined, {
				...all(keys.slice(0, 8), "b"),
				...all(ten.slice(0, 2), "b"),
			}),
		).toMatch(/Flip: not put — the limb is not working \(line 1\)/);
	});

	it("leaves the flip undecided while a reply at 10 or more calls is unclassed", () => {
		healthy();
		rounds("workflow-core", "wc-ten", 20, {
			kind: "unrefused",
			texts: ["go with B, but why is A here?"],
		});
		const out = read();
		expect(out).toMatch(/r, the share of send-backs the limb removes: 1\.00\./);
		expect(out).toMatch(
			/Flip: undecided until the listed replies are classified, which sets the band\./,
		);
	});
});

describe("classing", () => {
	it("classes a bare accept (a) and lists every other counted reply, keyed for --classes", () => {
		const keys = rounds("workflow-core", "wc", 40, {
			kind: "refused",
			texts: [
				"Accept recommendation.",
				"  ACCEPT RECOMMENDATIONS ",
				"accept (A)",
				"accept recommendations, but check B",
			],
		});
		const out = read();
		expect(out).toMatch(/0 of 38 classed, 2 to class/);
		expect(out).toContain(
			`  - ${keys[2]} workflow-core (refused-then-answered, 4 calls before): "accept (A)"`,
		);
		expect(out).toContain(`  - ${keys[3]} workflow-core`);
		expect(out).not.toContain(`  - ${keys[0]} `);
		expect(out).not.toContain(`  - ${keys[1]} `);
	});

	it("takes each line's repo from its writer, as the close reporter's read does (#1751)", () => {
		const keys = rounds("workflow-core", "wc", 10, {
			kind: "refused",
			texts: ["why?"],
		});
		const file = logPath(roots["workflow-core"], ROUND_CHECK_LOG);
		fs.writeFileSync(
			file,
			fs
				.readFileSync(file, "utf8")
				.replaceAll('"repo":"workflow-core"', '"repo":"mantahostels"'),
		);
		/* The close reporter's whole read of a log, so both reporters name it. */
		const { events } = readLogs(
			new Map([["workflow-core", roots["workflow-core"]]]),
			(r: string) => logPath(r, ROUND_CHECK_LOG),
		);
		expect(new Set(events.map((e) => (e as { repo?: string }).repo))).toEqual(
			new Set(["mantahostels"]),
		);
		expect(read()).toContain(`  - ${keys[0]} mantahostels (`);
	});

	it("leaves (d)–(f) out of the rate and drops a classed reply from the list", () => {
		const keys = healthy();
		const out = read(undefined, {
			[keys[0]]: "d",
			[keys[1]]: "f",
			[keys[2]]: "b",
		});
		expect(out).toContain("Pooled over workflow-core: 1 of 38 (3%)");
		expect(out).not.toMatch(/To class/);
	});

	it("does not list a reply in a repo kept out of every pool, and says how many", () => {
		healthy();
		rounds("mantahostels", "m", 3, { kind: "refused", texts: ["why?"] });
		expect(read()).not.toMatch(/To class/);
		rounds("workflow-core", "wc-x", 1, { kind: "cap", texts: ["why?"] });
		expect(read()).toMatch(
			/keyed for --classes; 1 more in repos kept out of a pool are not listed/,
		);
	});
});

describe("filing the reading", () => {
	let argvLog: string;
	let issues: string;
	let gh: Record<string, string>;
	const filedRecord = () =>
		path.join(roots["workflow-core"], MARKERS_REL, FILED);
	const ghCalls = () =>
		fs.existsSync(argvLog) ? fs.readFileSync(argvLog, "utf8") : "";

	beforeEach(() => {
		argvLog = path.join(home, "gh-argv.log");
		issues = path.join(home, "issues.json");
		fs.writeFileSync(issues, "[]");
		gh = stubGhScript(
			home,
			[
				"#!/bin/sh",
				`printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}`,
				'if [ "$1" = "issue" ] && [ "$2" = "list" ]; then',
				`  cat ${JSON.stringify(issues)}`,
				'elif [ "$1" = "issue" ] && [ "$2" = "create" ]; then',
				"  echo https://github.com/o/r/issues/999",
				"fi",
			].join("\n"),
		).env;
	});

	const file = (now = T0 + 8 * DAY, args: string[] = []) =>
		run(now, args, "workflow-core", gh);

	it("files nothing, and calls gh not at all, before the reading point", () => {
		healthy();
		const r = file(T0 + 2 * DAY);
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/Not reached/);
		expect(ghCalls()).toBe("");
		expect(fs.existsSync(filedRecord())).toBe(false);
	});

	it("files one takes:wayfinder issue at the reading point, carrying the figures, the replies to class as a task and the rulings", () => {
		healthy();
		rounds("workflow-core", "wc-cap", 1, { kind: "cap", texts: ["why?"] });
		const r = file();
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(
			/Filed https:\/\/github\.com\/o\/r\/issues\/999\./,
		);
		const calls = ghCalls();
		expect(calls).toContain(
			`issue create --title ${TITLE} --label takes:wayfinder --body`,
		);
		expect(calls).toMatch(/spec #1701; rulings #1684 and #1691/);
		expect(calls).toMatch(/1\. Refusal not working/);
		expect(calls).toMatch(/Fired: none\./);
		expect(calls).toMatch(/To class — /);
		expect(calls).toMatch(/--dry-run --classes <file>/);
		expect(fs.readFileSync(filedRecord(), "utf8")).toBe(
			"https://github.com/o/r/issues/999",
		);
	});

	it("never files a second time, and calls gh not at all, once it has filed", () => {
		healthy();
		expect(file().status).toBe(0);
		fs.rmSync(argvLog);
		const r = file(T0 + 9 * DAY);
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(
			/filed as https:\/\/github\.com\/o\/r\/issues\/999; nothing to do/,
		);
		expect(ghCalls()).toBe("");
	});

	it("files nothing where its issue already exists, closed, and records it", () => {
		healthy();
		fs.writeFileSync(
			issues,
			JSON.stringify([
				{ number: 7, title: TITLE, state: "CLOSED", labels: [] },
			]),
		);
		const r = file();
		expect(r.stdout).toMatch(/Already filed as #7; nothing filed\./);
		expect(ghCalls()).not.toContain("issue create");
		expect(fs.readFileSync(filedRecord(), "utf8")).toBe("#7");
	});

	it("files nothing on --dry-run at the reading point, and says a plain run would", () => {
		healthy();
		const r = file(T0 + 8 * DAY, ["--dry-run"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`a plain run files this as "${TITLE}"`);
		expect(ghCalls()).toBe("");
	});
});
