// @vitest-environment node

import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AgentsAnswer,
	buildAgentsBranch,
	buildListedRow,
} from "./lib/agents-stop-fake";
import { writeClaudeStub } from "./lib/claude-stub";
import { spawnLoopHolder } from "./lib/refill-loop-testkit";
import { runInProcess } from "./lib/run-in-process";
import {
	founderRow,
	STOP_AT,
	stoppedRows,
	syntheticRow,
} from "./lib/synthetic-stop-fixture";

const SCRIPT = path.join(__dirname, "check-ghost-jobs.js");

let dir: string;
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

function fakeClaude(answer: AgentsAnswer): void {
	writeClaudeStub(path.join(dir, "bin", "claude"), [buildAgentsBranch(answer)]);
}

const agent = (sessionId: string, pid?: number) =>
	pid === undefined
		? buildListedRow({ id: sessionId.slice(0, 8), sessionId }, [
				"pid",
				"status",
			])
		: buildListedRow({ pid, id: sessionId.slice(0, 8), sessionId });

const HEALTHY = agent("neighbour-0000-0000-0000-00000000000", 4242);

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

function runAs(sessionId: string, ...args: string[]) {
	return runWith({ CLAUDE_CODE_SESSION_ID: sessionId }, ...args);
}

function runWith(extra: Record<string, string>, ...args: string[]) {
	const res = runInProcess(SCRIPT, args, {
		env: {
			...process.env,
			CLAUDE_CONFIG_DIR: dir,
			WFC_CLAUDE_CONFIG_A: dir,
			WFC_CLAUDE_CONFIG_B: second,
			WFC_CLAUDE_CONFIG_C: second,
			WFC_CLAUDE_BIN: path.join(dir, "bin", "claude"),
			WFC_REFILL_DIR: dir,
			...extra,
		},
	});
	return { ...res, out: `${res.stdout}${res.stderr}` };
}

