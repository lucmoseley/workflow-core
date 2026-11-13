import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildAgentsBranch,
	buildListedRow,
	buildStopBranch,
} from "./lib/agents-stop-fake";
import { writeClaudeStub } from "./lib/claude-stub";
import { runInProcessAsync } from "./lib/run-in-process";
import { buildBashCall } from "./lib/transcript-testkit";

const SCRIPT = join(__dirname, "rescue-sessions.js");
/**
 * rescue-sessions.js's list, snapshot and stop through the program
 * (mantahostels#2605): the boundary set lib/rescue-jobs.js's module cases
 * (lib/rescue-jobs.test.ts) leave to it (#5157) — argument parsing, the real
 * oracle adapter asked of the source plan's own config dir and killed on its
 * timeout with every child, `claude stop` on a stub, and one run of each
 * subcommand through the shell's exit.
 */
const _NO_CLAUDE = { ...process.env, WFC_CLAUDE_BIN: "/nonexistent/claude" };

/** Every temp dir a test made. */
const made: string[] = [];

afterEach(() => {
	for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	made.push(dir);
	return dir;
}

/** One transcript line, in the shape the daemon writes. */
function line(obj: unknown): string {
	return JSON.stringify(obj);
}

function assistant(content: unknown[]) {
	return { type: "assistant", message: { content } };
}

const said = (text: string) => line(assistant([{ type: "text", text }]));
const _bash = (command: string) => line(buildBashCall(command));

/** A config dir holding the jobs described, in the daemon's own layout. */
function configDirOf(jobs: Record<string, unknown>): string {
	const dir = tempDir("rescue-cfg-");
	mkdirSync(join(dir, "jobs"), { recursive: true });
	for (const [short, state] of Object.entries(jobs)) {
		mkdirSync(join(dir, "jobs", short), { recursive: true });
		writeFileSync(
			join(dir, "jobs", short, "state.json"),
			typeof state === "string" ? state : JSON.stringify(state),
		);
	}
	return dir;
}

interface Snapshot {
	short: string;
	model: string;
	deathPoint: string;
	artefactsSurvived: string[];
	commitsAttempted: string[];
	commitsLanded: string[] | null;
}

/**
 * `snapshot` over one job whose transcript is `lines`: the narration file it
 * wrote, the job's index entry, and what it printed.
 */
async function snapshotOf(
	lines: string[],
	state: Record<string, unknown> = {},
	env?: NodeJS.ProcessEnv,
) {
	const work = tempDir("rescue-test-");
	const transcript = join(work, "t.jsonl");
	writeFileSync(transcript, `${lines.join("\n")}\n`);
	const cfg = configDirOf({
		aaaa1111: { state: "blocked", linkScanPath: transcript, ...state },
	});
	const out = join(work, "out");
	const res = await runInProcessAsync(
		SCRIPT,
		["snapshot", "--from", cfg, `--out=${out}`, "--ids", "aaaa1111"],
		env ? { env } : {},
	);
	expect(res.status, res.stderr).toBe(0);
	const [entry] = JSON.parse(readFileSync(join(out, "index.json"), "utf8"));
	return {
		res,
		narration: readFileSync(join(out, "aaaa1111.narration.txt"), "utf8"),
		entry: entry as Snapshot,
	};
}

describe("argument parsing", () => {
	it("reads both --k v and --k=v", async () => {
		// snapshotOf passes `--from <dir>` and `--out=<dir>`; it fails on any
		// other exit.
		await snapshotOf([said("Read.")]);
	});

	it("refuses a flag its subcommand does not declare, naming it (#920)", async () => {
		const res = await runInProcessAsync(SCRIPT, ["probe", "--from", "/a"]);
		expect(res.status).toBe(2);
		expect(res.stderr).toContain("unknown flag: --from");
	});

	it("refuses a --from ~/ it cannot expand, where HOME is not absolute (#4611)", async () => {
		const res = await runInProcessAsync(
			SCRIPT,
			["snapshot", "--from", "~/.claude3"],
			{
				env: { ...process.env, HOME: "rel/home" },
			},
		);
		expect(res.status).toBe(2);
		expect(res.stderr).toContain("unset or not absolute");
	});

	it("refuses a value flag with nothing after it, naming the flag", async () => {
		const res = await runInProcessAsync(SCRIPT, ["snapshot", "--out"]);
		expect(res.status).toBe(2);
		expect(res.stderr).toContain("--out needs a value");
	});
});

describe("the jobs list reads", () => {
	it("asks the daemon of the source plan's own config dir", async () => {
		const cfg = configDirOf({ aaaaaaaa: { state: "blocked" } });
		const bin = writeClaudeStub(join(cfg, "claude"), [
			buildAgentsBranch(null, {
				[cfg]: [buildListedRow({ id: "aaaaaaaa-1" })],
			}),
		]);
		const res = await runInProcessAsync(SCRIPT, ["list", "--from", cfg], {
			env: { ...process.env, WFC_CLAUDE_BIN: bin },
		});
		expect(res.status, res.stderr).toBe(0);
		expect(res.stdout).toContain("process LIVE");
	});

	it("leaves no child of a timed-out oracle behind it (#2682)", async () => {
		// An oracle that backgrounds children, then waits on them.
		// §X9: it crosses a real process timeout, as the kill is what is tested.
		const cfg = configDirOf({ aaaaaaaa: { state: "blocked" } });
		const pids = join(cfg, "pids");
		const bin = writeClaudeStub(join(cfg, "claude"), [
			buildAgentsBranch({ hangsWithChildren: pids }),
		]);
		const res = await runInProcessAsync(SCRIPT, ["list", "--from", cfg], {
			env: {
				...process.env,
				WFC_CLAUDE_BIN: bin,
				// Untraced: long enough for node and bash to start and write both
				// pids under suite load, far short of the children's 30 s.
				WFC_RESCUE_ORACLE_TIMEOUT_MS: "1500",
			},
		});
		expect(res.status, res.stderr).toBe(0);
		expect(res.stdout).toContain("liveness unreadable");
		const children = readFileSync(pids, "utf8").trim().split("\n");
		expect(children).toHaveLength(2);
		const isRunning = (pid: string) => {
			try {
				return !/\) [ZX] /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
			} catch {
				return false;
			}
		};
		// SIGKILL is delivered asynchronously, so the reap is polled for — up
		// to 1 s, untraced: far past a kill's delivery on an idle machine.
		for (let i = 0; i < 20 && children.some(isRunning); i++)
			await new Promise((r) => setTimeout(r, 50));
		expect(children.filter(isRunning)).toEqual([]);
	});
});

