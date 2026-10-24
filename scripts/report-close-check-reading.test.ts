// @vitest-environment node
/*
 * report-close-check-reading.test.ts — the week-one close-check reading
 * (#1103, #1104, spec #1091). Break it and the reading lands on the wrong
 * day, counts the founder's replies wrongly, judges a failure line the wrong
 * way, or files its issue early or twice.
 *
 * Each case builds a scratch home of three seats and four adopter checkouts
 * (git-initialised, each carrying a workflow-core config), writes transcripts
 * and close-check logs into them, and runs the
 * script in-process with `gh` stubbed, because the real corpus is
 * machine-local and the real issue must never be filed by a test.
 *
 * It runs detached at every session start (`sweep-debts-detached.sh`), so a
 * regression files a wrong or duplicate GitHub issue unattended.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stubGhScript } from "./lib/gh-stub";
import { minute } from "./lib/log-reading";
import { MARKERS_REL } from "./lib/marker-root";
import { CLOSE_CHECK_LOG } from "./lib/priced-options-limbs";
import { appendEvents, logPath } from "./lib/refusal-log";
import { runInProcess } from "./lib/run-in-process";
import { seatDirs } from "./lib/seat-testkit";

const SCRIPT = path.join(__dirname, "report-close-check-reading.js");
/* The issue title and the marker file the script names, restated so a rename
 * fails here rather than passing unseen. */
const TITLE =
	"Close-check reading: has refusing close questions once stopped the separation prompts?";
const FILED = ".close-check-reading-filed";
const DATA = "docs/data/close-rounds-2026-10-09";
/* Spelt whole, not off DATA, so the read-graph pass sees this test read them. */
const PROMPTS = path.join(
	__dirname,
	"..",
	"docs/data/close-rounds-2026-10-09/separation-prompts.json",
);
const BASELINE = path.join(
	__dirname,
	"..",
	"docs/data/close-rounds-2026-10-09/answered-close-rounds.json",
);

const DAY = 86_400_000;
const T0 = Date.parse("2026-10-10T00:00:00Z");
const iso = (t: number) => new Date(t).toISOString();
const STOCK = "Close call — are there further checks or research you can do?";
const PAIR = {
	top: { letter: "A", figure: 55, low: 40, high: 70 },
	runnerUp: { letter: "B", figure: 45, low: 30, high: 60 },
};
const UNREAD_AT_CEILING =
	/Unread: design-vault, fantasy-books had no close-check log line by the 21-day ceiling/;

type Kind = import("./lib/close-check-log").Kind;
type Repo = "workflow-core" | "mantahostels" | "fantasy-books" | "design-vault";

let home: string;
let seats: string[];
let systmp: string;
let roots: Record<Repo, string>;

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "close-reading-"));
	seats = seatDirs(home);
	for (const s of seats)
		fs.mkdirSync(path.join(s, "projects"), { recursive: true });
	systmp = path.join(home, "systmp");
	fs.mkdirSync(systmp);
	roots = {
		"workflow-core": path.join(home, "workflow-core"),
		mantahostels: path.join(home, "mantahostels"),
		"fantasy-books": path.join(home, "fantasy-books"),
		"design-vault": path.join(home, "design-vault"),
	};
	for (const [name, r] of Object.entries(roots)) {
		fs.mkdirSync(path.join(r, ".claude"), { recursive: true });
		execFileSync("git", ["init", "-q", r]);
		/* fantasy-books opts out of away mode, and is read all the same. */
		fs.writeFileSync(
			path.join(r, ".claude", "workflow-core.json"),
			JSON.stringify({
				contract: 1,
				...(name === "fantasy-books" ? { refillLoop: false } : {}),
			}),
		);
	}
	fs.mkdirSync(path.join(roots["workflow-core"], DATA), { recursive: true });
	fs.copyFileSync(
		BASELINE,
		path.join(roots["workflow-core"], DATA, "answered-close-rounds.json"),
	);
	fs.mkdirSync(path.join(roots["workflow-core"], ".claude-plugin"));
	fs.writeFileSync(
		path.join(roots["workflow-core"], ".claude-plugin", "plugin.json"),
		JSON.stringify({ name: "workflow-core" }),
	);
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