describe("check-ghost-jobs", () => {
	it("flags a working job the oracle lists with no pid", () => {
		job("d06bf779");
		fakeClaude([HEALTHY, agent("d06bf779-0000-0000-0000-000000000000")]);

		const { out } = run();

		expect(out).toContain("GHOST-JOB");
		expect(out).toContain("listed with no process behind it");
		expect(out).toContain("/implement d06bf779");
	});

	it("flags a working job the oracle does not list at all as a GHOST-JOB", () => {
		job("gone");
		fakeClaude([agent("someone-else-0000-0000-000000000000", 4242)]);

		const { out } = run();

		expect(out).toContain("GHOST-JOB");
		expect(out).toContain("not listed at all");
	});

	it("says nothing about a working job backed by a listed process", () => {
		job("alive");
		transcript("alive-0000-0000-0000-000000000000", 0);
		fakeClaude([agent("alive-0000-0000-0000-000000000000", 4242)]);

		const { out, status } = run();

		expect(out).not.toContain("GHOST-JOB");
		expect(out).toContain("OK:");
		expect(status).toBe(0);
	});

	it("spares a job younger than the grace window", () => {
		job("young", {}, 5);
		fakeClaude([HEALTHY, agent("young-0000-0000-0000-000000000000")]);

		expect(run().out).not.toContain("GHOST-JOB");
	});

	it("--minutes moves the grace window", () => {
		job("young", {}, 5);
		fakeClaude([HEALTHY, agent("young-0000-0000-0000-000000000000")]);

		expect(run("--minutes", "2").out).toContain("GHOST-JOB");
		expect(run("--minutes", "600").out).not.toContain("GHOST-JOB");
	});

	it("reports a job whose timestamps will not parse, grace window or not", () => {
		job("odd", { createdAt: "not a date", updatedAt: "not a date" }, 0);
		fakeClaude([HEALTHY, agent("odd-0000-0000-0000-000000000000")]);

		const { out } = run();

		expect(out).toContain("GHOST-JOB");
		expect(out).toContain("stuck since an unreadable time");
	});

	it("ignores a job that is not in the working state", () => {
		job("done", { state: "done", firstTerminalAt: new Date().toISOString() });
		fakeClaude([agent("other-0000-0000-0000-000000000000", 4242)]);

		expect(run().out).not.toContain("GHOST-JOB");
	});

	it("degrades to silence when the oracle will not run", () => {
		job("d06bf779");
		fakeClaude(null);

		const { out, status } = run();

		expect(out).not.toContain("GHOST-JOB");
		expect(out).toContain("SKIP:");
		expect(out).toContain("went unjudged");
		expect(status).toBe(0);
	});

	it("degrades to silence when the oracle lists nothing at all", () => {
		job("d06bf779");
		fakeClaude([]);

		const { out } = run();

		expect(out).not.toContain("GHOST-JOB");
		expect(out).toContain("SKIP:");
	});

	it("degrades to silence when no listed agent carries a pid at all", () => {
		job("a");
		job("b");
		fakeClaude([
			agent("a-0000-0000-0000-000000000000"),
			agent("b-0000-0000-0000-000000000000"),
		]);

		const { out } = run();

		expect(out).not.toContain("GHOST-JOB");
		expect(out).toContain("SKIP:");
		expect(out).toContain("the shape it reports has changed");
	});

	it("judges nothing where the oracle has not listed the session it runs in (#1558)", () => {
		job("d06bf779");
		job("hung", {}, 60 * 8);
		fakeClaude([HEALTHY, agent("hung-0000-0000-0000-000000000000", 99)]);

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
		fakeClaude([
			HEALTHY,
			agent("hung-0000-0000-0000-000000000000", 99),
			agent("self-0000-0000-0000-000000000000", 7),
		]);

		const { out } = runAs("self-0000-0000-0000-000000000000");

		expect(out).toContain("GHOST-JOB");
		expect(out).toContain("HUNG-JOB");
	});

	it("never calls this session's own job a ghost", () => {
		job("mine");
		fakeClaude([HEALTHY, agent("mine-0000-0000-0000-000000000000")]);

		const { out } = runAs("mine-0000-0000-0000-000000000000");

		expect(out).not.toContain("GHOST-JOB");
	});

	it("sweeps the job store of every config dir, not just its own", () => {
		job("elsewhere", {}, 60 * 8, second);
		fakeClaude([agent("other-0000-0000-0000-000000000000", 4242)]);

		const { out } = run();

		expect(out).toContain("GHOST-JOB");
		expect(out).toContain("/implement elsewhere");
	});

	it("skips when not one job store will open", () => {
		fs.rmSync(path.join(dir, "jobs"), { recursive: true, force: true });
		fakeClaude([agent("other-0000-0000-0000-000000000000", 4242)]);

		const { out, status } = run();

		expect(out).toContain("SKIP:");
		expect(out).toContain("could be read");
		expect(status).toBe(0);
	});

	it("reports a state.json that will not parse, without calling it a ghost", () => {
		fs.mkdirSync(path.join(dir, "jobs", "broken"), { recursive: true });
		fs.writeFileSync(jobPath("broken"), "{not json");
		fakeClaude([agent("other-0000-0000-0000-000000000000", 4242)]);

		const { out } = run();

		expect(out).toContain("UNREADABLE-JOB");
		expect(out).not.toContain("GHOST-JOB");
	});

	it("reports a record naming no session, without calling it a ghost", () => {
		job("nameless", { sessionId: null });
		fakeClaude([agent("other-0000-0000-0000-000000000000", 4242)]);

		const { out } = run();

		expect(out).toContain("UNREADABLE-JOB");
		expect(out).toContain("names no session");
		expect(out).not.toContain("GHOST-JOB");
	});

	it("does not point an unreadable-only report at a roster path it never printed", () => {
		fs.mkdirSync(path.join(dir, "jobs", "broken"), { recursive: true });
		fs.writeFileSync(jobPath("broken"), "{not json");
		fakeClaude([agent("other-0000-0000-0000-000000000000", 4242)]);

		const { out } = run();

		expect(out).toContain("UNREADABLE-JOB");
		expect(out).not.toContain("To actually retire a GHOST-JOB above");
		expect(out).not.toContain("roster.json");
	});

	it("adds the roster-does-not-apply note only when a ghost's own remedy is also printed", () => {
		job("d06bf779");
		fs.mkdirSync(path.join(dir, "jobs", "broken"), { recursive: true });
		fs.writeFileSync(jobPath("broken"), "{not json");
		fakeClaude([HEALTHY, agent("d06bf779-0000-0000-0000-000000000000")]);

		const { out } = run();

		expect(out).toContain("GHOST-JOB");
		expect(out).toContain("UNREADABLE-JOB");
		expect(out).toContain("needs its own investigation");
	});

	it("never writes a job record", () => {
		job("d06bf779");
		fakeClaude([HEALTHY, agent("d06bf779-0000-0000-0000-000000000000")]);
		const before = fs.readFileSync(jobPath("d06bf779"), "utf8");

		run();

		expect(fs.readFileSync(jobPath("d06bf779"), "utf8")).toBe(before);
	});

	it("tells the reader what to do about a ghost, and that nothing was cleared", () => {
		job("d06bf779");
		fakeClaude([HEALTHY, agent("d06bf779-0000-0000-0000-000000000000")]);

		const { out } = run();

		expect(out).toContain("Nothing was cleared");
		expect(out).toContain("check its transcript is absent");
		expect(out).toContain("Keep a copy first");
	});

	it("names the roster route, not the state.json edit, as the retirement remedy (mantahostels#2049)", () => {
		job("d06bf779");
		fakeClaude([HEALTHY, agent("d06bf779-0000-0000-0000-000000000000")]);

		const { out } = run();

		expect(out).not.toMatch(/\bset\b[^.]*state\.json[^.]*"done"/i);
		expect(out).toContain(
			'Editing state.json\'s "state" to "done" does NOT stop it',
		);
		expect(out).toContain("hides the job from THIS checker's own sweep");
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
			fakeClaude([HEALTHY, agent("d06bf779-0000-0000-0000-000000000000")]);
			expect(run().out).not.toContain("The refill loop");

			loop = spawnLoopHolder(dir);
			expect(run().out).toContain(
				`The refill loop (pid ${loop.pid}) retires a GHOST-JOB`,
			);
		});
	});

	it("prints the roster path for a ghost's own config dir", () => {
		job("d06bf779");
		fakeClaude([HEALTHY, agent("d06bf779-0000-0000-0000-000000000000")]);

		const { out } = run();

		expect(out).toContain(path.join(dir, "daemon", "roster.json"));
	});

	it("--notify reports each ghost once, and always exits 0", () => {
		job("d06bf779");
		fakeClaude([HEALTHY, agent("d06bf779-0000-0000-0000-000000000000")]);

		const first = run("--notify");
		expect(first.out).toContain("GHOST-JOB");
		expect(first.status).toBe(0);

		const rerun = run("--notify");
		expect(rerun.out).not.toContain("GHOST-JOB");
		expect(rerun.status).toBe(0);
	});

	it("--notify keeps an older ghost stamped once a newer one joins it", () => {
		job("first");
		fakeClaude([HEALTHY, agent("first-0000-0000-0000-000000000000")]);
		expect(run("--notify").out).toContain("/implement first");

		job("second");
		fakeClaude([
			HEALTHY,
			agent("first-0000-0000-0000-000000000000"),
			agent("second-0000-0000-0000-00000000000"),
		]);
		const two = run("--notify").out;
		expect(two).toContain("/implement second");
		expect(two).not.toContain("/implement first");

		expect(run("--notify").out).not.toContain("GHOST-JOB");
	});

	it("--notify reports a ghost again once it has cleared and returned", () => {
		job("d06bf779");
		const id = "d06bf779-0000-0000-0000-000000000000";
		fakeClaude([HEALTHY, agent(id)]);
		expect(run("--notify").out).toContain("GHOST-JOB");

		transcript(id, 0);
		fakeClaude([HEALTHY, agent(id, 4343)]);
		expect(run("--notify").out).not.toContain("GHOST-JOB");

		fakeClaude([HEALTHY, agent(id)]);
		expect(run("--notify").out).toContain("GHOST-JOB");
	});

	it("--notify reports an unreadable record once — nothing ever repairs one", () => {
		fs.mkdirSync(path.join(dir, "jobs", "broken"), { recursive: true });
		fs.writeFileSync(jobPath("broken"), "{not json");
		fakeClaude([agent("other-0000-0000-0000-000000000000", 4242)]);

		expect(run("--notify").out).toContain("UNREADABLE-JOB");
		expect(run("--notify").out).not.toContain("UNREADABLE-JOB");
	});

	describe("under persist mode", () => {
		const notify = createRequire(__filename)("./lib/notify-report.js");

		beforeEach(() => {
			vi.stubEnv("CLAUDE_CONFIG_DIR", dir);
			const repo = path.join(dir, "repo");
			vi.stubEnv("CLAUDE_PROJECT_DIR", repo);
			vi.stubEnv("WFC_CLAUDE_CONFIG_A", dir);
			vi.stubEnv("WFC_CLAUDE_CONFIG_B", second);
			vi.stubEnv("WFC_CLAUDE_CONFIG_C", second);
			fs.mkdirSync(repo, { recursive: true });
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
			fakeClaude([HEALTHY, agent("d06bf779-0000-0000-0000-000000000000")]);
			expect(run("--notify").out).toContain("GHOST-JOB");
			expect(fs.existsSync(stampPath())).toBe(true);

			for (const _ of [1, 2]) {
				expect(persist("--notify").status).toBe(0);
				expect(notify.readReport("ghost-jobs").text).toContain("GHOST-JOB");
			}
		});

		it("carries the signature instead of stamping with it", () => {
			job("d06bf779");
			fakeClaude([HEALTHY, agent("d06bf779-0000-0000-0000-000000000000")]);

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
		fakeClaude([HEALTHY, agent("d06bf779-0000-0000-0000-000000000000")]);

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
		fakeClaude([HEALTHY, agent("d06bf779-0000-0000-0000-000000000000")]);

		const { out, status } = run("--minutes", "-1");

		expect(out).toContain("--minutes must be a non-negative number");
		expect(status).toBe(2);
	});
});

