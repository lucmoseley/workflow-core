// @vitest-environment node
/*
 * guard-selection-sum.js blocks a /pick-next selection session's dispatch or
 * hold message whose accounting line is missing, does not add up, or disagrees
 * with the frontier the run measured — and examines no session the run never
 * marked (mantahostels#844).
 *
 * Driven end-to-end through the CLI — a payload on stdin, a transcript on disk,
 * a marker in a scratch repo root, the block JSON on stdout. That is the whole
 * contract the Stop hook has with Claude Code, and only end-to-end does it
 * exercise the arming limb, which is the one mantahostels#844 asked to be mutation-tested.
 *
 * The one exception is called in-process: the marker store's own round-trips,
 * which no message shape can read back. Per-session keying is read off the
 * wave the guard records on that marker.
 *
 * It runs at every `Stop` (`self-plugin/hooks/hooks.json`, `hooks/hooks.json`)
 * and is the only check on `pick-next` §5's arithmetic: loosen a case and a
 * selection run dispatches with frontier items unaccounted for; break the
 * arming limb and every session, selection or not, is examined.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import markerRoot from "./lib/marker-root";
import { runInProcess } from "./lib/run-in-process";
import selectionMarker from "./lib/selection-marker";

const GUARD = path.join(__dirname, "guard-selection-sum.js");

let dir: string;
let root: string;
let sid: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "selection-sum-"));
	root = fs.mkdtempSync(path.join(os.tmpdir(), "selection-root-"));
	sid = `test-session-${Math.random().toString(36).slice(2)}`;
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(root, { recursive: true, force: true });
});

/** A transcript whose outgoing message is `text`, preceded by a user turn. */
function transcriptWith(text: string, extra: object[] = []): string {
	const file = path.join(dir, `${sid}.jsonl`);
	const records = [
		{ type: "user", message: { content: "what should I work on?" } },
		...extra,
		{ type: "assistant", message: { content: [{ type: "text", text }] } },
	];
	fs.writeFileSync(
		file,
		`${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
	);
	return file;
}

/** Arm the session: record a selection run of `frontier` issues, over `slots`
 * free admission slots, `noCommand` of the frontier in the band no command
 * opens. `null` slots is a run whose admission read failed; `null` noCommand is
 * a marker minted before mantahostels#1626 added the field, which leaves that term unpinned. */
function armed(
	frontier: number | null = 60,
	slots: number | null = null,
	noCommand: number | null = null,
) {
	selectionMarker.record(root, {
		sessionId: sid,
		frontier: frontier as number,
		slots: slots as number,
		noCommand: noCommand as number,
	});
}

/** The marker file `record` wrote for `sessionId`, found under the scratch root. */
function findMarkerFile(sessionId: string): string {
	const rel = (fs.readdirSync(root, { recursive: true }) as string[]).find(
		(f) => path.basename(f) === `${sessionId}.json`,
	);
	return rel ? path.join(root, rel) : expect.fail(`no marker for ${sessionId}`);
}

interface Run {
	blocked: boolean;
	reason: string;
}

/* CLAUDE_JOB_DIR decides the completion-mark limb, and the suite itself often
 * runs inside a background job — so it is set here explicitly rather than
 * inherited, or every case below would pass or fail on where it was run. */
function run(text: string, cwd = dir, backgroundJob = false): Run {
	const transcript = transcriptWith(text);
	const env: NodeJS.ProcessEnv = { ...process.env, WFC_REPO_ROOT: root };
	if (backgroundJob) env.CLAUDE_JOB_DIR = path.join(dir, "job");
	else delete env.CLAUDE_JOB_DIR;
	const res = runInProcess(GUARD, [], {
		stdin: JSON.stringify({
			session_id: sid,
			transcript_path: transcript,
		}),
		cwd,
		env,
	});
	expect(res.status, "the hook must never exit non-zero").toBe(0);
	const out = res.stdout.trim();
	if (!out) return { blocked: false, reason: "" };
	const parsed = JSON.parse(out);
	return { blocked: parsed.decision === "block", reason: parsed.reason };
}

const DISPATCH =
	"**341, 353, 366** - takes:implement. #341 first: it blocks #412.";

describe("the arming limb — a non-selection session is never blocked", () => {
	it("passes a dispatch-shaped message when no selection run minted a marker", () => {
		expect(run(DISPATCH).blocked).toBe(false);
	});

	it("passes a message that merely quotes the accounting, unarmed", () => {
		expect(run("Frontier 60: 5 dispatched + 6 disqualified.").blocked).toBe(
			false,
		);
	});

	it("blocks the identical message once a run has minted the marker", () => {
		armed();
		// exempt (mantahostels#2145): the block reason for this exact armed()/DISPATCH pair is
		// pinned by "still blocks a single-wave dispatch that omits the sum
		// entirely"; this test is only about the arming.
		expect(run(DISPATCH).blocked).toBe(true);
	});

	it("stays unarmed when the marker belongs to a different session", () => {
		selectionMarker.record(root, { sessionId: "someone-else", frontier: 60 });
		expect(run(DISPATCH).blocked).toBe(false);
	});

	it("stays unarmed when the marker is unreadable", () => {
		armed();
		fs.writeFileSync(findMarkerFile(sid), "{not json");
		expect(run(DISPATCH).blocked).toBe(false);
	});
});

describe("what counts as a dispatch message", () => {
	beforeEach(() => armed());

	it("leaves an armed session's ordinary progress report alone", () => {
		expect(
			run("Running the script now; the band read takes a few minutes.").blocked,
		).toBe(false);
	});

	it("leaves a message naming issue numbers but dispatching nothing alone", () => {
		expect(run("The tie band holds #341, #353 and #366.").blocked).toBe(false);
	});

	it("blocks a hold, which claims every frontier issue is disqualified", () => {
		const r = run("**Hold** — every candidate shares a substrate with #412.");
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("without stating");
	});

	it("recognises a single-issue line", () => {
		const r = run("**341** - takes:wayfinder.");
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("without stating");
	});

	// Crosses the real clock: a regex match is synchronous, so no seam can
	// interrupt a backtracking one (Sonar javascript:S5852). 16 numbers took
	// ~2 s, doubling per number, when each comma's spaces could split two ways.
	it("reads a long bold number list that dispatches nothing, promptly", () => {
		const numbers = Array.from({ length: 16 }, (_, i) => i + 1).join(",  ");
		const start = Date.now();
		expect(run(`**${numbers}** were read.`).blocked).toBe(false);
		expect(Date.now() - start).toBeLessThan(1000);
	});

	it("recognises a hash and a space before a later number", () => {
		const r = run("**#341, # 353** - takes:implement.");
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("without stating");
	});

	it("recognises the contract's backticked spelling", () => {
		const r = run("**`341, 353`** - `takes:implement`.");
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("without stating");
	});
});

describe("the arithmetic it demands", () => {
	beforeEach(() => armed(60));

	it("passes a set whose counts add to the measured frontier", () => {
		expect(
			run(`${DISPATCH}\n\nFrontier 60: 3 dispatched + 57 disqualified.`)
				.blocked,
		).toBe(false);
	});

	it("blocks a sum that does not add up, naming both totals", () => {
		const r = run(`${DISPATCH}\n\nFrontier 60: 3 dispatched + 5 disqualified.`);
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("does not add up");
		expect(r.reason).toContain("= 8");
		expect(r.reason).toContain("frontier of 60");
	});

	it("blocks a sum invented against a frontier the run never measured, naming the frontier it measured", () => {
		const r = run(`${DISPATCH}\n\nFrontier 8: 3 dispatched + 5 disqualified.`);
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("measured 60");
	});

	it("accepts the line with the numbers and the label bolded", () => {
		expect(
			run(`${DISPATCH}\n\n**Frontier 60: 3 dispatched + 57 disqualified.**`)
				.blocked,
		).toBe(false);
	});

	it("accepts the skill's backticked line (#1025)", () => {
		armed(2, null, 0);
		expect(
			run(
				"**341, 353** - takes:implement.\n\n`Frontier 2: 2 dispatched + 0 disqualified + 0 no command.`",
			).blocked,
		).toBe(false);
	});

	it("still blocks a backticked line whose sum is wrong", () => {
		const r = run(
			`${DISPATCH}\n\n\`Frontier 60: 3 dispatched + 5 disqualified.\``,
		);
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("does not add up");
	});

	it("reads a backticked wave line as it reads a bare one", () => {
		/* Every figure is checked against the marker or the sum, so a spelling
		 * misread on any one of them blocks, and only a whole read opens the wave. */
		const bare =
			"Wave 1 of 2 — Frontier 60: 2 dispatched + 41 disqualified + 1 no command + 16 pending";
		for (const line of [
			bare,
			`- \`${bare}\``,
			"`Wave 1 of 2` — `Frontier 60`: `2 dispatched` + `41 disqualified` + `1 no command` + `16 pending`",
			"Wave `1` of `2` — Frontier `60`: `2` dispatched + `41` disqualified + `1` no command + `16` pending",
		]) {
			armed(60, null, 1);
			expect(
				run(`**341, 353** - takes:implement.\n${line}`).blocked,
				line,
			).toBe(false);
			expect(selectionMarker.read(root, sid)?.wave?.keys, line).toEqual([
				"341,353",
			]);
		}
	});

	it("checks only the internal sum where the run recorded no frontier", () => {
		armed(null);
		expect(
			run(`${DISPATCH}\n\nFrontier 8: 3 dispatched + 5 disqualified.`).blocked,
		).toBe(false);
	});
});