/** A session's transcript, under the repo's slug on seat `seat`, its records
 *  stamped with the repo's root as cwd. Founder replies at the given times. */
const session = (
	repo: Repo,
	id: string,
	replies: { at: number; text: string }[],
	seat = 0,
) => {
	const dir = path.join(
		seats[seat],
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

/** One close-check event, through the guard's own writer. */
const log = (
	repo: Repo,
	at: number,
	sessionId: string,
	{
		kind,
		round = "1",
		...extra
	}: { kind: Kind; round?: string } & Record<string, unknown>,
) =>
	appendEvents(
		roots[repo],
		[{ at: iso(at), session: sessionId, round, kind, pair: null, ...extra }],
		CLOSE_CHECK_LOG,
	);

/** Every repo live at T0, so the clock starts there. */
const allLive = () => {
	for (const repo of Object.keys(roots) as Repo[]) {
		log(repo, T0, `live-${repo}`, { kind: "refused", slot: 1 });
		session(repo, `live-${repo}`, []);
	}
};

/** `n` refused-then-answered questions in one workflow-core session, the
 *  i-th passing at `start + i h` and answered a minute later. */
const answered = (
	n: number,
	start: number,
	text = "accept (A)",
	id = "s-many",
) => {
	const replies = [];
	for (let i = 0; i < n; i++) {
		const at = start + i * 3_600_000;
		log("workflow-core", at, id, {
			kind: "passed-after-refusal",
			toolCalls: 2,
			pair: PAIR,
			stillClose: true,
			round: String(i + 1),
		});
		replies.push({ at: at + 60_000, text });
	}
	session("workflow-core", id, replies);
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
				HOME: home,
				WFC_NOW: iso(now),
				TMPDIR: systmp,
				...env,
			},
		},
	);

/** A normal run's stdout, its exit 0 asserted. */
const read = (now: number) => {
	const r = run(now);
	expect(r.status).toBe(0);
	return r.stdout;
};

/** Which of `texts` the reading counts as the stock prompt: each answers its
 *  own refused question, and a reply the reading does not list to classify is
 *  one it counted in the stock floor. */
const stockOf = (texts: string[]) => {
	allLive();
	const replies = texts.map((text, i) => {
		const at = T0 + DAY + i * 3_600_000;
		log("workflow-core", at, "s-texts", {
			kind: "passed-after-refusal",
			toolCalls: 2,
			pair: PAIR,
			stillClose: true,
			round: String(i + 1),
		});
		return { at: at + 60_000, text };
	});
	session("workflow-core", "s-texts", replies);
	const out = read(T0 + 3 * DAY);
	const stock = texts.filter((t) => !out.includes(`: ${JSON.stringify(t)}`));
	expect(out).toContain(`stock floor ${stock.length} of ${texts.length} `);
	return stock;
};

describe("the stock prompt", () => {
	it("is counted for the baseline's 23 stock prompts and none of its 8 others (#1096)", () => {
		const rows: { text: string; stock: boolean }[] = JSON.parse(
			fs.readFileSync(PROMPTS, "utf8"),
		).rows;
		const stock = rows.filter((r) => r.stock).map((r) => r.text);
		expect([stock.length, rows.length - stock.length]).toEqual([23, 8]);
		expect(stockOf(rows.map((r) => r.text))).toEqual(stock);
	});

	it("is counted whatever the case and whatever punctuation splits the words", () => {
		expect(
			stockOf([
				"ANY  research, or checks?",
				"further checks/research?",
				"further checks - or - research",
			]),
		).toEqual(["ANY  research, or checks?", "further checks - or - research"]);
	});

	it("is counted where he asks whether there are really no checks, never where a reply opens by turning them down", () => {
		expect(
			stockOf([
				"Are there really no checks or research?",
				"Are there really no more checks or research?",
				"No more checks or research — go with A",
				"no further research and checks, A",
			]),
		).toEqual([
			"Are there really no checks or research?",
			"Are there really no more checks or research?",
		]);
	});
});