describe("HUNG-JOB — live, listed, and silent (mantahostels#2588)", () => {
	const sid = (name: string) => `${name}-0000-0000-0000-000000000000`;

	it("flags a live job whose transcript has not moved for the window, naming the job and never also as a GHOST-JOB", () => {
		job("aa11bb22");
		transcript(sid("aa11bb22"), 60 * 9);
		fakeClaude([agent(sid("aa11bb22"), 5150), HEALTHY]);
		const r = run();
		expect(r.out).toContain("HUNG-JOB");
		expect(r.out).toContain("/implement aa11bb22");
		expect(r.out).toContain("its transcript has not moved");
		expect(r.out).not.toContain("GHOST-JOB (");
	});

	it("leaves a live job with a fresh transcript alone", () => {
		job("aa11bb22");
		transcript(sid("aa11bb22"), 1);
		fakeClaude([agent(sid("aa11bb22"), 5150), HEALTHY]);
		expect(run().out).not.toContain("HUNG-JOB");
	});

	it("flags a live job that never wrote a transcript at all", () => {
		job("cc33dd44");
		fakeClaude([agent(sid("cc33dd44"), 5151), HEALTHY]);
		const r = run();
		expect(r.out).toContain("HUNG-JOB");
		expect(r.out).toContain("it never wrote a transcript");
		expect(r.out).toContain("(never written)");
	});

	it("judges a transcript-less job on createdAt, not the rewritten updatedAt", () => {
		job(
			"ee55ff66",
			{
				createdAt: new Date(Date.now() - 60 * 9 * 60_000).toISOString(),
				updatedAt: new Date().toISOString(),
			},
			0,
		);
		fakeClaude([agent(sid("ee55ff66"), 5152), HEALTHY]);
		expect(run().out).toContain("HUNG-JOB");
	});

	it("says nothing about a young transcript-less job", () => {
		job("77aa88bb", {}, 2);
		fakeClaude([agent(sid("77aa88bb"), 5153), HEALTHY]);
		expect(run().out).not.toContain("HUNG-JOB");
	});

	it("names a transcript-less job on the shorter ghost window", () => {
		job("11ee22ff", {}, 45);
		fakeClaude([agent(sid("11ee22ff"), 5160), HEALTHY]);
		const r = run();
		expect(r.out).toContain("HUNG-JOB");
		expect(r.out).toContain("it never wrote a transcript");
	});

	it("still holds a job with a STALE transcript to the four-hour window", () => {
		job("33aa44bb", {}, 45);
		transcript(sid("33aa44bb"), 45);
		fakeClaude([agent(sid("33aa44bb"), 5161), HEALTHY]);
		expect(run().out).not.toContain("HUNG-JOB");
	});

	it("moves the transcript-less window with --minutes, not --hung-minutes", () => {
		job("55cc66dd", {}, 45);
		fakeClaude([agent(sid("55cc66dd"), 5162), HEALTHY]);
		expect(run("--minutes", "90").out).not.toContain("HUNG-JOB");
		expect(run("--hung-minutes", "600").out).toContain("HUNG-JOB");
	});

	it("--hung-minutes moves the window", () => {
		job("99cc00dd");
		transcript(sid("99cc00dd"), 60);
		fakeClaude([agent(sid("99cc00dd"), 5154), HEALTHY]);
		expect(run().out).not.toContain("HUNG-JOB");
		expect(run("--hung-minutes", "30").out).toContain("HUNG-JOB");
	});

	it("refuses a --hung-minutes that is not a number", () => {
		job("99cc00dd");
		fakeClaude([HEALTHY]);
		const r = run("--hung-minutes", "soon");
		expect(r.status).toBe(2);
		expect(r.out).toContain("--hung-minutes must be a non-negative number");
	});

	it("names the roster route and the waiting-session caveat", () => {
		job("aa11bb22");
		transcript(sid("aa11bb22"), 60 * 9);
		fakeClaude([agent(sid("aa11bb22"), 5150), HEALTHY]);
		const out = run().out;
		expect(out).toContain("roster.json");
		expect(out).toContain("replPid");
		expect(out).toContain("waiting:");
	});

	it("--notify reports each hung job once", () => {
		job("aa11bb22");
		transcript(sid("aa11bb22"), 60 * 9);
		fakeClaude([agent(sid("aa11bb22"), 5150), HEALTHY]);
		expect(run("--notify").out).toContain("HUNG-JOB");
		expect(run("--notify").out).not.toContain("HUNG-JOB");
	});

	it("reports a hung job and a ghost side by side", () => {
		job("aa11bb22");
		transcript(sid("aa11bb22"), 60 * 9);
		job("beefbeef");
		fakeClaude([agent(sid("aa11bb22"), 5150), agent(sid("beefbeef")), HEALTHY]);
		const out = run().out;
		expect(out).toContain("HUNG-JOB");
		expect(out).toContain("GHOST-JOB");
	});
});