describe("the message it sends back", () => {
	it("names the three disqualifiers, citing the skill by its command", () => {
		armed();
		const r = run(DISPATCH);
		expect(r.reason).toContain("shares a substrate");
		expect(r.reason).toContain("self-gated");
		expect(r.reason).toContain("no slot left");
		expect(r.reason).toContain("/pick-next §5");
		expect(r.reason).not.toContain("SKILL.md");
	});

	it("rules out a stamp collision only where the host keeps a doc map (#1010)", () => {
		armed();
		expect(run(DISPATCH).reason).not.toContain("docs/doc-map.md");
		fs.mkdirSync(path.join(root, "docs"), { recursive: true });
		fs.writeFileSync(path.join(root, "docs", "doc-map.md"), "");
		armed();
		expect(run(DISPATCH).reason).toContain("docs/doc-map.md");
	});

	it("prints the line to paste, and the frontier the run measured", () => {
		armed(37);
		const r = run(DISPATCH);
		expect(r.reason).toContain(
			"Frontier <F>: <D> dispatched + <Q> disqualified + <U> no command.",
		);
		expect(r.reason).toContain("measured a frontier of 37");
	});
});

describe("the admission-cut line (mantahostels#1321)", () => {
	/* Three session lines and a sum that adds up: everything mantahostels#844's guard asks
	 * for. */
	const three =
		"**341** - takes:implement.\n" +
		"**353** - takes:implement.\n" +
		"**366, 372** - takes:wayfinder.\n\n" +
		"Frontier 60: 4 dispatched + 56 disqualified.";

	it("blocks a set that filled every measured slot and named nothing cut, counting sessions against free slots and asking for an Admission cut line", () => {
		armed(60, 3);
		const r = run(three);
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("3 session(s) against the 3 free admission");
		expect(r.reason).toContain("**Admission cut:**");
	});

	it("passes once the cut candidates are named", () => {
		armed(60, 3);
		expect(run(`${three}\n\n**Admission cut:** #1317, #1320.`).blocked).toBe(
			false,
		);
	});

	it("accepts `none` — the explicit answer that nothing overflowed", () => {
		armed(60, 3);
		expect(run(`${three}\n\n**Admission cut:** none.`).blocked).toBe(false);
	});

	it("counts sessions, not issues, so a merged bundle's line counts once", () => {
		/* Four issues across three lines against four slots: the machine is not
		 * full, so nothing is owed. */
		armed(60, 4);
		expect(run(three).blocked).toBe(false);
	});

	it("fires where the set exceeds the measured slots, which the re-read allows", () => {
		armed(60, 2);
		const r = run(three);
		expect(r.blocked).toBe(true);
		// `three` states an arithmetic that adds up, so the block must be the
		// admission-cut limb rather than the sum one.
		expect(r.reason).toContain("**Admission cut:**");
	});

	it("stays silent below the measured slot count — an exhausted frontier", () => {
		armed(60, 5);
		expect(run(three).blocked).toBe(false);
	});

	it("stays silent where the run could not read a slot count", () => {
		armed(60, null);
		expect(run(three).blocked).toBe(false);
	});

	it("fires on the always-admit-one shape, where the run measured zero slots", () => {
		// `admissionFrom` admits one session whatever the headroom when nothing is
		// running, so a set dispatched against zero measured slots is the sharpest
		// admission cap there is — every other candidate was cut on it.
		armed(60, 0);
		const r = run(
			"**341** - takes:implement.\n\nFrontier 60: 1 dispatched + 59 disqualified.",
		);
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("one is admitted whatever the headroom");
	});

	it("stays silent on a HOLD, whose slot count is zero", () => {
		armed(60, 0);
		const r = run(
			"**Hold** — headroom below one slot.\n\n" +
				"Frontier 60: 0 dispatched + 60 disqualified.",
		);
		expect(r.blocked).toBe(false);
	});

	it("demands the arithmetic first, not the cut line", () => {
		armed(60, 3);
		const r = run(
			"**341** - takes:implement.\n" +
				"**353** - takes:implement.\n" +
				"**366, 372** - takes:wayfinder.\n\n" +
				"**Admission cut:** #1317.",
		);
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("without stating");
	});

	it("tolerates a bulleted, unbolded spelling of the cut line", () => {
		armed(60, 3);
		expect(run(`${three}\n\n- Admission cut: #1317`).blocked).toBe(false);
	});

	it("does not accept a line that names no candidate and does not say none", () => {
		armed(60, 3);
		const r = run(`${three}\n\n**Admission cut:** several.`);
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("**Admission cut:**");
	});
});

