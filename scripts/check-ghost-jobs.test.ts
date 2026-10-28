// @vitest-environment node
/*
 * Pins that check-ghost-jobs.js names a job whose record says "working" while
 * the `claude agents` oracle shows no process for it, spares a live or
 * too-young one, goes silent when the oracle is blind, and never writes a job
 * record.
 *
 * Every test drives the real script end to end, the way `npm run status`
 * does, with a fake `claude` on WFC_CLAUDE_BIN standing in for the daemon
 * and every config dir pointed inside the case's own temp dir — so no run can
 * read or write the founder's live job store.
 *
 * The fixture shape is the ruling (mantahostels#1495 — a job whose record says "working"
 * while the oracle lists it carrying no `pid`): that, and not a missing record,
 * is what a ghost looked like.
 *
 * It reports through `npm run status` and is named by dispatch-sessions.sh:
 * loosen a case and either a ghost sits "working" in the agents view for good,
 * or a live job is called dead and its session retired by hand.
 */

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.join(__dirname, "check-ghost-jobs.js");

let dir: string;
/** The second config dir, standing in for this machine's second Claude plan. */
let second: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-ghost-jobs-"));
	second = path.join(dir, "second");
	fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
	fs.mkdirSync(path.join(dir, "jobs"), { recursive: true });
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const jobPath = (name: string, store = dir) =>
	path.join(store, "jobs", name, "state.json");

/** A job record on disk. `agedMinutes` back-dates its last update. */
function job(
	name: string,
	rec: Record<string, unknown> = {},
	agedMinutes = 60 * 8,
	store = dir,
): void {
	const at = new Date(Date.now() - agedMinutes * 60_000).toISOString();
	fs.mkdirSync(path.join(store, "jobs", name), { recursive: true });
	fs.writeFileSync(
		jobPath(name, store),
		JSON.stringify({
			state: "working",
			detail: "starting…",
			sessionId: `${name}-0000-0000-0000-000000000000`,
			intent: `/implement ${name}`,
			cwd: "/home/lucmo/mantahostels",
			createdAt: at,
			updatedAt: at,
			firstTerminalAt: null,
			...rec,
		}),
	);
}

/** A `claude` stand-in: `agents --json` prints `body`, exits `code`. */
function fakeClaude(body: string, code = 0): void {
	const bin = path.join(dir, "bin", "claude");
	fs.writeFileSync(bin, `#!/bin/sh\ncat <<'EOF'\n${body}\nEOF\nexit ${code}\n`);
	fs.chmodSync(bin, 0o755);
}

/** An oracle record. Omit `pid` for the shape a ghost was seen in. */
const agent = (sessionId: string, pid?: number) => ({
	...(pid === undefined ? {} : { pid }),
	id: sessionId.slice(0, 8),
	sessionId,
	state: "working",
	kind: "background",
});

const listing = (...agents: object[]) => JSON.stringify(agents);

/*
 * A live neighbour carrying a pid. Every ghost fixture lists one: with the ghost
 * alone in the listing, "no pid on this record" and "the pid field has gone" are
 * the same reading, and the checker rightly refuses both.
 */
const HEALTHY = agent("neighbour-0000-0000-0000-00000000000", 4242);

/** A transcript for `sessionId`, last appended to `agedMinutes` ago. At 0 it
 * reads as live, which is the only thing most callers here want (mantahostels#2588). */
function transcript(sessionId: string, agedMinutes: number, store = dir) {
	const project = path.join(store, "projects", "a-project");
	fs.mkdirSync(project, { recursive: true });
	const file = path.join(project, `${sessionId}.jsonl`);
	fs.writeFileSync(file, "{}\n");
	if (agedMinutes) {
		const at = new Date(Date.now() - agedMinutes * 60_000);
		fs.utimesSync(file, at, at);
	}
	return file;
}

function run(...args: string[]) {
	return runAs("", ...args);
}

/** Under a session id, the shape every mid-session caller has. */
function runAs(sessionId: string, ...args: string[]) {
	const res = runInProcess(SCRIPT, args, {
		env: {
			...process.env,
			CLAUDE_CONFIG_DIR: dir,
			// Every plan, named explicitly so no sibling of the real temp root can
			// be swept into a case — _C included, or its default IS such a sibling.
			WFC_CLAUDE_CONFIG_A: dir,
			WFC_CLAUDE_CONFIG_B: second,
			WFC_CLAUDE_CONFIG_C: second,
			WFC_CLAUDE_BIN: path.join(dir, "bin", "claude"),
			CLAUDE_CODE_SESSION_ID: sessionId,
			WFC_REFILL_DIR: dir,
		},
	});
	return { ...res, out: `${res.stdout}${res.stderr}` };
}

