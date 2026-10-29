/*
 * proving-session.ts — one simulated session in proving-run.ts's arena, and
 * the guards it runs (mantahostels#107). Split from proving-run.ts because
 * Biome allows one class a file (#1381).
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { procRoot } from "./lib/proc-root.js";
import type { Arena } from "./proving-run";

/**
 * The kernel's start-time token for a pid, or null if no such process. Read the
 * same way the arbiter reads it — counted from the LAST ')', because comm is
 * parenthesised — but deliberately duplicated rather than imported: a harness
 * that borrowed the implementation it is checking would agree with it by
 * construction, including where both are wrong.
 */
function readProcStartOf(pid: number): string | null {
	try {
		/* procRoot, as the arbiter's own stat read defaults to (#3587). */
		const stat = fs.readFileSync(`${procRoot()}/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19] ?? null;
	} catch {
		return null;
	}
}

/** A guard this repo has not built yet. Scenarios self-arm when one appears. */
const guardPath = (name: string) => path.join(__dirname, name);
export const guardExists = (name: string) => fs.existsSync(guardPath(name));

/**
 * Guard names, so a rename cannot drift a scenario's self-arming check away
 * from the guard it actually runs.
 */
export const GUARDS = {
	/* lib/file-claim.js, run by the PreToolUse dispatcher. */
	fileClaim: "guard-dispatch.js",
	/* lib/commit-form.js and lib/branch-move.js, run by the same dispatcher. */
	commitForm: "guard-dispatch.js",
	branch: "guard-dispatch.js",
	arbiter: "session-arbiter.js",
} as const;

export interface GuardResult {
	status: number;
	stdout: string;
	stderr: string;
	/** Silence is the shape every existing hook uses for "nothing to say". */
	silent: boolean;
}

/**
 * One simulated agent session: a session id, a liveness registry entry, and the
 * operations a session performs on the shared tree.
 */
export class Session {
	/** The process standing in for this session's Claude Code process. */
	private pid?: number;

	constructor(
		readonly arena: Arena,
		readonly id: string,
	) {}

	/* Spelt out, not lib/job-paths.js's jobDirPath: a fixture built through the
	 * reader's own helper would agree with it where both are wrong (#2966). */
	private get jobDir() {
		return path.join(this.arena.home, ".claude", "jobs", this.id);
	}

	private get stateFile() {
		return path.join(this.jobDir, "state.json");
	}

	/** The registry locations a guard reads, pointed at the arena, never at ~. */
	private get env() {
		return {
			...process.env,
			HOME: this.arena.home,
			CLAUDE_CONFIG_DIR: path.join(this.arena.home, ".claude"),
			CLAUDE_PROJECT_DIR: this.arena.repo,
			CLAUDE_CODE_SESSION_ID: this.id,
			...this.arena.extraEnv,
		};
	}

	/**
	 * The arbiter's own CLI, as a script or a person invokes it — the path the
	 * `debt` subcommands live on, which no hook payload reaches.
	 */
	arbiter(...args: string[]): GuardResult {
		const r = spawnSync("node", [guardPath(GUARDS.arbiter), ...args], {
			cwd: this.arena.repo,
			encoding: "utf8",
			env: this.env,
		});
		return this.result(GUARDS.arbiter, {
			status: r.status,
			stdout: r.stdout ?? "",
			stderr: r.stderr ?? "",
			cause: r.error,
		});
	}

	/** A guard that could not be executed is a harness fault, not a verdict. */
	private result(
		name: string,
		{
			status,
			stdout,
			stderr,
			cause,
		}: {
			status: number | null;
			stdout: string;
			stderr: string;
			cause?: Error;
		},
	): GuardResult {
		if (status === null) {
			// The likeliest live case is a guard committed without +x, which
			// surfaces as EACCES; a signal kill also lands here, and on this
			// machine that means earlyoom rather than a broken guard.
			throw new Error(
				`guard ${name} did not run to completion: ${cause?.message ?? "killed by signal"}`,
			);
		}
		return {
			status,
			stdout,
			stderr,
			silent: stdout.trim() === "" && stderr.trim() === "",
		};
	}

	/**
	 * A live session: a real process, plus the registry entries that name it.
	 *
	 * mantahostels#104 ruled `sessions/<pid>.json` the arbiter's single registry and dropped
	 * the jobs one, so a live session is modelled by an actual process whose
	 * `pid` and `procStart` (the kernel start-time token, /proc/<pid>/stat field
	 * 22) the arbiter can check. Deleting a jobs directory would NOT do instead:
	 * job dirs outlive their sessions (all 106 on this machine lack a sessions
	 * entry, 35 over a day old), so their removal models no death that happens.
	 *
	 * The jobs entry is written too, because the arbiter treats a state file that
	 * has since vanished as proof of death.
	 */
	live(state: "blocked" | "done" = "blocked") {
		// A waiting process, ORPHANED on purpose: `sh` backgrounds it and exits, so
		// the sleep is re-parented to init. It must not be a child of this test
		// process, because killing a child leaves a zombie until its parent reaps
		// it — and a zombie still has a /proc/<pid>/stat entry, so the arbiter would
		// read the killed holder as alive. Reaping needs the event loop, which a
		// synchronous test blocks, so the wait would never end.
		const out = spawnSync("sh", ["-c", "sleep 300 >/dev/null 2>&1 & echo $!"], {
			encoding: "utf8",
		});
		const pid = Number(out.stdout.trim());
		this.pid = pid;

		fs.mkdirSync(this.jobDir, { recursive: true });
		fs.writeFileSync(
			this.stateFile,
			JSON.stringify({
				sessionId: this.id,
				cwd: this.arena.repo,
				state,
				updatedAt: new Date().toISOString(),
			}),
		);
		fs.writeFileSync(
			path.join(this.arena.home, ".claude", "sessions", `${pid}.json`),
			JSON.stringify({
				pid,
				sessionId: this.id,
				procStart: readProcStartOf(pid),
				cwd: this.arena.repo,
				status: "idle",
				kind: "bg",
			}),
		);
		return this;
	}

	/** The session's process is gone without a SessionEnd — an earlyoom kill. */
	killed() {
		if (!this.pid) return this;
		try {
			process.kill(this.pid, "SIGKILL");
		} catch {
			/* already gone */
		}
		// init reaps an orphan promptly, but not instantly; until it does, /proc
		// still answers and the holder would read as alive.
		const deadline = Date.now() + 3000;
		while (Date.now() < deadline && readProcStartOf(this.pid) !== null) {
			spawnSync("sleep", ["0.01"]);
		}
		this.pid = undefined;
		return this;
	}

	edit(file: string, body: string) {
		this.arena.write(file, body);
	}

	/**
	 * What the post-write core records after an Edit: note in the write ledger
	 * that this session wrote the file. Separate from `edit` on purpose — the before-halves
	 * model an unguarded write, with no hook in the loop to record anything.
	 */
	recordWrite(file: string) {
		this.arbiter("record", file);
	}

	stage(file: string) {
		this.arena.git("add", file);
	}

	/** The mantahostels#63 shape: no pathspec, so it sweeps whatever is in the shared index. */
	commitBare(message: string) {
		this.arena.git("commit", "-qm", message);
	}

	commitPathspec(message: string, files: string[]) {
		this.arena.git("commit", "-qm", message, "--", ...files);
	}

	/** The mantahostels#87 shape: moves the shared tree out from under every other session. */
	checkoutNew(branch: string) {
		this.arena.git("checkout", "-q", "-b", branch);
	}

	branch() {
		return this.arena.git("rev-parse", "--abbrev-ref", "HEAD").trim();
	}

	/**
	 * Invoke a guard as Claude Code would: JSON payload on stdin, with the
	 * registries pointed at the arena.
	 *
	 * Claude Code cannot run inside a test, so this proves a guard's *logic*,
	 * never that settings.json wires it on the right event and matcher.
	 * scripts/hook-registrations.test.ts covers that separately.
	 */
	runGuard(name: string, payload: Record<string, unknown>): GuardResult {
		const r = spawnSync(guardPath(name), [], {
			cwd: this.arena.repo,
			encoding: "utf8",
			input: JSON.stringify({ session_id: this.id, ...payload }),
			env: this.env,
		});
		return this.result(name, {
			status: r.status,
			stdout: r.stdout ?? "",
			stderr: r.stderr ?? "",
			cause: r.error,
		});
	}

	/**
	 * The same invocation, launched without waiting. Tier 2 needs the guards
	 * genuinely in flight at once; spawnSync in a loop is a sequence.
	 */
	runGuardAsync(
		name: string,
		payload: Record<string, unknown>,
	): Promise<GuardResult> {
		return this.spawnCollect(name, guardPath(name), [], {
			session_id: this.id,
			...payload,
		});
	}

	/**
	 * The safe issue-body edit path (mantahostels#131), as a real process, launched without
	 * waiting — the same reason runGuardAsync exists.
	 */
	issueBody(...args: string[]): Promise<GuardResult> {
		return this.spawnCollect("issue-body.js", "node", [
			path.join(__dirname, "issue-body.js"),
			...args,
		]);
	}

	/** Run a child to completion in this session's environment, collecting output. */
	private spawnCollect(
		name: string,
		command: string,
		args: string[],
		stdin?: Record<string, unknown>,
	): Promise<GuardResult> {
		return new Promise((resolve, reject) => {
			const child = spawn(command, args, {
				cwd: this.arena.repo,
				env: this.env,
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (c) => {
				stdout += c;
			});
			child.stderr.on("data", (c) => {
				stderr += c;
			});
			child.on("error", reject);
			// A guard that exits without draining stdin raises EPIPE, which is
			// uncaught and kills the run rather than failing the scenario.
			child.stdin.on("error", () => {
				/* the exit status is what the scenario judges */
			});
			child.on("close", (status) => {
				try {
					resolve(this.result(name, { status, stdout, stderr }));
				} catch (e) {
					reject(e);
				}
			});
			if (stdin) child.stdin.end(JSON.stringify(stdin));
			else child.stdin.end();
		});
	}

	/** A write payload, the field `Write|Edit|NotebookEdit` guards read. */
	writePayload(file: string) {
		return {
			hook_event_name: "PreToolUse",
			tool_name: "Edit",
			tool_input: { file_path: path.join(this.arena.repo, file) },
		};
	}

	/** A Bash payload, the field a commit-form guard reads. */
	bashPayload(command: string) {
		return {
			hook_event_name: "PreToolUse",
			tool_name: "Bash",
			tool_input: { command },
		};
	}
}