describe("the not-launched block stands in for the admission-cut line (#592)", () => {
	const three =
		"**341** - takes:implement.\n" +
		"**353** - takes:implement.\n" +
		"**366, 372** - takes:wayfinder.\n\n" +
		"Frontier 60: 4 dispatched + 56 disqualified.";

	it("names the block in the refusal", () => {
		armed(60, 3);
		expect(run(three).reason).toContain("**Not launched:**");
	});

	it("passes a one-line block naming the issues", () => {
		armed(60, 3);
		expect(
			run(
				`${three}\n\n**Not launched:** no admission slot — #1317, #1320; gated in its body — #1330.`,
			).blocked,
		).toBe(false);
	});

	it("passes a block grouped by reason on the lines beneath it", () => {
		armed(60, 3);
		expect(
			run(
				`${three}\n\n**Not launched:**\n- no admission slot: #1317, #1320\n- shares a file with #341: #1330`,
			).blocked,
		).toBe(false);
	});

	it("accepts `none`", () => {
		armed(60, 3);
		expect(run(`${three}\n\n**Not launched:** none.`).blocked).toBe(false);
	});

	it("tolerates a bulleted, unbolded spelling", () => {
		armed(60, 3);
		expect(
			run(`${three}\n\n- Not launched: no admission slot #1317`).blocked,
		).toBe(false);
	});

	it("does not accept a block that names no issue and does not say none", () => {
		armed(60, 3);
		expect(run(`${three}\n\n**Not launched:** several.`).blocked).toBe(true);
	});

	it.each([
		["bare numbers", "**Not launched:** no admission slot — 1317, 1320"],
		["a bulleted none", "**Not launched:**\n- none"],
		[
			"a blank line under the header",
			"**Not launched:**\n\n- no admission slot: #1317",
		],
		["unbulleted reason lines", "**Not launched:**\nno admission slot: #1317"],
		["a heading", "### Not launched\n- no admission slot: #1317"],
	])("passes %s", (_, block) => {
		armed(60, 3);
		expect(run(`${three}\n\n${block}`).blocked).toBe(false);
	});

	it("does not read an issue number past a blank line as the block's", () => {
		armed(60, 3);
		expect(
			run(`${three}\n\n**Not launched:** several.\n\n- cut: #1317`).blocked,
		).toBe(true);
	});

	it("passes the pick-next skill's three-block shape (#594)", () => {
		armed(60, 3);
		expect(
			run(
				`${three}\n\n**Not launched:**\n- no admission slot: #1317, #1320\n\n` +
					"**Memory:**\n  free             5039 MB\n  working          9 session(s), 3048 MB PSS\n\n" +
					"**Open:** 43 open, 60 frontier, 12 blocked",
			).blocked,
		).toBe(false);
	});

	it("does not read the Memory block's figures as issues cut", () => {
		armed(60, 3);
		expect(
			run(`${three}\n\n**Not launched:** several.\n**Memory:**\n  free 5039 MB`)
				.blocked,
		).toBe(true);
	});

	it("does not read a quoted Memory block's figures as issues cut", () => {
		armed(60, 3);
		expect(
			run(`${three}\n\n> **Not launched:**\n>\n> **Memory:**\n>   free 5039 MB`)
				.blocked,
		).toBe(true);
	});

	it("passes a quoted block naming the issues", () => {
		armed(60, 3);
		expect(
			run(`${three}\n\n> **Not launched:**\n> - no admission slot: #1317`)
				.blocked,
		).toBe(false);
	});

	it("ends the block at a session line", () => {
		armed(60, 3);
		expect(run(`**Not launched:** several.\n${three}`).blocked).toBe(true);
	});

	it("clears a closing wave that filled the machine", () => {
		armed(60, 2);
		run(
			"**341** - takes:implement.\n" +
				"Wave 1 of 2 — frontier 60: 1 dispatched + 57 disqualified + 2 pending band read.",
		);
		expect(
			run(
				"**366** - takes:implement.\n**Not launched:** no admission slot — #401, #402.\nWave 2 of 2 — frontier 60: 3 dispatched + 57 disqualified.",
			).blocked,
		).toBe(false);
	});
});

