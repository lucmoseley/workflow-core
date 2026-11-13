// @vitest-environment node
/*
 * rescue-sessions-takeover.test.ts — `rescue-sessions.js takeover` through
 * its command line (#621, spec #617): the boundary set lib/rescue-takeover.js's
 * module cases (lib/rescue-takeover.test.ts) leave to the program (#5157) — a
 * takeover across the real oracle adapter, `claude stop`, `gh` and WFC_PROC,
 * a GHOST stopped through them, and the --despite refusals lib/cli-args.js
 * shares with the core, each through the shell's exit.
 *
 * Fixtures: scripts/lib/rescue-testkit.ts. The real script runs in a sandbox
 * holding a real arbiter store, against the kit's fake `claude` oracle, fake
 * `gh` and fabricated `/proc`, so no live session can be stopped by a test.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { freshSandbox, issueClaims } from "./lib/arbiter-testkit";
import {
	EXIT,
	holderRow,
	PID,
	rescueKit,
	SHORT,
	SID,
	said,
	withTracker,
} from "./lib/rescue-testkit";
import { shellQuote } from "./lib/sh-quote.js";

const CLAIMS_LIB = path.resolve(__dirname, "lib", "arbiter-issue-claims.js");
const N = 621;

const sb = freshSandbox(withTracker);
const {
	plan,
	transcript,
	lists,
	between,
	proc,
	writeTranscript,
	jobState,
	ghostJob,
	run,
} = rescueKit(sb);

const events = () => path.join(sb.dir, "events");
const snapshotDir = () =>
	path.join(sb.repo, ".claude", "tmp", "rescue", `${N}-${SHORT}`);

/** Every `gh` call logged; a comment logs who holds the claim as it posts. */
const ghBefore = () => [
	`echo "gh $1 $2" >> ${shellQuote(events())}`,
	'if [ "$1 $2" = "issue comment" ]; then',
	`  ${shellQuote(process.execPath)} -e ${shellQuote(`console.log("claim held by " + require(${JSON.stringify(CLAIMS_LIB)}).readIssueClaims(${N}).map((e) => e.record.sessionId).sort().join(","))`)} >> ${shellQuote(events())}`,
	`  cat > ${shellQuote(path.join(sb.dir, "comment.md"))}`,
	`  [ -f ${shellQuote(path.join(sb.dir, "comment-fails"))} ] && { echo "HTTP 502" >&2; exit 1; }`,
	"  exit 0",
	"fi",
];

/**
 * A holder whose turn ended on `waiting:` with nothing running — FROZEN —
 * claiming #621, with a job record naming its intent, and a stop that the
 * oracle then reads as `stopped`.
 */
const frozenHolder = () => {
	lists([holderRow()]);
	lists([holderRow({ state: "stopped" })], plan(), "agents-after-stop.json");
	writeTranscript([said("Delegated the suite.\n\nwaiting: the suite run")]);
	jobState({
		state: "working",
		intent: `/implement ${N}`,
		name: "Implement 621",
		cwd: sb.repo,
		inFlight: { tasks: 0, queued: 0 },
	});
	proc(PID, 1, 1000, "claude");
	issueClaims.claimIssue(N, { sessionId: SID });
};

/** The stop is logged with whether the snapshot was already on disk. */
const takeover = (args: string[] = ["--issue", String(N)]) =>
	run("takeover", args, {
		ghBefore: ghBefore(),
		onStop: [
			`s=no; [ -f ${shellQuote(path.join(snapshotDir(), "index.json"))} ] && s=yes`,
			`echo "stop $2 snapshot=$s" >> ${shellQuote(events())}`,
		],
	});

const readLog = () => {
	try {
		return fs.readFileSync(events(), "utf8").split("\n").filter(Boolean);
	} catch {
		return [];
	}
};
const stopped = () => readLog().some((e) => e.startsWith("stop "));
const commented = () => readLog().includes("gh issue comment");
const readHolders = () =>
	issueClaims
		.readIssueClaims(N)
		.map((e: { record: { sessionId: string } }) => e.record.sessionId);

describe("takeover through the program", () => {
	it("snapshots, stops, confirms, claims and comments, in that order", async () => {
		frozenHolder();
		const r = await takeover();
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
		const steps = r.stdout
			.split("\n")
			.map((l) => l.split(":")[0])
			.filter((s) =>
				["snapshot", "stopped", "confirmed", "claimed", "commented"].includes(
					s,
				),
			);
		expect(steps).toEqual([
			"snapshot",
			"stopped",
			"confirmed",
			"claimed",
			"commented",
		]);
		const log = readLog().filter((e) => !e.startsWith("gh api"));
		expect(log).toEqual([
			`stop ${SHORT} snapshot=yes`,
			"gh issue edit",
			"gh issue comment",
			expect.stringMatching(/^claim held by .*sandbox/),
		]);
		expect(readHolders()).toContain("sandbox");
		for (const f of ["index.json", `${SHORT}.narration.txt`, "RESUMPTION.md"])
			expect(fs.existsSync(path.join(snapshotDir(), f))).toBe(true);
	});

	it("refuses --despite with no --reason, before any write", async () => {
		frozenHolder();
		between(`printf 'x\\n' >> ${shellQuote(transcript())}`);
		for (const [extra, why] of [
			[[], "--despite needs --reason"],
			/* lib/cli-args.js refuses a valueless flag before takeover runs. */
			[["--reason"], "--reason needs a value"],
			[["--reason", " "], "--despite needs --reason"],
		] as const) {
			const r = await takeover([
				"--issue",
				String(N),
				"--despite",
				"SLOW",
				...extra,
			]);
			expect(r.status).toBe(EXIT.REFUSED);
			expect(r.stderr).toContain(why);
		}
		expect(stopped()).toBe(false);
		expect(fs.existsSync(snapshotDir())).toBe(false);
	});

	/* #1989 */
	it("keeps its record, stops it and prints the re-dispatch, adopting nothing", async () => {
		ghostJob(`/implement ${N}`);
		lists([], plan(), "agents-after-stop.json");
		const r = await takeover();
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
		expect(r.stdout.split(/\s/)[0]).toBe("GHOST");
		expect(readLog()).toContain(`stop ${SHORT} snapshot=no`);
		expect(r.stdout).toContain(
			`scripts/dispatch-sessions.js opus '/implement ${N}'`,
		);
		expect(fs.existsSync(path.join(snapshotDir(), `${SHORT}.state.json`))).toBe(
			true,
		);
		expect(readHolders()).toEqual([]);
		expect(commented()).toBe(false);
	});
});
