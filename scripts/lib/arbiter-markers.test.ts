// @vitest-environment node
/*
 * arbiter-markers.js's own suite: the session-suffixed marker files — the
 * concision backstop's, and guard-entry.js's rule latches — are swept only for
 * a finished session, and nothing that is not a marker is touched
 * (mantahostels#1804, mantahostels#3515).
 *
 * Each case runs in arbiter-testkit's sandbox with sessions registered live or
 * finished by hand and markers backdated on disk, so ageing needs no wait.
 *
 * The sweep runs detached at every `SessionStart` (.claude/settings.json):
 * loosen a case here and a live session's latches vanish and its rules are
 * handed over again, its backstop base is lost, or a file beside the markers
 * is deleted.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	finished,
	freshSandbox,
	live,
	markers as markersMod,
} from "./arbiter-testkit";
import { readParkedBy, writeParkedBy } from "./parked.js";

/* An hour past arbiter-markers.js's 24-hour MARKER_AGE_MS. */
const AGED_MS = 25 * 60 * 60 * 1000;

const sb = freshSandbox();

describe("marker sweep — the backstop's per-session files in the repo root", () => {
	const prefixes = [
		".concision-base-",
		".concision-nagged-",
		".concision-pass-",
		".codereview-nagged-",
		".codereview-pass-",
		".parked-blocked-",
	];

	/* Since F8 (mantahostels#3515, #2) the family lives under
	 * .claude/tmp/markers/, not the repo root directly. A function, not a hoisted
	 * const: `sb.repo` is re-pointed at a fresh directory per test, and a value
	 * captured once at describe-time would keep the FIRST test's path. */
	const markersDir = () => path.join(sb.repo, ".claude", "tmp", "markers");

	/** The five files concision-backstop.sh leaves behind for one session. */
	const markers = (sessionId: string, old = false) => {
		fs.mkdirSync(markersDir(), { recursive: true });
		const when = new Date(Date.now() - AGED_MS);
		for (const p of prefixes) {
			const full = path.join(markersDir(), p + sessionId);
			fs.writeFileSync(full, "");
			if (old) fs.utimesSync(full, when, when);
		}
	};

	const surviving = (sessionId: string) =>
		prefixes.filter((p) =>
			fs.existsSync(path.join(markersDir(), p + sessionId)),
		);

	it("spares a live session's markers however old they are", () => {
		// Deleting .concision-base- mid-session is worse than the litter: the
		// backstop exits silently without it, so the quality gate goes dark.
		markers("alice", true);
		live(sb, "alice");

		markersMod.pruneMarkers();

		expect(surviving("alice")).toEqual(prefixes);
	});

	it("sweeps a finished session's aged markers", () => {
		markers("bob", true);
		finished(sb, "bob");

		markersMod.pruneMarkers();

		expect(surviving("bob")).toEqual([]);
	});

	it("keeps a finished session's aged park marker, whose park may still wait on the founder (#3589)", () => {
		markers("bob", true);
		const before = new Set(fs.readdirSync(markersDir()));
		writeParkedBy("bob", [12]);
		const when = new Date(Date.now() - AGED_MS);
		for (const f of fs.readdirSync(markersDir()))
			if (!before.has(f)) fs.utimesSync(path.join(markersDir(), f), when, when);
		finished(sb, "bob");

		markersMod.pruneMarkers();

		expect(readParkedBy("bob")).toEqual([12]);
		expect(surviving("bob")).toEqual([]);
	});

	it("sweeps the markers of a session that was never registered", () => {
		markers("ghost", true);

		markersMod.pruneMarkers();

		expect(surviving("ghost")).toEqual([]);
	});

	it("leaves a finished session's fresh markers alone", () => {
		// The grace covers a session whose registry entry has not landed by the
		// time its own start hook fires.
		markers("bob");
		finished(sb, "bob");

		markersMod.pruneMarkers();

		expect(surviving("bob")).toEqual(prefixes);
	});

	it("spares the close-check log however old it is (#1101)", () => {
		const log = path.join(markersDir(), ".close-check-log.jsonl");
		fs.mkdirSync(markersDir(), { recursive: true });
		fs.writeFileSync(log, "{}\n");
		const when = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
		fs.utimesSync(log, when, when);

		markersMod.pruneMarkers();

		expect(fs.existsSync(log)).toBe(true);
	});

	it("touches nothing in the repo root that is not a marker", () => {
		fs.writeFileSync(path.join(sb.repo, "package.json"), "{}");
		fs.writeFileSync(path.join(sb.repo, ".gitignore"), "");
		const when = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
		for (const f of ["package.json", ".gitignore"])
			fs.utimesSync(path.join(sb.repo, f), when, when);

		markersMod.pruneMarkers();

		expect(fs.existsSync(path.join(sb.repo, "package.json"))).toBe(true);
		expect(fs.existsSync(path.join(sb.repo, ".gitignore"))).toBe(true);
	});

	it("sweeps a live session's aged markers when there is no registry at all", () => {
		// Absent is not unreadable, so this deletes rather than stopping.
		markers("alice", true);
		live(sb, "alice");
		fs.rmSync(path.join(sb.home, "sessions"), { recursive: true, force: true });

		markersMod.pruneMarkers();

		expect(surviving("alice")).toEqual([]);
	});
});