describe("the loop is bounded", () => {
	it("blocks three times, then lets the turn through", () => {
		armed();
		// exempt (mantahostels#2145): the reason each of these three blocks carries is pinned by
		// "still blocks a single-wave dispatch that omits the sum entirely", the
		// same armed()/DISPATCH pair; this test counts them.
		const verdicts = [1, 2, 3, 4].map(() => run(DISPATCH, dir).blocked);
		expect(verdicts).toEqual([true, true, true, false]);
	});

	it("counts per session, so a second session gets its own three", () => {
		armed();
		for (const _ of [1, 2, 3]) run(DISPATCH, dir);
		sid = `another-${Math.random().toString(36).slice(2)}`;
		armed();
		// exempt (mantahostels#2145): same armed()/DISPATCH reason, pinned by "still blocks a
		// single-wave dispatch that omits the sum entirely".
		expect(run(DISPATCH, dir).blocked).toBe(true);
	});
});

describe("it fails silent", () => {
	it("exits 0 on an empty payload", () => {
		const res = runInProcess(GUARD, [], {
			stdin: "",
			cwd: dir,
			env: { ...process.env, WFC_REPO_ROOT: root },
		});
		expect(res.status).toBe(0);
		expect(res.stdout.trim()).toBe("");
	});

	it("exits 0 on a payload naming a transcript that does not exist", () => {
		armed();
		const res = runInProcess(GUARD, [], {
			stdin: JSON.stringify({
				session_id: sid,
				transcript_path: path.join(dir, "absent.jsonl"),
			}),
			cwd: dir,
			env: { ...process.env, WFC_REPO_ROOT: root, HOME: dir },
		});
		expect(res.status).toBe(0);
		expect(res.stdout.trim()).toBe("");
	});
});

describe("the marker store", () => {
	it("refuses a session id that is not one, rather than writing outside its directory", () => {
		for (const sessionId of ["../../escape", "a/b"])
			expect(selectionMarker.record(root, { sessionId, frontier: 1 })).toBe(
				false,
			);
		/* `../../` from the marker directory still lands under the root. */
		expect(
			(fs.readdirSync(root, { recursive: true }) as string[]).map((f) =>
				path.basename(f),
			),
		).not.toContain("escape.json");
	});

	it("reads back the frontier the run recorded", () => {
		selectionMarker.record(root, { sessionId: sid, frontier: 42 });
		expect(selectionMarker.read(root, sid)?.frontier).toBe(42);
	});

	it("reads back the slot count the run recorded", () => {
		selectionMarker.record(root, { sessionId: sid, frontier: 42, slots: 3 });
		expect(selectionMarker.read(root, sid)?.slots).toBe(3);
	});

	it("records no slot count where admission could not be read", () => {
		selectionMarker.record(root, { sessionId: sid, frontier: 42, slots: null });
		expect(selectionMarker.read(root, sid)?.slots).toBe(null);
	});

	it("sweeps a marker older than a week and keeps a fresh one", () => {
		const weekMs = 7 * 24 * 60 * 60 * 1000;
		const aged = (sessionId: string, ageMs: number) => {
			selectionMarker.record(root, { sessionId, frontier: 1 });
			const file = findMarkerFile(sessionId);
			const past = (Date.now() - ageMs) / 1000;
			fs.utimesSync(file, past, past);
			return file;
		};
		const old = aged("stale", weekMs + 60_000);
		const young = aged("young", weekMs - 60_000);

		selectionMarker.record(root, { sessionId: sid, frontier: 2 });

		expect(fs.existsSync(old)).toBe(false);
		expect(fs.existsSync(young)).toBe(true);
		expect(selectionMarker.read(root, sid)?.frontier).toBe(2);
	});
});

