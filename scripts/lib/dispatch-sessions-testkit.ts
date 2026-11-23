import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";
import { writeProcRoot } from "./admission-testkit";
import { buildAuthStatusBranch } from "./auth-status-fake";
import {
	buildAnswerBranch,
	type LaunchKind,
	UNRECORDED,
	writeLaunchAnswer,
} from "./bg-launch-fake";
import { buildBgBranch } from "./claude-stub";
import { type DispatchPorts, dispatch } from "./dispatch-sessions.js";
import { hostPorts } from "./dispatch-sessions-host.js";
import { defineTemplate } from "./git-fixture";
import {
	buildHeadlessBranch,
	type HeadlessCall,
	type HeadlessMode,
	readHeadlessCalls,
	writeHeadlessFake,
} from "./headless-run-fake";
import { buildLoadavgLine } from "./proc-fake";
import { writePsStub } from "./ps-stub";
import { runInProcess, runInProcessAsync } from "./run-in-process.js";
import { writeSchedClock } from "./sched-clock-fake";
import { shellQuote } from "./sh-quote.js";
import { PROBE_TIMEOUT_MS } from "./usage-probe.js";
import {
	buildRefreshBranch,
	buildUsageBranch,
	buildUsageCache,
} from "./usage-probe-fake";

const PROBE_HANG_SECONDS = PROBE_TIMEOUT_MS / 2 / 1000;

export const SCRIPT = path.resolve(__dirname, "..", "dispatch-sessions.js");
const SCRIPTS_DIR = path.resolve(__dirname, "..");
const ASYNC_MAIN = new Set(["usage-probe.js"]);
export const ROUTING = {
	WFC_MODEL_ROUTING: path.resolve(
		__dirname,
		"..",
		"fixtures",
		"model-routing",
		"fixture.json",
	),
};
const COMMITTED_COST_TABLE = path.resolve(
	__dirname,
	"..",
	"..",
	"docs/data/session-cost-table.json",
);

export const SELF_SESSION_ID = "dispatch-sessions-test-self";

export function agentsListing(withNeighbour = false): string {
	const agents = [{ sessionId: SELF_SESSION_ID, pid: 1 }];
	if (withNeighbour) agents.push({ sessionId: "a-neighbour", pid: 2 });
	return JSON.stringify(agents);
}

export interface StubClaudeOptions {
	week?: string;
	session?: string | null;
	advisorAttaches?: boolean;
	advisorReason?: string;
	launchFails?: boolean;
	at?: string;
	agentsJson?: string;
	launch?: LaunchKind | "silent";
	jobId?: string;
	argvLog?: string;
	envLog?: string;
	headless?: HeadlessMode;
	probeRefreshes?: { configDir: string; session: number; week: number };
	probeHangs?: boolean;
}

export interface DispatchFixture {
	dir: string;
	main: string;
	meminfo: string;
	loadavg: string;
	stubClaude: (opts: StubClaudeOptions) => void;
	stubPath: () => string;
	baseEnv: (extra?: Record<string, string>) => NodeJS.ProcessEnv;
	launchArgv: () => string | undefined;
	launchCwds: () => string[];
	readArgvLines: (f?: string) => string[];
	readFakeCalls: () => HeadlessCall[];
	regWedged: () => string;
	schedClock: (ratio: number) => string;
	run: (
		args: string[],
		extraEnv?: Record<string, string>,
	) => { stdout: string; stderr: string; code: number };
	runCore: (
		args: string[],
		extraEnv?: Record<string, string>,
		ports?: Partial<DispatchPorts>,
	) => Promise<{ stdout: string; stderr: string; code: number }>;
	runCoreUnder: (
		args: string[],
		run: { env: NodeJS.ProcessEnv; cwd: string },
		ports?: Partial<DispatchPorts>,
	) => Promise<{ stdout: string; stderr: string; code: number }>;
	corePorts: () => DispatchPorts;
	sleepArgs: () => string[];
}

export function writeCache(
	configDir: string,
	bars: { session?: number; weeklyAll?: number },
	fetchedAtMs = Date.now(),
): void {
	fs.mkdirSync(configDir, { recursive: true });
	fs.writeFileSync(
		path.join(configDir, ".claude.json"),
		JSON.stringify(
			buildUsageCache(
				{ session: bars.session, week: bars.weeklyAll },
				fetchedAtMs,
			),
		),
	);
}

const landingCheckout = defineTemplate((dir) => {
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: dir, encoding: "utf8" });
	const origin = path.join(dir, ".origin.git");
	git("init", "-q");
	git("init", "-q", "--bare", "-b", "main", origin);
	git("remote", "add", "origin", origin);
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	git("commit", "-q", "--allow-empty", "-m", "seed");
	git("commit", "-q", "--allow-empty", "-m", "landed");
	git("push", "-q", "origin", "HEAD:main");
	git("reset", "-q", "--hard", "HEAD~1");
});