describe("where it runs", () => {
	it("SKIPs in an adopter, exit 0", () => {
		const r = run(T0, ["--dry-run"], "mantahostels");
		expect(r.status).toBe(0);
		expect(r.stderr).toMatch(/SKIP: .*workflow-core's alone/);
		expect(r.stdout).toBe("");
	});

	it("says there is no reading point while no repo is live", () => {
		const out = read(T0);
		expect(out).toMatch(/Reading point: none yet — no repo is live/);
		expect(out).toMatch(/workflow-core: no close-check log line yet/);
	});

	it("refuses an undeclared flag, exit 2, naming it", () => {
		const r = run(T0, ["--bogus"]);
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/unknown flag: --bogus/);
	});

	it("is BROKEN, exit 2, on a log line that is not JSON, naming it", () => {
		allLive();
		session("workflow-core", "s1", []);
		fs.appendFileSync(
			logPath(roots.mantahostels, CLOSE_CHECK_LOG),
			"{not json\n",
		);
		session("mantahostels", "s2", []);
		const r = run(T0 + DAY);
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(
			/BROKEN: .*mantahostels.*\.close-check-log\.jsonl:2 is not JSON/,
		);
	});
});

describe("an unreadable baseline", () => {
	it("is BROKEN, exit 2, naming the file", () => {
		allLive();
		fs.rmSync(path.join(roots["workflow-core"], DATA), { recursive: true });
		const r = run(T0 + DAY);
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/BROKEN: .*answered-close-rounds\.json/);
	});
});

describe("the reading point", () => {
	it("prints the figures so far before it, with the ceiling as the latest point and the repos not yet live", () => {
		log("workflow-core", T0, "s1", { kind: "refused", slot: 1 });
		session("workflow-core", "s1", []);
		session("mantahostels", "s2", []);
		const out = read(T0 + DAY);
		expect(out).toMatch(/workflow-core: live since 2026-10-10 00:00/);
		expect(out).toMatch(/mantahostels: no close-check log line yet/);
		expect(out).toMatch(/Reading point: 2026-10-31 00:00 at the latest/);
		expect(out).toMatch(/Not reached at 2026-10-11 00:00: figures so far/);
		expect(out).not.toMatch(/Unread:/);
	});

	it("is 7 days after the clock where the 40th answer came sooner", () => {
		allLive();
		answered(40, T0 + DAY);
		const out = read(T0 + 8 * DAY);
		expect(out).toMatch(
			/Reading point: 2026-10-17 00:00 — the later of 7 days after 2026-10-10 00:00/,
		);
		expect(out).toMatch(/Reached: figures are read up to 2026-10-17 00:00/);
		expect(out).not.toMatch(/THIN/);
	});

	it("is the 40th answer where it came after 7 days", () => {
		allLive();
		answered(40, T0 + 6 * DAY);
		// The 40th passes at +6d+39h and is answered a minute later.
		const out = read(T0 + 9 * DAY);
		expect(out).toMatch(/Reading point: 2026-10-17 15:01 — the later of/);
		expect(out).toMatch(/Reached/);
	});

	it("runs the clock from the FIRST repo to go live, a later one not moving it, and counts the late repo's events (#2115)", () => {
		log("workflow-core", T0, "a", { kind: "refused", slot: 1 });
		log("mantahostels", T0, "b", { kind: "refused", slot: 1 });
		log("fantasy-books", T0 + 3 * DAY, "c", { kind: "refused", slot: 3 });
		session("mantahostels", "b", []);
		session("fantasy-books", "c", []);
		answered(40, T0 + DAY);
		const out = read(T0 + 12 * DAY);
		expect(out).toMatch(
			/Reading point: 2026-10-17 00:00 — the later of 7 days after 2026-10-10 00:00/,
		);
		expect(out).toMatch(/fantasy-books: live since 2026-10-13 00:00/);
		expect(out).toMatch(/3\. Cap spent: 1 of 3 \(33%\)/);
	});

	it("is capped at 21 days, reading thin and naming a repo that never went live", () => {
		log("workflow-core", T0, "a", { kind: "refused", slot: 1 });
		log("mantahostels", T0, "b", { kind: "refused", slot: 1 });
		session("mantahostels", "b", []);
		session("fantasy-books", "c", []);
		answered(3, T0 + DAY);
		const before = read(T0 + 20 * DAY);
		expect(before).toMatch(/Not reached/);
		expect(before).not.toMatch(/Unread:/);
		const out = read(T0 + 22 * DAY);
		expect(out).toMatch(
			/\nReading point: 2026-10-31 00:00 at the latest[^\n]*\nReached: figures are read up to 2026-10-31 00:00\.\nUnread: /,
		);
		expect(out).toMatch(UNREAD_AT_CEILING);
		expect(out).toMatch(
			/THIN: 3 refused-then-answered question\(s\), under the 40 a reading needs for a band of about ±14 points about the baseline\./,
		);
	});

	it("names a repo unread whose first log line came after the 21-day ceiling", () => {
		log("workflow-core", T0, "a", { kind: "refused", slot: 1 });
		log("mantahostels", T0, "b", { kind: "refused", slot: 1 });
		log("fantasy-books", T0 + 22 * DAY, "c", { kind: "refused", slot: 1 });
		session("workflow-core", "a", []);
		session("mantahostels", "b", []);
		session("fantasy-books", "c", []);
		expect(read(T0 + 23 * DAY)).toMatch(UNREAD_AT_CEILING);
	});

	it("counts nothing that lands after a reached point", () => {
		allLive();
		answered(40, T0 + DAY);
		log("workflow-core", T0 + 9 * DAY, "late", { kind: "refused", slot: 3 });
		session("workflow-core", "late", []);
		const out = read(T0 + 10 * DAY);
		expect(out).toMatch(/3\. Cap spent: 0 of 4 \(0%\)/);
	});
});