describe("the completion mark a background job owes (mantahostels#1337)", () => {
	/* The block is right — the job stays resumable either way (mantahostels#1337). */
	it("does not tell a HOLD that it already launched the set", () => {
		armed(60, 0);
		const r = run(
			"**Hold** — headroom below one slot.\n\n" +
				"Frontier 60: 0 dispatched + 60 disqualified.",
			dir,
			true,
		);
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("holds a selection set");
		expect(r.reason).not.toContain("has already launched the set");
	});

	it("still tells a real dispatch that it dispatched", () => {
		armed(60, 3);
		const r = run(
			"**341** - takes:implement.\n" +
				"**353** - takes:implement.\n" +
				"**366, 372** - takes:wayfinder.\n\n" +
				"Frontier 60: 4 dispatched + 56 disqualified.\n\n" +
				"**Admission cut:** none.",
			dir,
			true,
		);
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("dispatches a selection set");
	});

	/* Everything the other limbs ask for — a session line, a sum that adds up,
	 * an admission-cut line — and no mark (mantahostels#1337). */
	const full =
		"**341** - takes:implement.\n\n" +
		"Frontier 60: 1 dispatched + 59 disqualified.\n\n" +
		"**Admission cut:** none.";

	it("blocks a dispatch from a background job that carries no mark", () => {
		armed(60, 3);
		const r = run(full, dir, true);
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("stays filed *Working*");
		expect(r.reason).toContain("result:");
	});

	it("passes the identical message outside a background job", () => {
		armed(60, 3);
		expect(run(full, dir, false).blocked).toBe(false);
	});

	it("accepts `result:` — the set is launched and nothing waits", () => {
		armed(60, 3);
		expect(
			run(`${full}\n\nresult: launched 1 session.`, dir, true).blocked,
		).toBe(false);
	});

	it("accepts `needs input:` — dispatched, but still blocked on the founder", () => {
		armed(60, 3);
		expect(
			run(`${full}\n\nneeds input: which of (A) or (B)?`, dir, true).blocked,
		).toBe(false);
	});

	it("accepts `failed:`", () => {
		armed(60, 3);
		expect(
			run(`${full}\n\nfailed: the allowance bar refused.`, dir, true).blocked,
		).toBe(false);
	});

	it("does not accept the word `result` used in prose", () => {
		armed(60, 3);
		const prose = `${full}\n\nI will report the result once they finish.`;
		const r = run(prose, dir, true);
		expect(r.blocked).toBe(true);
		// `full` satisfies every other limb, so the block must be the missing
		// completion mark rather than the sum or the cut line.
		expect(r.reason).toContain("stays filed *Working*");
	});

	it("never fires on a non-dispatch message, background job or not", () => {
		armed(60, 3);
		expect(run("Still reading the band.", dir, true).blocked).toBe(false);
	});

	it("stays unarmed in a background job when no run minted a marker", () => {
		expect(run(full, dir, true).blocked).toBe(false);
	});
});

describe("the session id the two sides key on (mantahostels#844, mantahostels#1774)", () => {
	/*
	 * Both sides now read the id through one seam, `lib/session-id.js`, whose own
	 * suite pins what each lookup answers. What this block adds is the round trip
	 * through the real code: mint against an injected environment, read back
	 * through the guard's CLI on a Stop payload. A wrong-session marker is
	 * already covered above; what is new here is the environment as the mint's
	 * only source of the id.
	 *
	 * STILL UNVERIFIED, and not counted as covered: that a running harness gives
	 * the Bash environment and the Stop payload the same id. It is cross-process
	 * and no test here can reach it — mantahostels#844 measured them equal by hand, and the
	 * re-check recipe is in `lib/selection-marker.js`'s header.
	 */
	it("arms the guard when the mint's environment id is the payload's", () => {
		expect(
			selectionMarker.recordFromEnv(
				root,
				{ frontier: 60 },
				{ CLAUDE_CODE_SESSION_ID: sid },
			),
		).toBe(true);
		// exempt (mantahostels#2145): same armed-marker/DISPATCH reason, pinned by "still
		// blocks a single-wave dispatch that omits the sum entirely"; this test is
		// only about which session id the mint keys on.
		expect(run(DISPATCH).blocked).toBe(true);
	});

	it("mints nothing at all when the environment carries no id", () => {
		expect(selectionMarker.recordFromEnv(root, { frontier: 60 }, {})).toBe(
			false,
		);
		expect(run(DISPATCH).blocked).toBe(false);
	});
});

describe("a two-wave dispatch against one run marker (mantahostels#1486)", () => {
	/*
	 * §6 lets the set go out in two waves — the candidates needing no merge
	 * decision the moment the script lands, the rest once §4's band read
	 * returns. Wave 1's sum cannot add up on its own, so it names the pending
	 * count instead and the closing wave states the full sum.
	 */
	const wave1 =
		"**341** - takes:implement · sonnet.\n" +
		"**353** - takes:triage · sonnet.\n" +
		"Wave 1 of 2 — frontier 60: 2 dispatched + 42 disqualified + 16 pending band read.";
	const wave2 =
		"**366, 370** - takes:implement · sonnet.\n" +
		"Wave 2 of 2 — frontier 60: 4 dispatched + 56 disqualified.";

	it("passes wave 1's partial sum, which cannot add up on its own", () => {
		armed();
		expect(run(wave1).blocked).toBe(false);
	});

	it("passes the closing wave's full sum against the same marker", () => {
		armed();
		expect(run(wave1).blocked).toBe(false);
		expect(run(wave2).blocked).toBe(false);
	});

	it("blocks a wave 1 whose four numbers do not add to the frontier, naming its terms", () => {
		armed();
		const bad = wave1.replace("16 pending", "15 pending");
		const r = run(bad);
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("+ 15 pending");
	});

	it("blocks a wave 1 stating a frontier the run never measured", () => {
		armed();
		/* Internally consistent — 2 + 52 + 16 = 70 — so only the marker catches it. */
		const r = run(
			wave1.replace(
				"frontier 60: 2 dispatched + 42 disqualified",
				"frontier 70: 2 dispatched + 52 disqualified",
			),
		);
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain(
			"the `pick-next.js` run this session made measured 60",
		);
		expect(r.reason).toContain("pending band read");
	});

	it("blocks a closing wave that still leaves candidates pending, giving the closing-wave form", () => {
		armed();
		const r = run(
			"**366** - takes:implement.\nWave 2 of 2 — frontier 60: 3 dispatched + 41 disqualified + 16 pending.",
		);
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("the closing wave");
		expect(r.reason).toContain("Wave 2 of 2 — frontier <F>:");
	});

	it("blocks a pending count of 0 — the full sum in the partial's shape — giving the full-sum form", () => {
		armed();
		const r = run(
			"**366** - takes:implement.\nWave 1 of 2 — frontier 60: 4 dispatched + 56 disqualified + 0 pending.",
		);
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("pending count of 0");
		expect(r.reason).toContain(
			"Frontier <F>: <D> dispatched + <Q> disqualified + <U> no command.",
		);
	});

	it("still blocks a single-wave dispatch that omits the sum entirely", () => {
		armed();
		const r = run(DISPATCH);
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("without stating §5's arithmetic");
	});

	it("offers the wave shape to a dispatch that stated no sum at all", () => {
		armed();
		expect(run(DISPATCH).reason).toContain("pending band read");
	});
});

