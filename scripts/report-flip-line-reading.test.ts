// @vitest-environment node
/*
 * report-flip-line-reading.test.ts — the one-shot reading of the low-top
 * test's flip line (#2331, spec #2260). Break it and the reading lands on the
 * wrong day, counts the wrong refusals or re-sends, or files its issue early,
 * twice or on a dry run.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stubGhScript } from "./lib/gh-stub";
import { MARKERS_REL } from "./lib/marker-root";
import { CLOSE_CHECK_LOG } from "./lib/priced-options-limbs";
import { appendEvents, logPath } from "./lib/refusal-log";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.join(__dirname, "report-flip-line-reading.js");
/* Restated so a rename fails here rather than passing unseen. */
const TITLE = "Flip-line reading: should the low-top line of 65 move to 60?";
const FILED = ".flip-line-reading-filed";

const DAY = 86_400_000;
const T0 = Date.parse("2026-10-25T00:00:00Z");
const iso = (t: number) => new Date(t).toISOString();

type Kind = import("./lib/close-check-log").Kind;
type Trigger = import("./lib/close-check-log").Trigger;
type Repo = "workflow-core" | "mantahostels" | "design-vault" | "fantasy-books";
const REPOS: Repo[] = [
	"workflow-core",
	"mantahostels",
	"design-vault",
	"fantasy-books",
];

let home: string;
let systmp: string;
let roots: Record<Repo, string>;
let argvLog: string;
let gh: Record<string, string>;

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "flip-reading-"));
	systmp = path.join(home, "systmp");
	fs.mkdirSync(systmp);
	roots = Object.fromEntries(
		REPOS.map((r) => [r, path.join(home, r)]),
	) as Record<Repo, string>;
	for (const r of Object.values(roots)) {
		fs.mkdirSync(path.join(r, ".claude"), { recursive: true });
		execFileSync("git", ["init", "-q", r]);
		fs.writeFileSync(
			path.join(r, ".claude", "workflow-core.json"),
			JSON.stringify({ contract: 1 }),
		);
	}
	fs.mkdirSync(path.join(roots["workflow-core"], ".claude-plugin"));
	fs.writeFileSync(
		path.join(roots["workflow-core"], ".claude-plugin", "plugin.json"),
		JSON.stringify({ name: "workflow-core" }),
	);
	argvLog = path.join(home, "gh-argv.log");
	const issues = path.join(home, "issues.json");
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
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const ghCalls = () =>
	fs.existsSync(argvLog) ? fs.readFileSync(argvLog, "utf8") : "";
const filedRecord = () => path.join(roots["workflow-core"], MARKERS_REL, FILED);

/** One close-check event, through the guard's own writer. */
const log = (
	repo: Repo,
	at: number,
	session: string,
	{
		kind,
		round: n = "1",
		...extra
	}: { kind: Kind; round?: string } & Record<string, unknown>,
) =>
	appendEvents(
		roots[repo],
		[{ at: iso(at), session, round: n, kind, pair: null, ...extra }],
		CLOSE_CHECK_LOG,
	);

const lowTopLive = (repos: Repo[], at = T0) => {
	for (const repo of repos)
		log(repo, at, `live-${repo}`, {
			kind: "refused",
			slot: 1,
			trigger: "low-top",
			round: "9",
		});
};

/** `n` low-top questions in workflow-core, the i-th refused at `start + i h`
 *  and re-sent a minute later, the first `flipped` of them with a new top. */
const resends = (
	n: number,
	start: number,
	{ flipped = 0, trigger = "low-top" as Trigger | null, session = "s-re" } = {},
) => {
	for (let i = 0; i < n; i++) {
		const at = start + i * 3_600_000;
		const q = { round: String(i + 1) };
		log("workflow-core", at, session, {
			kind: "refused",
			slot: 1,
			...(trigger && { trigger }),
			...q,
		});
		log("workflow-core", at + 60_000, session, {
			kind: "passed-after-refusal",
			toolCalls: 3,
			stillClose: false,
			flipped: i < flipped,
			...q,
		});
	}
};