export function dispatchFixture(): DispatchFixture {
	const fx: DispatchFixture = {
		dir: "",
		main: "",
		meminfo: "",
		loadavg: "",
		stubClaude,
		stubPath,
		baseEnv,
		launchArgv,
		launchCwds,
		readArgvLines,
		readFakeCalls,
		regWedged,
		schedClock,
		run,
		runCore,
		runCoreUnder,
		corePorts,
		sleepArgs,
	};
	let psEmpty = "";
	let procEmpty = "";
	let reapEmpty = "";
	let regHealthy = "";
	let ghNoParent = "";
	let kernelClean = "";
	let schedRunning = "";

	beforeEach(() => {
		fx.dir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-sessions-"));
		landingCheckout.instantiate(fx.dir);
		fx.main = execFileSync("git", ["rev-parse", "origin/main"], {
			cwd: fx.dir,
			encoding: "utf8",
		}).trim();
		fx.meminfo = path.join(fx.dir, "meminfo");
		fs.writeFileSync(fx.meminfo, "MemAvailable:    20000000 kB\n");
		psEmpty = writePsStub(fx.dir, [], { name: "ps-empty" });
		procEmpty = writeProcRoot(fx.dir);
		reapEmpty = path.join(fx.dir, "reap-empty.js");
		fs.writeFileSync(
			reapEmpty,
			"process.stdout.write(JSON.stringify({ reaped: [] }));\n",
		);
		regHealthy = path.join(fx.dir, "reg-healthy");
		fs.writeFileSync(regHealthy, "#!/bin/bash\nexit 1\n", { mode: 0o755 });
		ghNoParent = path.join(fx.dir, "gh-no-parent");
		fs.writeFileSync(
			ghNoParent,
			"#!/bin/sh\necho 'gh: No parent issue found (HTTP 404)' >&2\nexit 1\n",
			{ mode: 0o755 },
		);
		fx.loadavg = path.join(fx.dir, "loadavg");
		fs.writeFileSync(fx.loadavg, buildLoadavgLine(0.5));
		kernelClean = path.join(fx.dir, "kernel-clean.log");
		fs.writeFileSync(
			kernelClean,
			"2026-10-07T23:18:35+08:00 host kernel: Booting Linux on physical CPU 0x0\n",
		);
		schedRunning = schedClock(1);
	});

	afterEach(() => {
		fs.rmSync(fx.dir, { recursive: true, force: true });
	});

	function stubClaude(opts: StubClaudeOptions): void {
		const {
			week = "3",
			session = "12",
			advisorAttaches = true,
			advisorReason = "",
			launchFails = false,
			at = stubPath(),
			agentsJson = agentsListing(),
			launch = "positional",
			jobId = "0b5e55ed",
			argvLog = path.join(fx.dir, "argv"),
			envLog,
			probeRefreshes,
			probeHangs = false,
			headless = "end",
		} = opts;
		const refresh = probeRefreshes
			? buildRefreshBranch(probeRefreshes.configDir, probeRefreshes)
			: [];
		const script = [
			"#!/bin/bash",
			buildAuthStatusBranch(),
			`printf '%s\\n' "$*" >> ${shellQuote(argvLog)}`,
			'log=""',
			'prev=""',
			'for a in "$@"; do',
			'  if [ "$prev" = "--debug-file" ]; then log="$a"; fi',
			'  prev="$a"',
			"done",
			'if [ -n "$log" ]; then',
			advisorAttaches
				? '  printf "[DEBUG] [AdvisorTool] Advisor model: opus\\n" > "$log"'
				: `  printf '%s' ${shellQuote(advisorReason ? `[DEBUG] [AdvisorTool] ${advisorReason}` : "")} > "$log"`,
			`  pwd > ${shellQuote(path.join(fx.dir, "probe-cwd"))}`,
			`  if read -r -t 5 _; then echo open; else echo "eof $?"; fi > ${shellQuote(path.join(fx.dir, "probe-stdin"))}`,
			...refresh,
			probeHangs ? `  sleep ${PROBE_HANG_SECONDS}` : "",
			`  echo ended > ${shellQuote(path.join(fx.dir, "probe-ended"))}`,
			buildUsageBranch({ session: session ?? undefined, week }),
			"  exit 0",
			"fi",
			`if [ "$1" = "agents" ]; then printf '%s\\n' ${shellQuote(agentsJson)}; exit 0; fi`,
			envLog ? `env >> ${shellQuote(envLog)}` : "",
			`pwd >> ${shellQuote(path.join(fx.dir, "launch-cwds"))}`,
			buildHeadlessBranch(
				writeHeadlessFake(path.join(fx.dir, "claude-p"), {
					log: headlessLog(),
					mode: headless,
				}),
			),
			buildLaunchAnswer(launchFails, launch, jobId),
		]
			.filter(Boolean)
			.join("\n");
		fs.writeFileSync(at, script);
		fs.chmodSync(at, 0o755);
	}

	function buildLaunchAnswer(
		fails: boolean,
		launch: LaunchKind | "silent",
		jobId: string,
	): string {
		if (fails) return buildAnswerBranch(UNRECORDED.refused);
		if (launch === "silent") return buildAnswerBranch(UNRECORDED.silent);
		return buildBgBranch(writeLaunchAnswer(fx.dir, jobId, launch));
	}

	function stubPath(): string {
		return path.join(fx.dir, "claude");
	}

	function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
		return {
			...process.env,
			LC_ALL: "C",
			WFC_CLAUDE_BIN: stubPath(),
			WFC_DISPATCH_ROOT: fx.dir,
			GITHUB_ACTIONS: "",
			CLAUDE_CODE_SESSION_ID: SELF_SESSION_ID,
			TMPDIR: fx.dir,
			WFC_MEMINFO: fx.meminfo,
			WFC_PS: psEmpty,
			WFC_PROC: procEmpty,
			WFC_REAP_SCRIPT: reapEmpty,
			WFC_LOADAVG: fx.loadavg,
			WFC_LOAD_CEILING: "10",
			CLAUDE_CONFIG_DIR: path.join(fx.dir, "no-such-config"),
			HOME: fx.dir,
			WFC_DISPATCH_STAGGER_SECONDS: "0",
			WFC_BURN_MARKER: path.join(fx.dir, "burn-mode"),
			CLAUDE_INTEROP_REG: regHealthy,
			WFC_KERNEL_LOG: kernelClean,
			WFC_SCHED_CLOCK: schedRunning,
			WFC_GH: ghNoParent,
			WFC_SESSION_COST_TABLE: COMMITTED_COST_TABLE,
			...extra,
		};
	}

	function launchArgv(): string | undefined {
		return readArgvLines().find((l) => l.includes("--bg"));
	}

	function launchCwds(): string[] {
		return readArgvLines(path.join(fx.dir, "launch-cwds"));
	}

	function headlessLog(): string {
		return path.join(fx.dir, "headless.jsonl");
	}

	function readFakeCalls(): HeadlessCall[] {
		return readHeadlessCalls(headlessLog());
	}

	function readArgvLines(f: string = path.join(fx.dir, "argv")): string[] {
		if (!fs.existsSync(f)) return [];
		return fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean);
	}

	function regWedged(): string {
		const at = path.join(fx.dir, "reg-wedged");
		fs.writeFileSync(at, "#!/bin/bash\nsleep 600\n", { mode: 0o755 });
		return at;
	}

	function schedClock(ratio: number): string {
		return writeSchedClock(path.join(fx.dir, `sched-clock-${ratio}`), {
			runtime: 2 * ratio,
			busy: 2,
		});
	}

	function run(
		args: string[],
		extraEnv: Record<string, string> = {},
	): { stdout: string; stderr: string; code: number } {
		const r = spawnSync(process.execPath, [SCRIPT, ...args], {
			cwd: fx.dir,
			encoding: "utf8",
			env: baseEnv(extraEnv),
		});
		return {
			stdout: r.stdout ?? "",
			stderr: r.stderr ?? "",
			code: r.status ?? -1,
		};
	}

	function runCore(
		args: string[],
		extraEnv: Record<string, string> = {},
		ports: Partial<DispatchPorts> = {},
	): Promise<{ stdout: string; stderr: string; code: number }> {
		return runCoreUnder(args, { env: baseEnv(extraEnv), cwd: fx.dir }, ports);
	}

	function runCoreUnder(
		args: string[],
		under: { env: NodeJS.ProcessEnv; cwd: string },
		ports: Partial<DispatchPorts> = {},
	): Promise<{ stdout: string; stderr: string; code: number }> {
		return dispatch(args, { ...corePorts(), ...ports }, under);
	}

	function corePorts(): DispatchPorts {
		return {
			node: async (script, argv, { env, cwd, stdin }) => {
				const file = path.join(SCRIPTS_DIR, script);
				const opts = { cwd, env, ...(stdin === undefined ? {} : { stdin }) };
				const r = ASYNC_MAIN.has(script)
					? await runInProcessAsync(file, argv, opts)
					: runInProcess(file, argv, opts);
				return { status: r.status, stdout: r.stdout, stderr: r.stderr };
			},
			interop: hostPorts().interop,
			launch: hostPorts().launch,
			sleep: async (seconds) => {
				fs.appendFileSync(path.join(fx.dir, "sleeps"), `${seconds}\n`);
			},
		};
	}

	function sleepArgs(): string[] {
		const log = path.join(fx.dir, "sleeps");
		if (!fs.existsSync(log)) return [];
		return fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
	}

	return fx;
}