describe("rule-latch sweep — the .rule-injected- family (mantahostels#1804)", () => {
	const hour = 60 * 60 * 1000;
	/* Since F8 (mantahostels#3515, #2) the latches live under
	 * .claude/tmp/markers/, not the repo root directly. A function, not a hoisted
	 * const: `sb.repo` is re-pointed at a fresh directory per test. */
	const markersDir = () => path.join(sb.repo, ".claude", "tmp", "markers");
	/* The prefix guard-entry.js writes and the sweep matches, spelled here so
	 * each side is pinned to the same string: the latch cases below fail if the
	 * sweep's spelling moves, and the guard-entry.js case if the writer's does. */
	const latchPrefix = ".rule-injected-";

	/** One latch file, aged. `agent` is `main` for a parent, `a<agent_id>` under one. */
	const latch = (id: string, agent: string, sessionId: string, ms: number) => {
		fs.mkdirSync(markersDir(), { recursive: true });
		const full = path.join(
			markersDir(),
			`${latchPrefix}${id}-${agent}-${sessionId}`,
		);
		const when = new Date(Date.now() - ms);
		fs.writeFileSync(full, "");
		fs.utimesSync(full, when, when);
		return full;
	};

	/* mantahostels#3382 moved the breadcrumbs off the repository root into a directory of
	 * their own. Three things have to agree on where that is, and only one of
	 * them is code the other two import: hook-record.js writes there,
	 * pruneMarkers sweeps there, and .gitignore hides it. The sweep is covered by
	 * session-arbiter.test.ts's breadcrumb cases; this is the .gitignore limb,
	 * which nothing else would catch — an un-ignored directory shows up as one
	 * `??` entry that quietly grows to thousands of files. */
	it("keeps the breadcrumb directory out of git", () => {
		/* `git check-ignore` rather than a substring search of .gitignore: a
		 * commented-out or negated line satisfies the substring and ignores
		 * nothing. This asks git the question the rule actually cares about.
		 *
		 * Since F8 (mantahostels#3515, #2) the breadcrumbs sit under
		 * `.claude/tmp/markers/`, covered by the `.claude/tmp/` ignore line rather
		 * than a dedicated one — so the probe is `recordsDir()`'s real path, not a
		 * bare `DIR_NAME/probe` relative to the repo root. */
		const hookRecord = require("./hook-record.js");
		const repo = path.join(__dirname, "..", "..");
		// Laid out under a throwaway root, not `recordsDir(repo)`: that call
		// `mkdirSync`s the markers directory as a side effect, which this
		// check-only test must not do to the real repo.
		const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "breadcrumb-dir-"));
		const rel = path.relative(scratch, hookRecord.recordsDir(scratch));
		fs.rmSync(scratch, { recursive: true, force: true });
		const probe = path.join(repo, rel, "probe");
		const res = spawnSync("git", ["check-ignore", "-q", "--no-index", probe], {
			cwd: repo,
		});
		expect(res.status).toBe(0);
	});

	it("spells the prefix guard-entry.js writes", () => {
		// The two are coupled by a string literal and nothing else: a rename on
		// either side leaves the sweep walking past a family that then never goes.
		const { writeLatches } = require("./guard-entry.js");
		writeLatches(
			{ root: sb.repo, payload: { session_id: "s" }, log: () => undefined },
			[{ name: "one", text: "" }],
		);
		expect(fs.readdirSync(markersDir())).toContain(`${latchPrefix}one-main-s`);
	});

	it("sweeps a finished session's aged latch", () => {
		const f = latch("one", "main", "ghost", 25 * hour);

		markersMod.pruneMarkers();

		expect(fs.existsSync(f)).toBe(false);
	});

	it("leaves a finished session's fresh latch alone", () => {
		const f = latch("one", "main", "ghost", 1 * hour);

		markersMod.pruneMarkers();

		expect(fs.existsSync(f)).toBe(true);
	});

	/*
	 * The whole reason this is a third pass rather than a MARKER_PREFIXES entry.
	 * That matcher recovers the id by slicing a FIXED prefix, which here lands
	 * inside the <agent> segment — so `main-alice` would be compared against the
	 * live ids, match none, and the latch would go at 24h under a running session,
	 * re-injecting a rule it has already been given.
	 */
	it("spares a live session's latch however old, past the agent segment", () => {
		const f = latch("one", "main", "alice", 30 * 24 * hour);
		live(sb, "alice");

		markersMod.pruneMarkers();

		expect(fs.existsSync(f)).toBe(true);
	});

	it("spares a subagent's latch under the live parent it is keyed to", () => {
		// A subagent's PreToolUse payload carries its PARENT's session_id, so the
		// agent id is the only discriminator and the parent is the only liveness
		// there is to read.
		const f = latch("one", "aac7cb4a45383cc850", "alice", 30 * 24 * hour);
		live(sb, "alice");

		markersMod.pruneMarkers();

		expect(fs.existsSync(f)).toBe(true);
	});

	it("sweeps a subagent's aged latch once its parent has finished", () => {
		const f = latch("one", "aac7cb4a45383cc850", "ghost", 25 * hour);
		finished(sb, "ghost");

		markersMod.pruneMarkers();

		expect(fs.existsSync(f)).toBe(false);
	});

	/* A live id must be the whole trailing segment, not merely a tail of it. */
	it("does not spare a latch whose id merely ends with a live id", () => {
		const f = latch("one", "main", "xalice", 25 * hour);
		live(sb, "alice");

		markersMod.pruneMarkers();

		expect(fs.existsSync(f)).toBe(false);
	});

	it("sweeps the sanitised marker guard-entry.js writes for an unusable session id", () => {
		// guard-entry.js replaces unsafe characters, so this matches no live id and
		// has nothing but the clock to retire it.
		const f = latch("one", "main", "___escape", 25 * hour);
		live(sb, "alice");

		markersMod.pruneMarkers();

		expect(fs.existsSync(f)).toBe(false);
	});

	it("deletes no latch when the registry itself cannot be read", () => {
		const f = latch("one", "main", "ghost", 25 * hour);
		fs.chmodSync(path.join(sb.home, "sessions"), 0o000);
		try {
			markersMod.pruneMarkers();
		} finally {
			fs.chmodSync(path.join(sb.home, "sessions"), 0o755);
		}

		expect(fs.existsSync(f)).toBe(true);
	});

	it("leaves a near-miss sharing the prefix's opening alone", () => {
		const f = path.join(sb.repo, ".rule-injection-notes");
		const when = new Date(Date.now() - 400 * 24 * hour);
		fs.writeFileSync(f, "");
		fs.utimesSync(f, when, when);

		markersMod.pruneMarkers();

		expect(fs.existsSync(f)).toBe(true);
	});
});
