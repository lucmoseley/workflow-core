/*
 * The in-process fakes of the ports rescue-sessions' cores take (#5157):
 * `claude agents --json` as a RunOracle, `claude stop` as its spawn, `gh`,
 * and a clock whose sleep advances it.
 *
 * The oracle and the stop answer through lib/arm-claude-fake.ts's spawn, the
 * installed harness's recordings; the oracle's fold of each seat's answer
 * into what lib/agent-liveness.js's runOracle returns or throws is held to
 * runOracle itself by lib/rescue-ports.contract.test.ts. `gh` answers through
 * lib/gh-fake.ts's ghServe, an issue in its recorded shape.
 *
 * FOR TESTS ONLY.
 */

import path from "node:path";
import type { Row } from "./agents-stop-fake";
import { buildUnrecordedRow } from "./agents-stop-fake";
import { type Answer, createArmClaudeFake } from "./arm-claude-fake";
import { asRecorded, type GhAnswer, ghServe } from "./gh-fake";

type RunOracle = (bin: string, timeoutMs: number, dirs: string[]) => string[];

interface SpawnOpts {
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	timeout: number;
}

/** What an unreachable tracker answers every call. */
export const GH_DOWN: GhAnswer = {
	status: 1,
	stdout: "",
	stderr: "HTTP 502\n",
};

/**
 * The oracle over `seatAnswer`, one spawned answer a seat: each seat's stdout
 * where every seat exits 0, else runOracle's throw, carrying the first
 * failing seat's status in seat order.
 */
export function buildRunOracle(
	seatAnswer: (bin: string, dir: string, timeoutMs: number) => Answer,
): RunOracle {
	return (bin, timeoutMs, dirs) => {
		if (dirs.length === 0) throw new Error("runOracle was given no config dir");
		const answers = dirs.map((dir) => seatAnswer(bin, dir, timeoutMs));
		const failed = answers.find((a) => a.status !== 0);
		if (failed)
			throw Object.assign(new Error(`${bin} agents --json failed`), {
				status: failed.status,
			});
		return answers.map((a) => a.stdout);
	};
}

/** A row as the listing prints it: a field left undefined is left out. */
const listed = (row: object): Row =>
	buildUnrecordedRow(
		Object.fromEntries(
			Object.entries(row).filter(([, v]) => v !== undefined),
		) as Row,
	);

/** One stop the fake answered: the job, and the seat it ran on. */
export interface Stop {
	job: string;
	seat: string;
}

/** One `gh` call: its argv, and the stdin it was given. */
export interface GhCall {
	args: string[];
	input: string | undefined;
}

/**
 * The ports, and the world they answer from. Every seat lists this session
 * ("sandbox") ahead of its rows, for the oracle's self-test; a seat never
 * given rows fails its listing.
 */
export function createRescuePorts(procRoot: string) {
	const listing = new Map<string, Row[]>();
	const afterStop = new Map<string, Row[]>();
	const failing = new Set<string>();
	const stopFails = new Set<string>();
	const between = new Map<string, () => void>();
	const onSeatStop = new Map<string, () => void>();
	const reads = new Map<string, number>();
	const closed = new Set<number>();
	const stops: Stop[] = [];
	const ghCalls: GhCall[] = [];
	const hooks: {
		onStop?: (stop: Stop) => void;
		onGh?: (call: GhCall) => void;
	} = {};
	let gh: { down: boolean; commentFails: boolean } = {
		down: false,
		commentFails: false,
	};
	let clock = Date.now();
	let stopSeat = "";

	const claude = createArmClaudeFake({
		listing: (dir = "") => {
			const n = (reads.get(dir) ?? 0) + 1;
			reads.set(dir, n);
			if (failing.has(dir)) return null;
			if (n === 2) between.get(dir)?.();
			return listing.get(dir) ?? null;
		},
		stop: () => (stopFails.has(stopSeat) ? { fail: "no such job" } : "ok"),
	});

	const spawn = (bin: string, args: string[], o: SpawnOpts): Answer => {
		if (args[0] !== "stop") return claude.spawn(bin, args, o);
		stopSeat = o.env?.CLAUDE_CONFIG_DIR ?? "";
		const stop = { job: String(args[1]), seat: stopSeat };
		stops.push(stop);
		hooks.onStop?.(stop);
		const answer = claude.spawn(bin, args, o);
		if (answer.status !== 0) return answer;
		const after = afterStop.get(stopSeat);
		if (after) listing.set(stopSeat, after);
		onSeatStop.get(stopSeat)?.();
		return answer;
	};

	const issue = (n: number) =>
		asRecorded("issue", {
			number: n,
			title: "Takeover",
			state: closed.has(n) ? "closed" : "open",
			labels: [],
			body: "b",
		});

	const ghRun = (args: string[], opts: { input?: unknown } = {}) => {
		const call = {
			args,
			input: typeof opts.input === "string" ? opts.input : undefined,
		};
		ghCalls.push(call);
		hooks.onGh?.(call);
		const ok = (stdout: string) => ghServe({ status: 0, stdout, stderr: "" });
		if (gh.down) return ghServe(GH_DOWN)(args);
		if (args[0] === "api")
			return ok(issue(Number(path.basename(String(args[1])))))(args);
		if (args[0] === "issue" && args[1] === "comment" && gh.commentFails)
			return ghServe(GH_DOWN)(args);
		return ok("")(args);
	};

	const ports = {
		env: process.env,
		now: () => clock,
		sleep: async (ms: number) => {
			clock += ms;
		},
		oracle: buildRunOracle((bin, dir, timeout) =>
			spawn(bin, ["agents", "--json"], {
				env: { CLAUDE_CONFIG_DIR: dir },
				timeout,
			}),
		),
		claude: spawn,
		gh: ghRun,
		procRoot,
	};

	return {
		ports,
		/** What `dir` lists, or lists once stopped where `after`. */
		lists(dir: string, rows: object[], after = false) {
			(after ? afterStop : listing).set(
				dir,
				[{ sessionId: "sandbox", state: "working" }, ...rows].map(listed),
			);
		},
		/** `dir`'s listing as `raw` rows, the sandbox's own left out. */
		listsRaw(dir: string, rows: object[], after = false) {
			(after ? afterStop : listing).set(dir, rows.map(listed));
		},
		/** No listing stands for `dir` once it is stopped. */
		keepsListingAfterStop(dir: string) {
			afterStop.delete(dir);
		},
		failing: (dir: string) => failing.add(dir),
		stopFails: (dir: string) => stopFails.add(dir),
		/** Runs on `dir`'s second listing: between the probe's two samples. */
		between: (dir: string, fn: () => void) => between.set(dir, fn),
		/** Runs once a stop on `dir` takes, after its after-stop listing. */
		onSeatStop: (dir: string, fn: () => void) => onSeatStop.set(dir, fn),
		close: (n: number) => closed.add(n),
		ghDown: () => {
			gh = { ...gh, down: true };
		},
		commentFails: () => {
			gh = { ...gh, commentFails: true };
		},
		hooks,
		readsOf: (dir: string) => reads.get(dir) ?? 0,
		stops,
		ghCalls,
	};
}