const run = (now: number, args: string[] = [], host: Repo = "workflow-core") =>
	runInProcess(SCRIPT, args, {
		env: {
			...process.env,
			...gh,
			CLAUDE_PROJECT_DIR: roots[host],
			CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
			HOME: home,
			WFC_NOW: iso(now),
			TMPDIR: systmp,
		},
	});

const dry = (now: number) => {
	const r = run(now, ["--dry-run"]);
	expect(r.status).toBe(0);
	return r.stdout;
};

describe("where it runs", () => {
	it("SKIPs in an adopter, exit 0", () => {
		const r = run(T0, [], "mantahostels");
		expect(r.status).toBe(0);
		expect(r.stderr).toMatch(/^SKIP: the flip-line reading/);
	});

	it("says there is no reading point while no repo has logged a low-top refusal, a close one or one with no trigger not counting", () => {
		log("mantahostels", T0, "s", {
			kind: "refused",
			slot: 1,
			trigger: "close",
		});
		log("design-vault", T0, "s", { kind: "refused", slot: 1 });
		expect(dry(T0 + DAY)).toMatch(
			/Reading point: none yet — no repo has logged a low-top refusal\./,
		);
	});
});

describe("the reading point", () => {
	it("is the 21-day ceiling while fewer than three repos have logged a low-top refusal", () => {
		lowTopLive(["workflow-core", "mantahostels"]);
		resends(60, T0 + DAY);
		const out = dry(T0 + 8 * DAY);
		expect(out).toMatch(
			/Reading point: 2026-11-15 00:00 at the latest \(21 days after the first low-top refusal\)/,
		);
		expect(out).toMatch(/Not reached at 2026-11-02 00:00: figures so far\./);
		expect(out).toMatch(/- design-vault: no low-top refusal log line yet/);
	});

	it("is 7 days after the third repo went live, where the 60th re-send came sooner", () => {
		lowTopLive(["workflow-core", "mantahostels"]);
		lowTopLive(["design-vault"], T0 + 3 * DAY);
		resends(60, T0 + DAY);
		expect(dry(T0 + 4 * DAY)).toMatch(
			/Reading point: 2026-11-04 00:00 — the later of 7 days after 3 repos had logged a low-top refusal \(2026-10-28 00:00\) and the 60th low-top re-send/,
		);
	});

	it("is the 60th low-top re-send where it came after 7 days, a close, both-caught or untriggered re-send not counting", () => {
		lowTopLive(["workflow-core", "mantahostels", "design-vault"]);
		resends(20, T0 + DAY, { trigger: "close" });
		resends(20, T0 + 2 * DAY, { trigger: "both" });
		/* Written before #2327: no trigger, read as close. */
		resends(20, T0 + 3 * DAY, { trigger: null, session: "s-old" });
		resends(60, T0 + 6 * DAY);
		/* The 60th re-send passes 59 h and a minute after its start. */
		expect(dry(T0 + 6 * DAY)).toMatch(
			/Reading point: 2026-11-02 11:01 — the later of 7 days/,
		);
	});

	it("is capped at 21 days, reading thin", () => {
		lowTopLive(["workflow-core", "mantahostels", "design-vault"]);
		resends(10, T0 + DAY);
		const out = dry(T0 + 22 * DAY);
		expect(out).toMatch(/Reached: figures are read up to 2026-11-15 00:00\./);
		expect(out).toMatch(/THIN: 10 low-top re-send\(s\), under the 60/);
	});
});