describe("the repos it reads (#2121)", () => {
	it("counts a fourth adopter's events and gives it a live since line", () => {
		allLive();
		log("design-vault", T0 + DAY, "dv", {
			kind: "passed-after-refusal",
			toolCalls: 2,
			pair: PAIR,
			stillClose: true,
		});
		session("design-vault", "dv", [{ at: T0 + DAY + 60_000, text: STOCK }]);
		const out = read(T0 + 3 * DAY);
		expect(out).toMatch(/- design-vault: live since 2026-10-10 00:00/);
		expect(out).toMatch(/stock floor 1 of 1 /);
	});
});

describe("the four figures", () => {
	it("line 1 fires at 30% untooled re-sends, and holds below, never counting a question left out of the passing send", () => {
		allLive();
		log("workflow-core", T0 + 1, "u", {
			kind: "passed-after-refusal",
			toolCalls: 0,
			stillClose: false,
		});
		log("workflow-core", T0 + 2, "u", {
			kind: "passed-after-refusal",
			toolCalls: 0,
			stillClose: false,
			round: "2",
		});
		log("workflow-core", T0 + 3, "u", {
			kind: "passed-after-refusal",
			toolCalls: 4,
			stillClose: true,
			round: "3",
		});
		log("workflow-core", T0 + 4, "u", {
			kind: "passed-after-refusal",
			toolCalls: null,
			stillClose: true,
			round: "4",
		});
		// Left out of the passing send: not a re-send.
		log("workflow-core", T0 + 4, "u", {
			kind: "passed-after-refusal",
			toolCalls: 0,
			stillClose: null,
			round: "5",
		});
		session("workflow-core", "u", []);
		const out = read(T0 + DAY);
		expect(out).toMatch(
			/1\. Untooled re-sends: 2 of 3 \(67%\) .* \(1 more with no count\)\. Baseline 0 of 9 .* Line 30%: FIRES — re-put the refuse-once trigger \(#1061\)/,
		);

		fs.rmSync(logPath(roots["workflow-core"], CLOSE_CHECK_LOG));
		allLive();
		log("workflow-core", T0 + 1, "u", {
			kind: "passed-after-refusal",
			toolCalls: 1,
			stillClose: false,
		});
		expect(read(T0 + DAY)).toMatch(
			/1\. Untooled re-sends: 0 of 1 \(0%\).*Line 30%: holds/,
		);
	});

	it("counts a question left out of the passing send as answered in line 2, listing its reply with the pair it was refused at", () => {
		allLive();
		log("workflow-core", T0 + DAY, "d", {
			kind: "passed-after-refusal",
			toolCalls: 0,
			stillClose: null,
			refusedPair: PAIR,
		});
		log("workflow-core", T0 + DAY, "d", {
			kind: "passed-after-refusal",
			toolCalls: 2,
			stillClose: true,
			pair: PAIR,
			round: "2",
		});
		session("workflow-core", "d", [
			{ at: T0 + DAY + 60_000, text: "pick (A) on Q1" },
		]);
		const out = read(T0 + 2 * DAY);
		expect(out).toMatch(/1\. Untooled re-sends: 0 of 1 \(0%\)/);
		expect(out).toMatch(/stock floor 0 of 2 \(0%\) refused-then-answered/);
		expect(out).toMatch(
			/workflow-core d Q1 \(passed-after-refusal, \(A\) 55% \(40% - 70%\) against \(B\) 45% \(30% - 60%\)\), reply/,
		);
	});

	it("line 2 fires on the stock floor alone, with the baseline shown", () => {
		allLive();
		answered(5, T0 + DAY, STOCK);
		const out = read(T0 + 2 * DAY);
		expect(out).toMatch(
			/2\. Separation-prompt rate: stock floor 5 of 5 \(100%\) .* Baseline 26 of 82 \(32%\) close rounds\. Line 16%: FIRES on the stock floor alone — re-put the mechanism question/,
		);
		expect(out).not.toMatch(/To classify/);
	});

	it("line 2 is undecided where the floor holds, naming how many listed replies would fire it and each with its session and question", () => {
		allLive();
		answered(9, T0 + DAY, "can you dig further before I pick?");
		session("workflow-core", "s-b", [
			{ at: T0 + 3 * DAY + 60_000, text: STOCK },
		]);
		log("workflow-core", T0 + 3 * DAY, "s-b", {
			kind: "passed-after-refusal",
			toolCalls: 1,
		});
		const out = read(T0 + 4 * DAY);
		// 10 answered, 1 stock: the line needs 2.
		expect(out).toMatch(
			/stock floor 1 of 10 \(10%\).*Line 16%: undecided — fires if 1 of the 9 listed repl\(ies\) are prompts/,
		);
		expect(out).toMatch(/To classify/);
		expect(out).toMatch(
			/workflow-core s-many Q2 \(passed-after-refusal, \(A\) 55% \(40% - 70%\) against \(B\) 45% \(30% - 60%\)\), reply 2026-10-11T01:01:00\.000Z: "can you dig further before I pick\?"/,
		);
		expect(out).not.toMatch(/s-b Q1/);
	});

	it("line 2 says nothing is answered yet rather than holding on no data", () => {
		allLive();
		expect(read(T0 + DAY)).toMatch(
			/stock floor 0 of 0 refused-then-answered questions\. .*Line 16%: nothing answered yet/,
		);
	});

	it("line 3 fires at 10% of refused sessions reaching cap slot 3, and holds below", () => {
		allLive();
		log("workflow-core", T0 + 1, "c", { kind: "refused", slot: 1 });
		log("workflow-core", T0 + 2, "c", { kind: "refused", slot: 2, round: "2" });
		log("workflow-core", T0 + 3, "c", {
			kind: "refused-reprice",
			slot: 3,
			round: "3",
		});
		session("workflow-core", "c", []);
		const out = read(T0 + DAY);
		// The four live-* sessions and "c": 1 of 5.
		expect(out).toMatch(
			/3\. Cap spent: 1 of 5 \(20%\) .* Line 10%: FIRES — re-put the ceiling ruling \(#1067\)/,
		);
	});

	it("line 3 holds with no session at slot 3", () => {
		allLive();
		expect(read(T0 + DAY)).toMatch(
			/3\. Cap spent: 0 of 4 \(0%\).*Line 10%: holds/,
		);
	});

	it("line 4 fires at two 4th questions drawing a stock prompt, and holds at one", () => {
		allLive();
		log("workflow-core", T0 + 1000, "p", { kind: "passed-at-cap" });
		log("workflow-core", T0 + 3 * 60_000, "p", {
			kind: "passed-at-cap",
			round: "5",
		});
		session("workflow-core", "p", [
			{ at: T0 + 60_000, text: STOCK },
			{ at: T0 + 4 * 60_000, text: STOCK },
		]);
		expect(read(T0 + DAY)).toMatch(
			/4\. Harmful 4th questions: 2 passed-at-cap question\(s\) drew a stock prompt, of 2 answered \(2 passed at cap\)\. No baseline\. Line 2: FIRES on the stock floor alone — raise the cap of 3 \(#1067\)/,
		);

		session("workflow-core", "p", [
			{ at: T0 + 60_000, text: STOCK },
			{ at: T0 + 4 * 60_000, text: "fine, go" },
		]);
		const out = read(T0 + DAY);
		expect(out).toMatch(
			/4\. Harmful 4th questions: 1 .*Line 2: undecided — fires if 1 of the 1 listed/,
		);
		expect(out).toMatch(
			/workflow-core p Q5 \(passed-at-cap\), reply .*: "fine, go"/,
		);
	});

	it("line 4 holds where no 4th question drew a reply that could be a prompt", () => {
		allLive();
		log("workflow-core", T0 + 1000, "q", { kind: "passed-at-cap" });
		session("workflow-core", "q", []);
		expect(read(T0 + DAY)).toMatch(
			/4\. Harmful 4th questions: 0 passed-at-cap question\(s\) drew a stock prompt, of 0 answered \(1 passed at cap\)\. No baseline\. Line 2: holds/,
		);
	});

	it("counts one reply once where the session overtook its earlier question before he spoke", () => {
		allLive();
		log("workflow-core", T0 + 1000, "o", {
			kind: "passed-after-refusal",
			toolCalls: 1,
		});
		log("workflow-core", T0 + 2000, "o", {
			kind: "passed-after-refusal",
			toolCalls: 1,
		});
		session("workflow-core", "o", [{ at: T0 + 60_000, text: STOCK }]);
		expect(read(T0 + DAY)).toMatch(/stock floor 1 of 1 \(100%\)/);
	});

	it("leaves a question unanswered where its session's transcript is not on the machine, and says so", () => {
		allLive();
		log("workflow-core", T0 + 1000, "gone", {
			kind: "passed-after-refusal",
			toolCalls: 1,
		});
		session("workflow-core", "other", []);
		const out = read(T0 + DAY);
		expect(out).toMatch(
			/1 session\(s\)' transcript is not on this machine or will not read/,
		);
		expect(out).toMatch(/THIN: 0 refused-then-answered/);
	});

	it("reads a session whose transcript sits on another seat", () => {
		allLive();
		log("workflow-core", T0 + 1000, "far", {
			kind: "passed-after-refusal",
			toolCalls: 1,
		});
		session("workflow-core", "far", [{ at: T0 + 60_000, text: STOCK }], 2);
		expect(read(T0 + DAY)).toMatch(/stock floor 1 of 1/);
	});
});

describe("the research ladder (#2010)", () => {
	const L0 = T0 + 10 * DAY;
	const All = { rulings: 1, web: 2, subagent: 1 };
	const stillClose = (
		id: string,
		at: number,
		reply: string,
		extra: Record<string, unknown> = {},
	) => {
		log("workflow-core", at, id, {
			kind: "passed-after-refusal",
			toolCalls: 4,
			pair: PAIR,
			stillClose: true,
			rungs: All,
			flipped: false,
			citesNewFact: false,
			...extra,
		});
		session("workflow-core", id, [{ at: at + 60_000, text: reply }]);
	};
	const ladder = (out: string) =>
		out.slice(out.indexOf("Research ladder")).split("\n");

	it("says so while nothing is logged on it", () => {
		allLive();
		answered(1, T0 + DAY);
		expect(read(T0 + 2 * DAY)).toContain(
			"Research ladder (#2010): nothing logged on it yet.",
		);
	});

	it("shows its refusals, the rungs each still-caught pass tried, its flips and new citations", () => {
		allLive();
		log("workflow-core", L0, "a", {
			kind: "refused-ladder",
			slot: 1,
			missing: ["web"],
		});
		log("workflow-core", L0 + 1, "a", {
			kind: "refused-ladder",
			slot: 2,
			missing: ["web"],
		});
		stillClose("a", L0 + 2, "accept (A)", {
			rungs: { rulings: 1, web: 0, subagent: 3 },
			missing: ["web"],
		});
		stillClose("b", L0 + 3, "accept (B)", {
			flipped: true,
			citesNewFact: true,
		});
		stillClose("c", L0 + 4, "accept (A)", { rungs: null, flipped: true });
		log("workflow-core", L0 + 5, "d", {
			kind: "passed-after-refusal",
			stillClose: false,
			rungs: { rulings: 0, web: 0, subagent: 0 },
			flipped: false,
			citesNewFact: true,
		});
		// Left out of its passing send: not a re-send.
		log("workflow-core", L0 + 6, "e", {
			kind: "passed-after-refusal",
			stillClose: null,
			rungs: All,
			flipped: null,
			citesNewFact: null,
		});
		const lines = ladder(read(L0 + DAY));
		expect(lines[0]).toBe(
			`Research ladder (#2006, #2010), read from ${minute(L0)} for 14 days: figures so far at ${minute(L0 + DAY)}.`,
		);
		expect(lines.slice(1, 5)).toEqual([
			"- Refused on the ladder: 2 refusal(s) of 1 question(s); 1 still-caught re-send(s) let through at its cap with rungs missing.",
			"- Still-caught re-sends passed: 3, of 4 re-sends. Rungs tried, of 2 with a readable transcript: past rulings 2, web 1, subagent 2; all three 1.",
			"- Flipped top option: 2 of 4 (50%) re-sends; 1 of those flips cite a new fact. A new citation in the option lines: 2 of 4 (50%).",
			"- Success line: stock floor 0 of 3 (0%) answered still-caught re-sends drew a research prompt. Baseline about 19% of still-close re-sends (7 of the 8 traced prompts followed one, #1894), close re-sends alone, so low-top re-sends have none. Line 10% or less: undecided — missed if 1 of the 3 listed repl(ies) are prompts.",
		]);
		expect(lines).toContain(
			"To classify for the success line — each reply after a still-caught re-send that is not the stock prompt:",
		);
		expect(
			lines.filter((l) => l.includes("(still-caught re-send")),
		).toHaveLength(3);
	});

	it("misses its line on the stock floor alone, naming the next step", () => {
		allLive();
		stillClose("a", L0, STOCK);
		for (let i = 1; i < 10; i++) stillClose(`n${i}`, L0 + i, "accept (A)");
		expect(read(L0 + DAY)).toContain(
			"stock floor 1 of 10 (10%) answered still-caught re-sends drew a research prompt. Baseline about 19% of still-close re-sends (7 of the 8 traced prompts followed one, #1894), close re-sends alone, so low-top re-sends have none. Line 10% or less: undecided — missed if 1 of the 9 listed",
		);
		stillClose("b", L0 + 20, STOCK);
		expect(read(L0 + DAY)).toContain(
			"Line 10% or less: MISSED on the stock floor alone — the next step is a K=3 independent vote (#1894's mechanism 3).",
		);
	});

	it("reads only its 14 days, saying when they ended", () => {
		allLive();
		stillClose("a", L0, "accept (A)");
		stillClose("late", L0 + 15 * DAY, STOCK);
		const lines = ladder(read(L0 + 20 * DAY));
		expect(lines[0]).toContain(`ended ${minute(L0 + 14 * DAY)}.`);
		expect(lines.join("\n")).toContain(
			"stock floor 0 of 1 (0%) answered still-caught re-sends",
		);
	});
});

describe("filing the reading (#1104)", () => {
	let argvLog: string;
	let issues: string;
	let gh: Record<string, string>;
	const filedRecord = () =>
		path.join(roots["workflow-core"], MARKERS_REL, FILED);
	const ghCalls = () =>
		fs.existsSync(argvLog) ? fs.readFileSync(argvLog, "utf8") : "";

	/** Without `failing`, gh is the logging stub below; with it, an unreachable gh. */
	const stubGh = (opts: { failing?: boolean } = {}) => {
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
			opts,
		).env;
	};

	/** A reading reached at T0 + 7 days, line 2 firing on the stock floor. */
	const reachedReading = () => {
		allLive();
		answered(40, T0 + DAY, STOCK);
	};
	const file = (now = T0 + 8 * DAY, args: string[] = []) =>
		run(now, args, "workflow-core", gh);

	beforeEach(() => stubGh());

	it("files nothing, and calls gh not at all, before the reading point", () => {
		allLive();
		answered(3, T0 + DAY, STOCK);
		const r = file(T0 + 2 * DAY);
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/Not reached/);
		expect(ghCalls()).toBe("");
		expect(fs.existsSync(filedRecord())).toBe(false);
	});

	it("files one takes:wayfinder issue at the reading point, carrying the figures, the fired lines and the rulings", () => {
		reachedReading();
		const r = file();
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(
			/Filed https:\/\/github\.com\/o\/r\/issues\/999\./,
		);
		const calls = ghCalls();
		expect(calls).toContain(
			"issue list --state all --json number,title,labels,closedAt,createdAt",
		);
		expect(calls).toContain(
			`issue create --title ${TITLE} --label takes:wayfinder --body`,
		);
		expect(calls).toMatch(/spec #1091; rulings #1061, #1067 and #1068/);
		expect(calls).toMatch(/1\. Untooled re-sends: 0 of 40/);
		expect(calls).toMatch(/2\. Separation-prompt rate: stock floor 40 of 40/);
		expect(calls).toMatch(/Fired: line 2\./);
		expect(calls).toMatch(
			/re-put the mechanism question and its `\/separate` question \(#1061\)/,
		);
		expect(fs.readFileSync(filedRecord(), "utf8")).toBe(
			"https://github.com/o/r/issues/999",
		);
	});

	it("never files a second time, and calls gh not at all, once it has filed", () => {
		reachedReading();
		expect(file().status).toBe(0);
		fs.rmSync(argvLog);
		const r = file(T0 + 9 * DAY);
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(
			/filed as https:\/\/github\.com\/o\/r\/issues\/999; nothing to file/,
		);
		expect(ghCalls()).toBe("");
	});

	it("still prints the research ladder's reading once it has filed (#2010)", () => {
		reachedReading();
		expect(file().status).toBe(0);
		log("workflow-core", T0 + 8 * DAY, "laddered", {
			kind: "passed-after-refusal",
			pair: PAIR,
			stillClose: true,
			rungs: { rulings: 1, web: 1, subagent: 1 },
			flipped: true,
			citesNewFact: true,
		});
		const r = file(T0 + 9 * DAY);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			"nothing to file.\n\nResearch ladder (#2006, #2010)",
		);
		expect(r.stdout).toContain(
			"- Still-caught re-sends passed: 1, of 1 re-sends.",
		);
	});

	it.each([
		["OPEN", "takes:wayfinder"],
		["CLOSED", "takes:wayfinder"],
		["OPEN", "takes:implement"],
	])(
		"files nothing where its issue already exists %s under %s, and records it",
		(state, label) => {
			reachedReading();
			fs.writeFileSync(
				issues,
				JSON.stringify([
					{ number: 7, title: TITLE, state, labels: [{ name: label }] },
				]),
			);
			const r = file();
			expect(r.status).toBe(0);
			expect(r.stdout).toMatch(/Already filed as #7; nothing filed\./);
			expect(ghCalls()).toContain("--state all");
			expect(ghCalls()).not.toContain("--label");
			expect(ghCalls()).not.toContain("issue create");
			expect(fs.readFileSync(filedRecord(), "utf8")).toBe("#7");
		},
	);

	it("files nothing while another run holds a live claim", () => {
		reachedReading();
		fs.mkdirSync(path.dirname(filedRecord()), { recursive: true });
		fs.writeFileSync(filedRecord(), "filing");
		const r = file();
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/Another run is filing the reading/);
		expect(ghCalls()).toBe("");
	});

	it("takes over a claim left by a run that died mid-filing", () => {
		reachedReading();
		fs.mkdirSync(path.dirname(filedRecord()), { recursive: true });
		fs.writeFileSync(filedRecord(), "filing");
		const old = new Date(Date.now() - 11 * 60_000);
		fs.utimesSync(filedRecord(), old, old);
		expect(file().stdout).toMatch(/Filed https:/);
		expect(ghCalls()).toContain("issue create");
	});

	it("is BROKEN, exit 2, where gh refuses, passing on its error, and drops its claim so the next run retries", () => {
		reachedReading();
		stubGh({ failing: true });
		const r = file();
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(
			/BROKEN: the reading would not file — .*gh auth login.*the next session start tries again/s,
		);
		expect(fs.existsSync(filedRecord())).toBe(false);
	});

	it("files nothing on --dry-run at the reading point, and says a plain run would", () => {
		reachedReading();
		const r = file(T0 + 8 * DAY, ["--dry-run"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/Fired: line 2\./);
		expect(r.stdout).toContain(`a plain run files this as "${TITLE}"`);
		expect(ghCalls()).toBe("");
	});
});
