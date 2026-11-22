import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ignoreFailure } from "./lib/caught.js";
import { noop } from "./lib/noop.js";
import { procRoot } from "./lib/proc-root.js";
import type { Arena } from "./proving-run";

function readProcStartOf(pid: number): string | null {
	try {
		const stat = fs.readFileSync(`${procRoot()}/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19] ?? null;
	} catch {
		return null;
	}
}

const guardPath = (name: string) => path.join(__dirname, name);
export const guardExists = (name: string) => fs.existsSync(guardPath(name));

export const GUARDS = {
	fileClaim: "guard-dispatch.js",
	commitForm: "guard-dispatch.js",
	branch: "guard-dispatch.js",
	arbiter: "session-arbiter.js",
} as const;

export interface GuardResult {
	status: number;
	stdout: string;
	stderr: string;
	silent: boolean;
}

export class Session {
	private pid?: number;

	constructor(
		readonly arena: Arena,
		readonly id: string,
	) {}

	private get jobDir() {
		return path.join(this.arena.home, ".claude", "jobs", this.id);
	}

	private get stateFile() {
		return path.join(this.jobDir, "state.json");
	}

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

	live(state: "blocked" | "done" = "blocked") {
		// A zombie keeps its /proc/<pid>/stat entry, state Z, until its parent
		// reaps it: https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html
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

	killed() {
		if (!this.pid) return this;
		const pid = this.pid;
		ignoreFailure(() => process.kill(pid, "SIGKILL"));
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

	commitPathspec(message: string, files: string[]) {
		this.arena.git("commit", "-qm", message, "--", ...files);
	}

	checkoutNew(branch: string) {
		this.arena.git("checkout", "-q", "-b", branch);
	}

	branch() {
		return this.arena.git("rev-parse", "--abbrev-ref", "HEAD").trim();
	}

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

	runGuardAsync(
		name: string,
		payload: Record<string, unknown>,
	): Promise<GuardResult> {
		return this.spawnCollect(name, guardPath(name), [], {
			session_id: this.id,
			...payload,
		});
	}

	issueBody(...args: string[]): Promise<GuardResult> {
		return this.spawnCollect("issue-body.js", "node", [
			path.join(__dirname, "issue-body.js"),
			...args,
		]);
	}

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
			// Writing to a pipe whose reader has exited raises EPIPE:
			// https://nodejs.org/api/errors.html#common-system-errors
			child.stdin.on("error", noop);
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

	writePayload(file: string) {
		return {
			hook_event_name: "PreToolUse",
			tool_name: "Edit",
			tool_input: { file_path: path.join(this.arena.repo, file) },
		};
	}

	bashPayload(command: string) {
		return {
			hook_event_name: "PreToolUse",
			tool_name: "Bash",
			tool_input: { command },
		};
	}
}