describe("check-ghost-jobs", () => {
	it("flags a working job the oracle lists with no pid", () => {
		job("d06bf779");
		fakeClaude(listing(HEALTHY, agent("d06bf779-0000-0000-0000-000000000000")));

		const { out } = run();

		expect(out).toContain("GHOST-JOB");
		expect(out).toContain("listed with no process behind it");
		expect(out).toContain("/implement d06bf779");
	});

	it("flags a working job the oracle does not list at all as a GHOST-JOB", () => {
		job("gone");
		fakeClaude(listing(agent("someone-else-0000-0000-000000000000", 4242)));

		const { out } = run();

		expect(out).toContain("GHOST-JOB");
		expect(out).toContain("not listed at all");
	});

	it("says nothing about a working job backed by a listed process", () => {
		/* A fresh transcript, so this stays a case about the ghost test alone:
		 * a live job that has written nothing for hours is a
		 * HUNG-JOB (mantahostels#2588), and this fixture's record is eight hours old. */
		job("alive");
		transcript("alive-0000-0000-0000-000000000000", 0);
		fakeClaude(listing(agent("alive-0000-0000-0000-000000000000", 4242)));

		const { out, status } = run();

		expect(out).not.toContain("GHOST-JOB");
		expect(out).toContain("OK:");
		expect(status).toBe(0);
	});

	it("spares a job younger than the grace window", () => {
		job("young", {}, 5);
		fakeClaude(listing(HEALTHY, agent("young-0000-0000-0000-000000000000")));

		expect(run().out).not.toContain("GHOST-JOB");
	});

	it("--minutes moves the grace window", () => {
		job("young", {}, 5);
		fakeClaude(listing(HEALTHY, agent("young-0000-0000-0000-000000000000")));

		expect(run("--minutes", "2").out).toContain("GHOST-JOB");
		expect(run("--minutes", "600").out).not.toContain("GHOST-JOB");
	});

	it("reports a job whose timestamps will not parse, grace window or not", () => {
		job("odd", { createdAt: "not a date", updatedAt: "not a date" }, 0);
		fakeClaude(listing(HEALTHY, agent("odd-0000-0000-0000-000000000000")));

		const { out } = run();

		expect(out).toContain("GHOST-JOB");
		expect(out).toContain("stuck since an unreadable time");
	});

	it("ignores a job that is not in the working state", () => {
		job("done", { state: "done", firstTerminalAt: new Date().toISOString() });
		fakeClaude(listing(agent("other-0000-0000-0000-000000000000", 4242)));

		expect(run().out).not.toContain("GHOST-JOB");
	});

	it("degrades to silence when the oracle will not run", () => {
		job("d06bf779");
		fakeClaude("", 1);

		const { out, status } = run();

		expect(out).not.toContain("GHOST-JOB");
		expect(out).toContain("SKIP:");
		expect(out).toContain("went unjudged");
		expect(status).toBe(0);
	});

	it("degrades to silence when the oracle lists nothing at all", () => {
		job("d06bf779");
		fakeClaude("[]");

		const { out } = run();

		expect(out).not.toContain("GHOST-JOB");
		expect(out).toContain("SKIP:");
	});

	it("degrades to silence when no listed agent carries a pid at all", () => {
		// The field going away must not turn every working job into a ghost.
		job("a");
		job("b");
		fakeClaude(
			listing(
				agent("a-0000-0000-0000-000000000000"),
				agent("b-0000-0000-0000-000000000000"),
			),
		);

		const { out } = run();

		expect(out).not.toContain("GHOST-JOB");
		expect(out).toContain("SKIP:");
		expect(out).toContain("the shape it reports has changed");
	});

	it("judges nothing where the oracle has not listed the session it runs in (#1558)", () => {
		job("d06bf779");
		job("hung", {}, 60 * 8);
		fakeClaude(listing(HEALTHY, agent("hung-0000-0000-0000-000000000000", 99)));

		const { out, status } = runAs("not-in-the-listing-at-all");

		expect(out).not.toContain("GHOST-JOB");
		expect(out).not.toContain("HUNG-JOB");
		expect(out).toContain("SKIP:");
		expect(out).toContain("does not list this very session");
		expect(status).toBe(0);
	});

	it("judges where the oracle lists the session it runs in", () => {
		job("d06bf779");
		job("hung", {}, 60 * 8);
		fakeClaude(
			listing(
				HEALTHY,
				agent("hung-0000-0000-0000-000000000000", 99),
				agent("self-0000-0000-0000-000000000000", 7),
			),
		);

		const { out } = runAs("self-0000-0000-0000-000000000000");

		expect(out).toContain("GHOST-JOB");
		expect(out).toContain("HUNG-JOB");
	});

	it("never calls this session's own job a ghost", () => {
		job("mine");
		fakeClaude(listing(HEALTHY, agent("mine-0000-0000-0000-000000000000")));

		const { out } = runAs("mine-0000-0000-0000-000000000000");

		expect(out).not.toContain("GHOST-JOB");
	});

	it("sweeps the job store of every config dir, not just its own", () => {
		job("elsewhere", {}, 60 * 8, second);
		fakeClaude(listing(agent("other-0000-0000-0000-000000000000", 4242)));

		const { out } = run();

		expect(out).toContain("GHOST-JOB");
		expect(out).toContain("/implement elsewhere");
	});

	it("skips when not one job store will open", () => {
		fs.rmSync(path.join(dir, "jobs"), { recursive: true, force: true });
		fakeClaude(listing(agent("other-0000-0000-0000-000000000000", 4242)));

		const { out, status } = run();

		expect(out).toContain("SKIP:");
		expect(out).toContain("could be read");
		expect(status).toBe(0);
	});

	it("reports a state.json that will not parse, without calling it a ghost", () => {
		fs.mkdirSync(path.join(dir, "jobs", "broken"), { recursive: true });
		fs.writeFileSync(jobPath("broken"), "{not json");
		fakeClaude(listing(agent("other-0000-0000-0000-000000000000", 4242)));

		const { out } = run();

		expect(out).toContain("UNREADABLE-JOB");
		expect(out).not.toContain("GHOST-JOB");
	});

	it("reports a record naming no session, without calling it a ghost", () => {
		job("nameless", { sessionId: null });
		fakeClaude(listing(agent("other-0000-0000-0000-000000000000", 4242)));

		const { out } = run();

		expect(out).toContain("UNREADABLE-JOB");
		expect(out).toContain("names no session");
		expect(out).not.toContain("GHOST-JOB");
	});

	it("does not point an unreadable-only report at a roster path it never printed", () => {
		fs.mkdirSync(path.join(dir, "jobs", "broken"), { recursive: true });
		fs.writeFileSync(jobPath("broken"), "{not json");
		fakeClaude(listing(agent("other-0000-0000-0000-000000000000", 4242)));

		const { out } = run();

		expect(out).toContain("UNREADABLE-JOB");
		// The roster-route remedy only ever applies to a GHOST-JOB, which names a
		// session; an unreadable-only report must not dangle a reference to a
		// roster path this run never printed.
		expect(out).not.toContain("To actually retire a GHOST-JOB above");
		expect(out).not.toContain("roster.json");
	});

	it("adds the roster-does-not-apply note only when a ghost's own remedy is also printed", () => {
		job("d06bf779");
		fs.mkdirSync(path.join(dir, "jobs", "broken"), { recursive: true });
		fs.writeFileSync(jobPath("broken"), "{not json");
		fakeClaude(listing(HEALTHY, agent("d06bf779-0000-0000-0000-000000000000")));

		const { out } = run();

		expect(out).toContain("GHOST-JOB");
		expect(out).toContain("UNREADABLE-JOB");
		expect(out).toContain("needs its own investigation");
	});

	it("never writes a job record", () => {
		job("d06bf779");
		fakeClaude(listing(HEALTHY, agent("d06bf779-0000-0000-0000-000000000000")));
		const before = fs.readFileSync(jobPath("d06bf779"), "utf8");

		run();

		expect(fs.readFileSync(jobPath("d06bf779"), "utf8")).toBe(before);
	});

	it("tells the reader what to do about a ghost, and that nothing was cleared", () => {
		job("d06bf779");
		fakeClaude(listing(HEALTHY, agent("d06bf779-0000-0000-0000-000000000000")));

		const { out } = run();

		expect(out).toContain("Nothing was cleared");
		expect(out).toContain("check its transcript is absent");
		expect(out).toContain("Keep a copy first");
	});

	it("names the roster route, not the state.json edit, as the retirement remedy (mantahostels#2049)", () => {
		job("d06bf779");
		fakeClaude(listing(HEALTHY, agent("d06bf779-0000-0000-0000-000000000000")));

		const { out } = run();

		// The remedy that only hides the ghost from this checker must not be
		// offered as the way to retire one — as an imperative ("set …"), under
		// any wording, not just the one sentence mantahostels#1495 originally printed.
		expect(out).not.toMatch(/\bset\b[^.]*state\.json[^.]*"done"/i);
		expect(out).toContain(
			'Editing state.json\'s "state" to "done" does NOT stop it',
		);
		expect(out).toContain("hides the job from THIS checker's own sweep");
		// The actual route: the daemon's roster, both pids, verified before signalling.
		expect(out).toContain("roster.json");
		expect(out).toContain("replPid");
		expect(out).toContain("/proc/<pid>/stat field 22");
		expect(out).toContain("SIGTERM both pids");
	});

	describe("the refill loop as the route (#2467)", () => {
		let loop: ChildProcess | null = null;
		afterEach(() => {
			loop?.kill();
			loop = null;
		});

		it("names the loop where it runs, and not where it does not", () => {
			job("d06bf779");
			fakeClaude(
				listing(HEALTHY, agent("d06bf779-0000-0000-0000-000000000000")),
			);
			expect(run().out).not.toContain("The refill loop");

			loop = spawn(
				process.execPath,
				["-e", "setInterval(() => {}, 1000)", "refill-loop.js"],
				{ stdio: "ignore" },
			);
			fs.writeFileSync(path.join(dir, ".refill-loop.pid"), String(loop.pid));
			expect(run().out).toContain(
				`The refill loop (pid ${loop.pid}) retires a GHOST-JOB`,
			);
		});
	});

	it("prints the roster path for a ghost's own config dir", () => {
		job("d06bf779");
		fakeClaude(listing(HEALTHY, agent("d06bf779-0000-0000-0000-000000000000")));

		const { out } = run();

		expect(out).toContain(path.join(dir, "daemon", "roster.json"));
	});

	it("--notify reports each ghost once, and always exits 0", () => {
		job("d06bf779");
		fakeClaude(listing(HEALTHY, agent("d06bf779-0000-0000-0000-000000000000")));

		const first = run("--notify");
		expect(first.out).toContain("GHOST-JOB");
		expect(first.status).toBe(0);

		const rerun = run("--notify");
		expect(rerun.out).not.toContain("GHOST-JOB");
		expect(rerun.status).toBe(0);
	});

	/* The stamp holds every ghost STANDING, not the ones this run happened to
	 * report — stamping the reported set alone would drop the older ones and
	 * report them again at the run after next (mantahostels#1975). Three runs, because two
	 * cannot tell the two apart. */
	it("--notify keeps an older ghost stamped once a newer one joins it", () => {
		job("first");
		fakeClaude(listing(HEALTHY, agent("first-0000-0000-0000-000000000000")));
		expect(run("--notify").out).toContain("/implement first");

		job("second");
		fakeClaude(
			listing(
				HEALTHY,
				agent("first-0000-0000-0000-000000000000"),
				agent("second-0000-0000-0000-00000000000"),
			),
		);
		const two = run("--notify").out;
		expect(two).toContain("/implement second");
		expect(two).not.toContain("/implement first");

		expect(run("--notify").out).not.toContain("GHOST-JOB");
	});

	it("--notify reports an unreadable record once — nothing ever repairs one", () => {
		fs.mkdirSync(path.join(dir, "jobs", "broken"), { recursive: true });
		fs.writeFileSync(jobPath("broken"), "{not json");
		fakeClaude(listing(agent("other-0000-0000-0000-000000000000", 4242)));

		expect(run("--notify").out).toContain("UNREADABLE-JOB");
		expect(run("--notify").out).not.toContain("UNREADABLE-JOB");
	});

	/*
	 * The producer's stdout is not the delivery under persist mode, so its
	 * own stamp must not suppress anything (mantahostels#1975).
	 */
	describe("under persist mode", () => {
		// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
		const notify: any = createRequire(__filename)("./lib/notify-report.js");
		const savedEnv = { ...process.env };

		/** The env the child gets, mirrored onto this process so the two agree
		 *  on where reports and stamps live. */
		beforeEach(() => {
			process.env.CLAUDE_CONFIG_DIR = dir;
			process.env.CLAUDE_PROJECT_DIR = path.join(dir, "repo");
			process.env.WFC_CLAUDE_CONFIG_A = dir;
			process.env.WFC_CLAUDE_CONFIG_B = second;
			process.env.WFC_CLAUDE_CONFIG_C = second;
			fs.mkdirSync(process.env.CLAUDE_PROJECT_DIR, { recursive: true });
		});
		afterEach(() => {
			process.env = { ...savedEnv };
		});

		const persist = (...args: string[]) =>
			runInProcess(SCRIPT, args, {
				env: {
					...process.env,
					WFC_NOTIFY_PERSIST: "1",
					WFC_CLAUDE_BIN: path.join(dir, "bin", "claude"),
					CLAUDE_CODE_SESSION_ID: "",
				},
			});

		const stampPath = () => path.join(notify.base(), "ghost-jobs.notified");

		it("reports the same ghost on every run, however stamped", () => {
			job("d06bf779");
			fakeClaude(
				listing(HEALTHY, agent("d06bf779-0000-0000-0000-000000000000")),
			);
			expect(run("--notify").out).toContain("GHOST-JOB");
			expect(fs.existsSync(stampPath())).toBe(true);

			for (const _ of [1, 2]) {
				expect(persist("--notify").status).toBe(0);
				expect(notify.readReport("ghost-jobs").text).toContain("GHOST-JOB");
			}
		});

		it("carries the signature instead of stamping with it", () => {
			job("d06bf779");
			fakeClaude(
				listing(HEALTHY, agent("d06bf779-0000-0000-0000-000000000000")),
			);

			persist("--notify");

			expect(fs.existsSync(stampPath())).toBe(false);
			const { stamp } = notify.readReport("ghost-jobs");
			expect(JSON.parse(stamp)).toEqual([
				"d06bf779\td06bf779-0000-0000-0000-000000000000",
			]);
		});
	});

	it("--json carries the ghost and its reason", () => {
		job("d06bf779");
		fakeClaude(listing(HEALTHY, agent("d06bf779-0000-0000-0000-000000000000")));

		const parsed = JSON.parse(run("--json").stdout);

		expect(parsed.ghostCount).toBe(1);
		expect(parsed.ghosts[0].reason).toBe("listed with no process behind it");
		expect(parsed.ghosts[0].intent).toBe("/implement d06bf779");
		expect(parsed.ghosts[0].rosterPath).toBe(
			path.join(dir, "daemon", "roster.json"),
		);
		expect(parsed.outcome).toBe("WARN");
	});

	it("refuses a --minutes that is not a non-negative number", () => {
		job("d06bf779");
		fakeClaude(listing(HEALTHY, agent("d06bf779-0000-0000-0000-000000000000")));

		const { out, status } = run("--minutes", "-1");

		expect(out).toContain("--minutes must be a non-negative number");
		expect(status).toBe(2);
	});
});