describe("a wave left open is still owed its closing sum (mantahostels#1486)", () => {
	const wave1 =
		"**341** - takes:implement.\n" +
		"Wave 1 of 2 — frontier 60: 1 dispatched + 43 disqualified + 16 pending band read.";

	it("blocks an ordinary turn that ends while the wave is open", () => {
		armed();
		expect(run(wave1).blocked).toBe(false);
		const r = run("Band read came back. Nothing else to report.");
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("still owed");
	});

	it("passes a turn that re-states the wave-1 line while it waits", () => {
		armed();
		expect(run(wave1).blocked).toBe(false);
		expect(run(`Band read still running.\n${wave1}`).blocked).toBe(false);
	});

	it("stops demanding it once the closing wave states the full sum", () => {
		armed();
		run(wave1);
		expect(
			run(
				"**366** - takes:implement.\nWave 2 of 2 — frontier 60: 2 dispatched + 58 disqualified.",
			).blocked,
		).toBe(false);
		expect(run("Anything else at all.").blocked).toBe(false);
	});

	it("never demands one of a session that opened no wave", () => {
		armed();
		expect(run("An ordinary progress report.").blocked).toBe(false);
	});
});

describe("the admission-cut trigger across two waves (mantahostels#1486)", () => {
	const wave1 =
		"**341** - takes:implement.\n" +
		"**353** - takes:triage.\n" +
		"Wave 1 of 2 — frontier 60: 2 dispatched + 42 disqualified + 16 pending band read.";

	it("does not fire on wave 1's partial count, which never fills the machine", () => {
		armed(60, 2);
		expect(run(wave1).blocked).toBe(false);
	});

	it("fires on the closing wave once both waves reach the slot count", () => {
		armed(60, 3);
		expect(run(wave1).blocked).toBe(false);
		const r = run(
			"**366** - takes:implement.\nWave 2 of 2 — frontier 60: 3 dispatched + 57 disqualified.",
		);
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain(
			"3 session(s) against the 3 free admission slot",
		);
		expect(r.reason).toContain("counting both waves");
	});

	it("clears once the closing wave names what was cut", () => {
		armed(60, 3);
		run(wave1);
		expect(
			run(
				"**366** - takes:implement.\n**Admission cut:** #401, #402.\nWave 2 of 2 — frontier 60: 3 dispatched + 57 disqualified.",
			).blocked,
		).toBe(false);
	});

	it("counts a restated wave-1 line once, not twice", () => {
		armed(60, 3);
		run(wave1);
		/* Two sessions launched in all, both named again here: the set has not
		 * filled three slots, so no cut line is owed. */
		expect(
			run(
				"**341** - takes:implement.\n**353** - takes:triage.\nWave 2 of 2 — frontier 60: 2 dispatched + 58 disqualified.",
			).blocked,
		).toBe(false);
	});
});

describe("the completion mark across two waves (mantahostels#1486)", () => {
	const wave1 =
		"**341** - takes:implement.\n" +
		"Wave 1 of 2 — frontier 60: 1 dispatched + 43 disqualified + 16 pending band read.";

	it("does not demand one of wave 1, which ends waiting on the band read", () => {
		armed();
		expect(run(wave1, dir, true).blocked).toBe(false);
	});

	it("still demands one of the closing wave", () => {
		armed();
		run(wave1, dir, true);
		const r = run(
			"**366** - takes:implement.\nWave 2 of 2 — frontier 60: 2 dispatched + 58 disqualified.",
			dir,
			true,
		);
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("completion mark");
	});
});

describe("the wave state on the marker (mantahostels#1486)", () => {
	it("records the launched sessions, and drops them at the closing wave", () => {
		armed();
		run(
			"**341** - takes:implement.\nWave 1 of 2 — frontier 60: 1 dispatched + 43 disqualified + 16 pending band read.",
		);
		expect(selectionMarker.read(root, sid)?.wave?.keys).toEqual(["341"]);
		run(
			"**366** - takes:implement.\nWave 2 of 2 — frontier 60: 2 dispatched + 58 disqualified.",
		);
		expect(selectionMarker.read(root, sid)?.wave).toBe(null);
	});

	it("records nothing for a wave-1 message that was blocked", () => {
		armed();
		run(
			"**341** - takes:implement.\nWave 1 of 2 — frontier 60: 1 dispatched + 40 disqualified + 16 pending.",
		);
		expect(selectionMarker.read(root, sid)?.wave).toBe(null);
	});

	it("keys a session on its bolded numbers, not the trailing prose", () => {
		armed();
		run(
			"**341, 353** - takes:implement. #341 first: blocks #412.\nWave 1 of 2 — frontier 60: 2 dispatched + 42 disqualified + 16 pending band read.",
		);
		expect(selectionMarker.read(root, sid)?.wave?.keys).toEqual(["341,353"]);
	});

	it("mints no wave for a session that ran no selection", () => {
		expect(
			selectionMarker.openWave(root, "never-ran-a-selection", ["341"]),
		).toBe(false);
	});
});