describe("the two readings", () => {
	const quorumLive = () => {
		lowTopLive(["workflow-core", "mantahostels", "design-vault"]);
	};

	it("line 1 gives low-top refusals a day against 15.5", () => {
		quorumLive();
		resends(17, T0 + DAY);
		/* 3 live refusals and 17 more, over 10 days. */
		expect(dry(T0 + 10 * DAY)).toMatch(
			/1\. Low-top refusals: 20 over 10\.0 days, 2\.0 a day, and 0 the close test caught too\. Forecast 15\.5 a day of rounds no other limb catches \(#2229\)/,
		);
	});

	it("line 2 fires under 30% of re-sends changing their top option", () => {
		quorumLive();
		resends(10, T0 + DAY, { flipped: 2 });
		expect(dry(T0 + 2 * DAY)).toMatch(
			/2\. Top option changed: 2 of 10 \(20%\) low-top re-sends\. .* Under 30%: FIRES — move the line down to 60/,
		);
	});

	it("line 2 holds at 30%", () => {
		quorumLive();
		resends(10, T0 + DAY, { flipped: 3 });
		const out = dry(T0 + 2 * DAY);
		expect(out).toMatch(/2\. Top option changed: 3 of 10 \(30%\).*: holds\./);
		expect(out).toMatch(/Fired: none\./);
	});
});

describe("what it counts as low-top", () => {
	it("counts a both-caught refusal apart in line 1, and leaves its re-send out of line 2", () => {
		lowTopLive(["workflow-core", "mantahostels", "design-vault"]);
		resends(4, T0 + DAY, { trigger: "both", flipped: 4, session: "s-both" });
		resends(10, T0 + DAY, { flipped: 5 });
		const out = dry(T0 + 2 * DAY);
		expect(out).toMatch(
			/1\. Low-top refusals: 13 over 2\.0 days, 6\.5 a day, and 4 the close test caught too\./,
		);
		expect(out).toMatch(/2\. Top option changed: 5 of 10 \(50%\)/);
	});
});

describe("what will not read", () => {
	it("is BROKEN, exit 2, on a close-check log line that is not JSON, naming it", () => {
		lowTopLive(["workflow-core", "mantahostels"]);
		fs.appendFileSync(
			logPath(roots.mantahostels, CLOSE_CHECK_LOG),
			"not json\n",
		);
		const r = run(T0 + DAY, ["--dry-run"]);
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(
			/^BROKEN: .*mantahostels.*:2 is not a JSON object/,
		);
	});
});

describe("filing the reading", () => {
	const reachedReading = () => {
		lowTopLive(["workflow-core", "mantahostels", "design-vault"]);
		resends(60, T0 + DAY, { flipped: 6 });
	};

	it("files nothing, and calls gh not at all, before the reading point", () => {
		reachedReading();
		const r = run(T0 + 5 * DAY);
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/Not reached/);
		expect(ghCalls()).toBe("");
		expect(fs.existsSync(filedRecord())).toBe(false);
	});

	it("files one takes:wayfinder issue at the reading point, carrying the two readings", () => {
		reachedReading();
		const r = run(T0 + 8 * DAY);
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(
			/Filed https:\/\/github\.com\/o\/r\/issues\/999\./,
		);
		const calls = ghCalls();
		expect(calls).toContain(
			`issue create --title ${TITLE} --label takes:wayfinder --body`,
		);
		expect(calls).toMatch(/1\. Low-top refusals: 63 over 7\.0 days/);
		expect(calls).toMatch(/2\. Top option changed: 6 of 60 \(10%\)/);
		expect(calls).toMatch(/Fired: line 2\./);
		expect(fs.readFileSync(filedRecord(), "utf8")).toBe(
			"https://github.com/o/r/issues/999",
		);
	});

	it("walks nothing within a day of its last walk, and calls gh not at all (#3220)", () => {
		reachedReading();
		fs.mkdirSync(path.dirname(filedRecord()), { recursive: true });
		fs.writeFileSync(`${filedRecord()}-read-at`, iso(T0 + 8 * DAY - 60_000));
		const r = run(T0 + 8 * DAY);
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/under a day ago; nothing read\.\n$/);
		expect(ghCalls()).toBe("");
		expect(fs.existsSync(filedRecord())).toBe(false);
	});

	it("never files a second time, and calls gh not at all, once it has filed", () => {
		reachedReading();
		expect(run(T0 + 8 * DAY).status).toBe(0);
		fs.writeFileSync(argvLog, "");
		const r = run(T0 + 9 * DAY);
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(
			/filed as https:\/\/github\.com\/o\/r\/issues\/999; nothing to file/,
		);
		expect(ghCalls()).toBe("");
	});

	it("files nothing on --dry-run at the reading point, and says a plain run would", () => {
		reachedReading();
		const out = dry(T0 + 8 * DAY);
		expect(out).toMatch(/Dry run: the reading point is reached/);
		expect(ghCalls()).toBe("");
		expect(fs.existsSync(filedRecord())).toBe(false);
	});
});