/*
 * mantahostels#2588. A job that claimed its spare and hung has live processes behind it, so
 * the pid test passes and it is no ghost — it simply stops writing. The second
 * test is its transcript's mtime, or the absence of a transcript altogether.
 */
describe("HUNG-JOB — live, listed, and silent (mantahostels#2588)", () => {
	const sid = (name: string) => `${name}-0000-0000-0000-000000000000`;

	it("flags a live job whose transcript has not moved for the window, naming the job and never also as a GHOST-JOB", () => {
		job("aa11bb22");
		transcript(sid("aa11bb22"), 60 * 9);
		fakeClaude(listing(agent(sid("aa11bb22"), 5150), HEALTHY));
		const r = run();
		expect(r.out).toContain("HUNG-JOB");
		expect(r.out).toContain("/implement aa11bb22");
		expect(r.out).toContain("its transcript has not moved");
		// It is NOT also reported as a ghost: a pid is behind it. The heading,
		// not the bare word — the shared remedy text names both findings.
		expect(r.out).not.toContain("GHOST-JOB (");
	});

	it("leaves a live job with a fresh transcript alone", () => {
		job("aa11bb22");
		transcript(sid("aa11bb22"), 1);
		fakeClaude(listing(agent(sid("aa11bb22"), 5150), HEALTHY));
		expect(run().out).not.toContain("HUNG-JOB");
	});

	it("flags a live job that never wrote a transcript at all", () => {
		job("cc33dd44");
		fakeClaude(listing(agent(sid("cc33dd44"), 5151), HEALTHY));
		const r = run();
		expect(r.out).toContain("HUNG-JOB");
		expect(r.out).toContain("it never wrote a transcript");
		expect(r.out).toContain("(never written)");
	});

	/*
	 * The defect that made the first cut of this check dead on arrival: a live
	 * session's record has `updatedAt` REWRITTEN under it, measured under 1.1
	 * minutes old on nine live jobs. Age since CREATION is the only usable
	 * stand-in where there is no transcript.
	 */
	it("judges a transcript-less job on createdAt, not the rewritten updatedAt", () => {
		job(
			"ee55ff66",
			{
				createdAt: new Date(Date.now() - 60 * 9 * 60_000).toISOString(),
				updatedAt: new Date().toISOString(),
			},
			0,
		);
		fakeClaude(listing(agent(sid("ee55ff66"), 5152), HEALTHY));
		expect(run().out).toContain("HUNG-JOB");
	});

	it("says nothing about a young transcript-less job", () => {
		job("77aa88bb", {}, 2);
		fakeClaude(listing(agent(sid("77aa88bb"), 5153), HEALTHY));
		expect(run().out).not.toContain("HUNG-JOB");
	});

	/*
	 * TWO WINDOWS, ONE FINDING (mantahostels#2588). Only a STALE transcript has a healthy
	 * look-alike — a session on `waiting:`, inside a long tool call, or waiting
	 * on a subagent — and that is what the four-hour window buys.
	 */
	it("names a transcript-less job on the shorter ghost window", () => {
		job("11ee22ff", {}, 45);
		fakeClaude(listing(agent(sid("11ee22ff"), 5160), HEALTHY));
		const r = run();
		expect(r.out).toContain("HUNG-JOB");
		expect(r.out).toContain("it never wrote a transcript");
	});

	it("still holds a job with a STALE transcript to the four-hour window", () => {
		job("33aa44bb", {}, 45);
		transcript(sid("33aa44bb"), 45);
		fakeClaude(listing(agent(sid("33aa44bb"), 5161), HEALTHY));
		// 45 minutes of silence is past --minutes and nowhere near --hung-minutes.
		expect(run().out).not.toContain("HUNG-JOB");
	});

	it("moves the transcript-less window with --minutes, not --hung-minutes", () => {
		job("55cc66dd", {}, 45);
		fakeClaude(listing(agent(sid("55cc66dd"), 5162), HEALTHY));
		expect(run("--minutes", "90").out).not.toContain("HUNG-JOB");
		expect(run("--hung-minutes", "600").out).toContain("HUNG-JOB");
	});

	it("--hung-minutes moves the window", () => {
		job("99cc00dd");
		transcript(sid("99cc00dd"), 60);
		fakeClaude(listing(agent(sid("99cc00dd"), 5154), HEALTHY));
		expect(run().out).not.toContain("HUNG-JOB");
		expect(run("--hung-minutes", "30").out).toContain("HUNG-JOB");
	});

	it("refuses a --hung-minutes that is not a number", () => {
		job("99cc00dd");
		fakeClaude(listing(HEALTHY));
		const r = run("--hung-minutes", "soon");
		expect(r.status).toBe(2);
		expect(r.out).toContain("--hung-minutes must be a non-negative number");
	});

	it("names the roster route and the waiting-session caveat", () => {
		job("aa11bb22");
		transcript(sid("aa11bb22"), 60 * 9);
		fakeClaude(listing(agent(sid("aa11bb22"), 5150), HEALTHY));
		const out = run().out;
		expect(out).toContain("roster.json");
		expect(out).toContain("replPid");
		expect(out).toContain("waiting:");
	});

	/*
	 * Left out of the delivery signature, a hung job reprints into every session
	 * start for as long as it stands.
	 */
	it("--notify reports each hung job once", () => {
		job("aa11bb22");
		transcript(sid("aa11bb22"), 60 * 9);
		fakeClaude(listing(agent(sid("aa11bb22"), 5150), HEALTHY));
		expect(run("--notify").out).toContain("HUNG-JOB");
		expect(run("--notify").out).not.toContain("HUNG-JOB");
	});

	it("reports a hung job and a ghost side by side", () => {
		job("aa11bb22");
		transcript(sid("aa11bb22"), 60 * 9);
		job("beefbeef");
		fakeClaude(
			listing(agent(sid("aa11bb22"), 5150), agent(sid("beefbeef")), HEALTHY),
		);
		const out = run().out;
		expect(out).toContain("HUNG-JOB");
		expect(out).toContain("GHOST-JOB");
	});
});