describe("--ids", () => {
	it("splits and trims a comma list", async () => {
		const cfg = configDirOf({});
		const bin = writeClaudeStub(join(cfg, "claude"), [
			buildStopBranch(join(cfg, "stops")),
		]);
		const res = await runInProcessAsync(
			SCRIPT,
			["stop", "--from", cfg, "--ids", "a, b ,c"],
			{ env: { ...process.env, WFC_CLAUDE_BIN: bin } },
		);
		expect(res.status).toBe(0);
		expect(res.stdout).toBe(
			"  a -> stopped a\n  b -> stopped b\n  c -> stopped c\n",
		);
	});

	it("is required by stop, which will not guess", async () => {
		const res = await runInProcessAsync(SCRIPT, [
			"stop",
			"--from",
			configDirOf({}),
		]);
		expect(res.status).toBe(2);
		expect(res.stderr).toContain("stop needs --ids");
	});
});

/*
 * The CLI entry points, driven through the process boundary (mantahostels#2628) —
 * `run-in-process.js` takes the script unchanged since it is synchronous,
 * `require.main`-guarded.
 */
describe("the CLI entry points: list, snapshot, stop", () => {
	let cfg: string;

	beforeEach(() => {
		cfg = mkdtempSync(join(tmpdir(), "rescue-cli-"));
		made.push(cfg);
		mkdirSync(join(cfg, "jobs"), { recursive: true });
	});

	function writeJob(short: string, state: Record<string, unknown>) {
		mkdirSync(join(cfg, "jobs", short), { recursive: true });
		writeFileSync(
			join(cfg, "jobs", short, "state.json"),
			JSON.stringify(state),
		);
	}

	describe("list", () => {
		it("names a stuck job, with liveness unreadable off a dead daemon", async () => {
			writeJob("aaaa1111", {
				state: "blocked",
				intent: "fix the thing",
				updatedAt: "2026-09-01T00:00:00Z",
			});
			const res = await runInProcessAsync(SCRIPT, ["list", "--from", cfg], {
				env: { ...process.env, WFC_CLAUDE_BIN: "/nonexistent/claude" },
			});
			expect(res.status).toBe(0);
			expect(res.stdout).toContain("aaaa1111");
			expect(res.stdout).toContain("liveness unreadable");
		});

		it("reports nothing stuck when every job is settled", async () => {
			writeJob("aaaa1111", { state: "done" });
			const res = await runInProcessAsync(SCRIPT, ["list", "--from", cfg]);
			expect(res.status).toBe(0);
			expect(res.stdout).toContain("No jobs in");
		});
	});

	describe("snapshot", () => {
		it("copies state and transcript, and writes an index the death report reads back", async () => {
			const t = join(cfg, "t.jsonl");
			writeFileSync(
				`${t}`,
				`${JSON.stringify({
					type: "assistant",
					message: { content: [{ type: "text", text: "Working on it." }] },
				})}\n`,
			);
			writeJob("bbbb2222", {
				state: "blocked",
				intent: "do the thing",
				linkScanPath: t,
				updatedAt: "2026-09-01T00:00:00Z",
			});
			const out = mkdtempSync(join(tmpdir(), "rescue-out-"));
			made.push(out);
			const res = await runInProcessAsync(SCRIPT, [
				"snapshot",
				"--from",
				cfg,
				"--out",
				out,
			]);
			expect(res.status).toBe(0);
			const index = JSON.parse(readFileSync(join(out, "index.json"), "utf8"));
			expect(index[0].short).toBe("bbbb2222");
			expect(index[0].deathPoint).toContain("Working on it.");
			expect(res.stdout).toContain("Snapshot in");
		});

		it("dies when --out is missing, rather than guessing one", async () => {
			writeJob("cccc3333", { state: "blocked" });
			const res = await runInProcessAsync(SCRIPT, ["snapshot", "--from", cfg]);
			expect(res.status).toBe(2);
			expect(res.stderr).toContain("snapshot needs --out");
		});
	});

	describe("stop", () => {
		it("calls `claude stop` per id and reports what it said", async () => {
			const bin = writeClaudeStub(join(cfg, "claude"), [
				buildStopBranch(join(cfg, "stops")),
			]);
			const res = await runInProcessAsync(
				SCRIPT,
				["stop", "--from", cfg, "--ids", "aaaa1111"],
				{ env: { ...process.env, WFC_CLAUDE_BIN: bin } },
			);
			expect(res.status).toBe(0);
			expect(res.stdout).toContain("aaaa1111 -> stopped aaaa1111");
		});

		it("rejects a bare --ids rather than guessing which job", async () => {
			const res = await runInProcessAsync(SCRIPT, [
				"stop",
				"--from",
				cfg,
				"--ids",
			]);
			expect(res.status).toBe(2);
			expect(res.stderr).toContain("--ids needs a value");
		});

		// mantahostels#2628: parseArgs passes "--force" through as the value, so readIds
		// has to refuse it.
		it.each([[["--ids=--force"]], [["--ids", "--force"]]])(
			"rejects a flag-shaped id given as %j, naming it, rather than passing it to claude stop",
			async (ids) => {
				const res = await runInProcessAsync(SCRIPT, [
					"stop",
					"--from",
					cfg,
					...ids,
				]);
				expect(res.status).toBe(2);
				expect(res.stderr).toContain('got "--force"');
			},
		);
	});
});