describe("what the closing wave may not do (mantahostels#1486)", () => {
	const wave1 =
		"**341, 353** - takes:implement.\n" +
		"Wave 1 of 2 — frontier 60: 2 dispatched + 42 disqualified + 16 pending band read.";

	it("blocks a partial line carrying no `Wave k of n` prefix", () => {
		armed();
		const r = run(
			"**341** - takes:implement.\nFrontier 60: 1 dispatched + 43 disqualified + 16 pending.",
		);
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("no `Wave <k> of <n>` prefix");
	});

	it("blocks a closing sum that drops wave 1's issues from `dispatched`, naming the issues already launched", () => {
		armed();
		run(wave1);
		const r = run(
			"**366** - takes:implement.\nWave 2 of 2 — frontier 60: 1 dispatched + 59 disqualified.",
		);
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("already launched 2 issue(s): #341, #353");
	});

	it("passes a closing sum that counts both waves' issues", () => {
		armed();
		run(wave1);
		expect(
			run(
				"**366** - takes:implement.\nWave 2 of 2 — frontier 60: 3 dispatched + 57 disqualified.",
			).blocked,
		).toBe(false);
	});

	it("counts a merged bundle restated as one line per member as zero new sessions", () => {
		armed(60, 3);
		run(wave1);
		/* One session launched, restated here as two lines. The set has not
		 * filled three slots, so no admission-cut line is owed. */
		expect(
			run(
				"**341** - takes:implement.\n**353** - takes:implement.\nWave 2 of 2 — frontier 60: 2 dispatched + 58 disqualified.",
			).blocked,
		).toBe(false);
	});
});

describe("the band no command opens — the line's third term (mantahostels#1626)", () => {
	const sum = (u: string) =>
		`${DISPATCH}\n\nFrontier 60: 3 dispatched + ${57 - Number(u)} disqualified + ${u} no command.`;

	it("passes a three-term line whose counts add to the measured frontier", () => {
		armed(60, null, 4);
		expect(run(sum("4")).blocked).toBe(false);
	});

	it("blocks a `<U>` the run never measured, and prints both figures", () => {
		armed(60, null, 4);
		const r = run(sum("2"));
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("`2 no command`");
		expect(r.reason).toContain("measured 4 frontier issue(s)");
	});

	it("blocks a two-term line where the run measured a band, quoting the measured count — mantahostels#1626's defect", () => {
		// The old shape: the takes:human issues lumped into `disqualified`, the
		// sum adding up, and nothing showing a queue nobody is draining.
		armed(60, null, 4);
		const r = run(
			`${DISPATCH}\n\nFrontier 60: 3 dispatched + 57 disqualified.`,
		);
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("no `no command` term at all");
		expect(r.reason).toContain("measured 4 frontier issue(s)");
	});

	it("passes a two-term line where the run measured an empty band", () => {
		armed(60, null, 0);
		expect(
			run(`${DISPATCH}\n\nFrontier 60: 3 dispatched + 57 disqualified.`)
				.blocked,
		).toBe(false);
	});

	it("leaves the term unpinned against a marker minted before the field existed", () => {
		armed(60, null, null);
		expect(run(sum("4")).blocked).toBe(false);
		expect(
			run(`${DISPATCH}\n\nFrontier 60: 3 dispatched + 57 disqualified.`)
				.blocked,
		).toBe(false);
	});

	it("counts the term in the sum, so three that do not add up are refused, naming the term and the total", () => {
		armed(60, null, 4);
		const r = run(
			`${DISPATCH}\n\nFrontier 60: 3 dispatched + 57 disqualified + 4 no command.`,
		);
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("4 no command");
		expect(r.reason).toContain("= 64");
	});

	it("tells the frontier apart from the band, correcting the frontier first", () => {
		// A mid-run close moves both, and two demands at once is what mantahostels#1622 says
		// this ordering avoids.
		armed(60, null, 4);
		const r = run(
			`${DISPATCH}\n\nFrontier 59: 3 dispatched + 52 disqualified + 4 no command.`,
		);
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("measured 60");
		expect(r.reason).not.toContain("no command` term at all");
	});

	it("says the band is idle founder work, not a fourth disqualifier", () => {
		armed(60, null, 4);
		const r = run(sum("2"));
		expect(r.reason).toContain("BAND, not a fourth disqualifier");
		expect(r.reason).toContain("takes:human");
		expect(r.reason).toContain("unblocked founder work sitting idle");
	});

	it("tolerates the hyphenated spelling", () => {
		armed(60, null, 4);
		expect(
			run(
				`${DISPATCH}\n\nFrontier 60: 3 dispatched + 53 disqualified + 4 no-command.`,
			).blocked,
		).toBe(false);
	});

	it("carries the term through a two-wave dispatch, ahead of pending", () => {
		armed(60, null, 4);
		const wave1 = `${DISPATCH}\n\nWave 1 of 2 — frontier 60: 3 dispatched + 37 disqualified + 4 no command + 16 pending band read.`;
		expect(run(wave1).blocked).toBe(false);
		const closing = `${DISPATCH}\n\nWave 2 of 2 — frontier 60: 5 dispatched + 51 disqualified + 4 no command.`;
		expect(run(closing).blocked).toBe(false);
	});

	it("pins the band on wave 1 too, so a short set is caught at the first turn", () => {
		armed(60, null, 4);
		const r = run(
			`${DISPATCH}\n\nWave 1 of 2 — frontier 60: 3 dispatched + 39 disqualified + 2 no command + 16 pending band read.`,
		);
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("measured 4 frontier issue(s)");
	});

	it("reads the count back off the marker the run wrote", () => {
		selectionMarker.record(root, {
			sessionId: sid,
			frontier: 60,
			noCommand: 4,
		});
		expect(selectionMarker.read(root, sid)?.noCommand).toBe(4);
	});

	it("records no count where the run measured none", () => {
		selectionMarker.record(root, { sessionId: sid, frontier: 60 });
		expect(selectionMarker.read(root, sid)?.noCommand).toBe(null);
	});
});

