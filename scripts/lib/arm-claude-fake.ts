/*
 * The in-process fake of the `claude` calls lib/run-arm.js makes through its
 * `claude` port (#5149). It answers from the installed harness's recordings
 * — scripts/fixtures/agents-stop.json's rows and stops,
 * scripts/fixtures/bg-launch.json's positional launch — and runs
 * lib/fixtures/auth-status.js, the `auth status` fake. Held to the
 * production adapter by lib/arm-claude.contract.test.ts.
 */

import path from "node:path";
import type { Row } from "./agents-stop-fake";
import { recorded as stops } from "./agents-stop-fake";
import { AUTH_STATUS_FAKE } from "./auth-status-fake";
import { buildRecordedAnswer } from "./bg-launch-fake";
import { runInProcess } from "./run-in-process";

export const FAKE_VERSION = "2.1.304";

export interface Answer {
	status: number | null;
	stdout: string;
	stderr: string;
	error?: Error;
}

interface CallOpts {
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	timeout: number;
}

/** One `--bg` launch. */
export interface Launch {
	bin: string;
	argv: string[];
	cwd: string | undefined;
	cfg: string | undefined;
	path: string | undefined;
}

/** A launch's or a stop's answer: the recorded one, or a failure printing
 * `fail` to stderr and exiting 1. */
export type Outcome = "ok" | { fail: string };

export interface ArmClaudeOptions {
	/** Binaries whose `--version` prints nothing and exits 1. */
	silent?: string[];
	/** The `agents` answer for the `n`th listing, 1-based, on seat
	 * `configDir`: rows, or null for an exit 1. None lists no job. */
	listing?: (configDir: string | undefined, n: number) => Row[] | null;
	/** The `n`th launch's outcome, 1-based. None answers each as recorded. */
	launch?: (n: number) => Outcome;
	/** The `n`th stop's outcome, 1-based, of job `job`. None answers each as
	 * recorded, `stopped <job>`. */
	stop?: (job: string, n: number) => Outcome | "noJob";
}

const answer = (status: number, stdout = "", stderr = ""): Answer => ({
	status,
	stdout,
	stderr,
});

const recordedStop = (kind: "ok" | "noJob", job: string): Answer => {
	const r = stops.stops[kind];
	return answer(
		r.status,
		r.stdout.replaceAll(r.id, job),
		r.stderr.replaceAll(r.id, job),
	);
};

export const launchedJob = (n: number) => n.toString(16).padStart(8, "0");

/**
 * The fake, and every call's binary and argv, each launch tried, the jobs
 * launched, and the jobs stopped.
 */
export function createArmClaudeFake(opts: ArmClaudeOptions = {}) {
	const calls: { bin: string; args: string[] }[] = [];
	const launches: Launch[] = [];
	const jobs: string[] = [];
	const stopped: string[] = [];
	let listings = 0;

	const onLaunch = (bin: string, args: string[], o: CallOpts) => {
		launches.push({
			bin,
			argv: args,
			cwd: o.cwd,
			cfg: o.env?.CLAUDE_CONFIG_DIR,
			path: o.env?.PATH,
		});
		const outcome = opts.launch?.(launches.length) ?? "ok";
		if (outcome !== "ok") return answer(1, "", `${outcome.fail}\n`);
		const job = launchedJob(launches.length);
		jobs.push(job);
		const { stdout, stderr } = buildRecordedAnswer(job, "positional");
		return answer(0, stdout, stderr);
	};

	const onStop = (job: string) => {
		stopped.push(job);
		const outcome = opts.stop?.(job, stopped.length) ?? "ok";
		if (outcome === "ok" || outcome === "noJob")
			return recordedStop(outcome, job);
		return answer(1, "", `${outcome.fail}\n`);
	};

	const onVersion = (bin: string) =>
		opts.silent?.includes(bin)
			? answer(1)
			: answer(0, `${FAKE_VERSION} (Claude Code)\n`);

	const onAuth = (args: string[], o: CallOpts) => {
		const r = runInProcess(AUTH_STATUS_FAKE, args.slice(1), {
			cwd: o.cwd ?? path.parse(process.cwd()).root,
			env: o.env ?? process.env,
		});
		return answer(r.status, r.stdout, r.stderr);
	};

	const onAgents = (o: CallOpts) => {
		listings++;
		const rows = opts.listing
			? opts.listing(o.env?.CLAUDE_CONFIG_DIR, listings)
			: [];
		return rows === null ? answer(1) : answer(0, JSON.stringify(rows));
	};

	const spawn = (bin: string, args: string[], o: CallOpts): Answer => {
		calls.push({ bin, args });
		const [verb] = args;
		if (verb === "--version") return onVersion(bin);
		if (verb === "auth") return onAuth(args, o);
		if (verb === "agents") return onAgents(o);
		if (verb === "stop") return onStop(String(args[1]));
		return onLaunch(bin, args, o);
	};

	return {
		spawn,
		calls,
		launches,
		jobs,
		stopped,
		get listings() {
			return listings;
		},
	};
}