describe("SYNTHETIC-STOP — ended by the harness on a synthetic reply (#5324)", () => {
	const Job = "5e5e5e5e";
	const Sid = "5e5e5e5e-0000-4000-8000-000000000001";
	const Cwd = "/home/u/a-checkout";
	const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

	function syntheticJob(rows: unknown[] | null, rec = {}) {
		const project = path.join(dir, "projects", "a-project");
		fs.mkdirSync(project, { recursive: true });
		const file = path.join(project, `${Sid}.jsonl`);
		if (rows)
			fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n"));
		job(Job, {
			state: "done",
			detail: "done",
			sessionId: Sid,
			name: "Implement 9001: a ticket",
			cwd: Cwd,
			linkScanPath: file,
			...rec,
		});
	}

	function claim(issue: number) {
		const { projectSlug } = createRequire(__filename)("./lib/project-slug.js");
		const store = path.join(dir, "projects", projectSlug(Cwd), "issue-claims");
		fs.mkdirSync(store, { recursive: true });
		fs.writeFileSync(
			path.join(store, `${issue}.json`),
			JSON.stringify({ issue, sessionId: Sid, claimedAt: ago(30) }),
		);
	}

	it("names the job, its claims, the stop's time and the attach line, as a warning", () => {
		const at = ago(15);
		syntheticJob(stoppedRows(at));
		claim(9001);
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("SYNTHETIC-STOP");
		expect(r.out).toContain("Implement 9001: a ticket");
		expect(r.out).toContain(Sid);
		expect(r.out).toContain("claiming #9001");
		expect(r.out).toContain(`stopped at ${at}`);
		expect(r.out).toContain("the refill loop has not resumed it");
		expect(r.out).toContain(`claude attach ${Job}`);
	});

	it("reports one the reaper has since stopped", () => {
		syntheticJob(stoppedRows(ago(30)), { state: "stopped", detail: "stopped" });
		expect(run().out).toContain("SYNTHETIC-STOP");
	});

	it("says where the refill loop's resumes of that stop are spent", () => {
		const at = ago(30);
		syntheticJob(stoppedRows(at));
		fs.writeFileSync(
			path.join(dir, ".refill-loop-state.json"),
			JSON.stringify({
				launches: [
					{
						jobId: Job,
						synthetic: {
							at: Date.parse(at),
							tries: 2,
							resumed: 2,
							spent: true,
						},
					},
				],
			}),
		);
		expect(run().out).toContain("the refill loop's 2 resumes of it are spent");
	});

	it("stays silent until the loop's quiet window and a tick have passed, and speaks past them", () => {
		const at = Date.parse(STOP_AT);
		syntheticJob(stoppedRows(STOP_AT));
		const runAt = (m: number) =>
			runWith({ WFC_NOW: new Date(at + m * 60_000).toISOString() }).out;
		expect(runAt(9)).not.toContain("SYNTHETIC-STOP");
		expect(runAt(11)).toContain("SYNTHETIC-STOP");
	});

	it("reports a job in the second config dir", () => {
		const project = path.join(second, "projects", "a-project");
		fs.mkdirSync(project, { recursive: true });
		const file = path.join(project, `${Sid}.jsonl`);
		fs.writeFileSync(
			file,
			stoppedRows(ago(30))
				.map((row) => JSON.stringify(row))
				.join("\n"),
		);
		job(
			Job,
			{
				state: "done",
				sessionId: Sid,
				name: "On the second plan",
				cwd: Cwd,
				linkScanPath: file,
			},
			60,
			second,
		);
		const r = run();
		expect(r.out).toContain("SYNTHETIC-STOP");
		expect(r.out).toContain("On the second plan");
	});

	it("stays silent on a job whose state.json will not parse", () => {
		syntheticJob(stoppedRows(ago(30)));
		fs.writeFileSync(jobPath(Job), "{ not json");
		expect(run().out).not.toContain("SYNTHETIC-STOP");
	});

	it("reports a stop where the oracle will not read, saying the working jobs went unjudged", () => {
		syntheticJob(stoppedRows(ago(30)));
		job("d06bf779");
		fakeClaude(null);
		const r = run();
		expect(r.out).toContain("SYNTHETIC-STOP");
		expect(r.out).toContain("went unjudged");
		expect(r.out).not.toContain("SKIP:");
	});

	it("stays silent once a turn row follows the stop", () => {
		syntheticJob([...stoppedRows(ago(30)), founderRow("go on", ago(20))]);
		expect(run().out).not.toContain("SYNTHETIC-STOP");
	});

	it("stays silent on an API-error or a limit record of the same shape", () => {
		syntheticJob([
			...stoppedRows(ago(40)).slice(0, -1),
			syntheticRow(ago(30), "No response requested.", {
				isApiErrorMessage: true,
			}),
		]);
		expect(run().out).not.toContain("SYNTHETIC-STOP");
		syntheticJob([
			...stoppedRows(ago(40)).slice(0, -1),
			syntheticRow(ago(30), "You've hit your session limit"),
		]);
		expect(run().out).not.toContain("SYNTHETIC-STOP");
	});

	it("stays silent where the transcript will not read", () => {
		syntheticJob(null);
		expect(run().out).not.toContain("SYNTHETIC-STOP");
	});

	it("--notify skips an unread-oracle run once its stops are all reported", () => {
		syntheticJob(stoppedRows(ago(30)));
		job("d06bf779");
		fakeClaude(null);
		expect(run("--notify").out).toContain("SYNTHETIC-STOP");
		const again = run("--notify", "--json").stdout;
		expect(JSON.parse(again).outcome).toBe("SKIP");
	});

	it("writes nothing to the job record", () => {
		syntheticJob(stoppedRows(ago(15)));
		const before = fs.readFileSync(jobPath(Job), "utf8");
		run();
		expect(fs.readFileSync(jobPath(Job), "utf8")).toBe(before);
	});

	it("--notify reports a stop once, and a later separate stop afresh", () => {
		syntheticJob(stoppedRows(ago(60)));
		expect(run("--notify").out).toContain("SYNTHETIC-STOP");
		expect(run("--notify").out).not.toContain("SYNTHETIC-STOP");
		syntheticJob([
			...stoppedRows(ago(60)),
			founderRow("go on", ago(50)),
			syntheticRow(ago(15)),
		]);
		expect(run("--notify").out).toContain("SYNTHETIC-STOP");
	});
});