describe("what the mantahostels#1626 review caught", () => {
	it("echoes no third term back at a line that stated none", () => {
		// Quoting `+ 0 no command` at a two-term line reads as a term it wrote.
		armed(60, null, 0);
		const r = run(`${DISPATCH}\n\nFrontier 60: 3 dispatched + 5 disqualified.`);
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("does not add up");
		expect(r.reason).not.toContain("no command =");
		expect(r.reason).not.toContain("0 no command");
	});

	it("says the term is misplaced, not missing, when it follows pending", () => {
		// The regex's order is fixed, so a term after `pending` is carried by the
		// line and read by nothing — and "no term at all" sends the session
		// looking for something already on the page.
		armed(60, null, 4);
		const r = run(
			`${DISPATCH}\n\nWave 1 of 2 — frontier 60: 3 dispatched + 37 disqualified + 16 pending band read + 4 no command.`,
		);
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("after `pending`");
		expect(r.reason).toContain("its count is still read");
		// Not sent recounting a set that is right.
		expect(r.reason).not.toContain("does not add up");
	});

	it("still says the term is missing where the line carries none anywhere", () => {
		armed(60, null, 4);
		const r = run(
			`${DISPATCH}\n\nWave 1 of 2 — frontier 60: 3 dispatched + 41 disqualified + 16 pending band read.`,
		);
		expect(r.reason).toContain("no `no command` term at all");
	});

	it("offers the re-run escape on a band that does not match the marker", () => {
		// §4 of mantahostels#1626 asks for the same escape the frontier pin carries: a
		// session whose frontier genuinely moved re-runs the script.
		armed(60, null, 4);
		const r = run(
			`${DISPATCH}\n\nFrontier 60: 3 dispatched + 55 disqualified + 2 no command.`,
		);
		expect(r.reason).toContain("Re-run the script if the frontier has");
	});

	it("prints both wave templates carrying the third term", () => {
		armed(60, null, 4);
		const opening = run(DISPATCH).reason;
		expect(opening).toContain(
			"Wave 1 of 2 — frontier <F>: <D> dispatched + <Q> disqualified + <U> no command + <P> pending band read.",
		);
		// The closing template reaches a session only once a wave is open.
		expect(
			run(
				`${DISPATCH}\n\nWave 1 of 2 — frontier 60: 3 dispatched + 37 disqualified + 4 no command + 16 pending band read.`,
			).blocked,
		).toBe(false);
		const owed = run("Still waiting on the band read.");
		expect(owed.blocked).toBe(true);
		expect(owed.reason).toContain(
			"Wave 2 of 2 — frontier <F>: <D> dispatched + <Q> disqualified + <U> no command.",
		);
		expect(owed.reason).toContain("three counts must add to 60");
	});
});

describe("one block budget per stake tier (mantahostels#3431)", () => {
	const misplaced = (disqualified: number) =>
		`${DISPATCH}\n\nWave 1 of 2 — frontier 60: 3 dispatched + ${disqualified} disqualified + 16 pending band read + 4 no command.`;
	const right = misplaced(37);
	const wrong = misplaced(30);
	const wrongSum = `${DISPATCH}\n\nFrontier 60: 3 dispatched + 50 disqualified + 4 no command.`;
	/* The block counters live under gr_markers_dir (.claude/tmp/markers), not
	 * the throwaway root itself — hook-block.js's counterPath (mantahostels#3515 F8,
	 * issue #2). */
	const counter = (prefix: string) =>
		path.join(markerRoot.markersDir(root), `${prefix}${sid}`);

	it("still refuses a wrong sum after three term-position blocks", () => {
		armed(60, null, 4);
		// exempt (mantahostels#2145): the shape reason is pinned by "says the term is
		// misplaced, not missing, when it follows pending"; this counts them.
		const verdicts = [1, 2, 3, 4].map(() => run(right).blocked);
		expect(verdicts).toEqual([true, true, true, false]);
		const r = run(wrongSum);
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("does not add up");
	});

	it("reads a misplaced term's count, so right counts pass once the shape cap is spent", () => {
		armed(60, null, 4);
		for (const _ of [1, 2, 3]) run(right);
		expect(run(right).blocked).toBe(false);
		// The wave went out, so it is recorded and the closing sum is owed.
		expect(selectionMarker.read(root, sid)?.wave?.keys).toEqual([
			"341,353,366",
		]);
	});

	it("names both tiers' defects in one block and charges each counter once", () => {
		armed(60, null, 4);
		const r = run(wrong);
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("after `pending`");
		expect(r.reason).toContain("does not add up");
		expect(fs.readFileSync(counter(".selection-sum-nagged-"), "utf8")).toBe(
			"1\n",
		);
		expect(
			fs.readFileSync(counter(".selection-sum-shape-nagged-"), "utf8"),
		).toBe("1\n");
	});

	it("reads a misplaced count off the accounting line, never the prose after it", () => {
		armed(60, null, 4);
		const r = run(
			`${DISPATCH}\n\nWave 1 of 2 — frontier 60: 3 dispatched + 41 disqualified + 16 pending band read.\n\nThe pending band read may find 4 no command more.`,
		);
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("no `no command` term at all");
		expect(r.reason).not.toContain("after `pending`");
	});

	it("records no wave where the owed block could not be emitted", () => {
		armed(60, null, 4);
		// A directory at the counter path: it reads as 0 but will not write.
		fs.mkdirSync(counter(".selection-sum-shape-nagged-"));
		expect(run(right).blocked).toBe(false);
		expect(selectionMarker.read(root, sid)?.wave ?? null).toBe(null);
	});

	it("drops a capped tier from the block and keeps the other's", () => {
		armed(60, null, 4);
		for (const _ of [1, 2, 3]) run(wrongSum);
		const r = run(wrong);
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("after `pending`");
		expect(r.reason).not.toContain("does not add up");
	});
});
