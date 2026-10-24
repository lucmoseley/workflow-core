/*
 * dispatch-sessions-testkit.ts — the fixture every test driving
 * scripts/dispatch-sessions.sh end to end stands on: a stub `claude`, and a
 * throwaway root holding a stub for every oracle the launcher and its gates
 * read (#2423).
 *
 * The stub `claude` is injected at WFC_CLAUDE_BIN (mantahostels#1374).
 * `dispatch-sessions.sh` exports it, so one var covers both the launcher and the
 * live oracle of the ledger check it shells out to.
 *
 * Break it and both dispatch suites fail at once, or pass blind: an oracle left
 * unstubbed lets a case launch a real `claude --bg` session, write fake
 * launches to the working dispatch ledger so the next real dispatch is refused
 * as a duplicate, or read the machine's own memory, load and Windows bridge, so
 * the gate cases pin nothing.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";
import { writePsStub } from "./ps-stub";
import { PROBE_TIMEOUT_MS } from "./usage-probe.js";

/* The `probeHangs` stub's sleep, which runs out only where the stamp stop
 * failed. It must end before the probe's ceiling, whose kill would pass for
 * the stamp stop; half the ceiling leaves the other half for the stub's work
 * before the sleep, and gives a loaded machine the longest window that rule
 * allows to land the stop. */
const PROBE_HANG_SECONDS = PROBE_TIMEOUT_MS / 2 / 1000;

export const SCRIPT = path.resolve(__dirname, "..", "dispatch-sessions.sh");

/** Must match `CLAUDE_CODE_SESSION_ID` in `baseEnv()` below — the self-test
 * `scripts/lib/agent-liveness.js` runs on every `agents --json` listing. */
export const SELF_SESSION_ID = "dispatch-sessions-test-self";

/** A self-only listing (admission.js's always-admit-one guarantee applies —
 * see that constant's own header) or one with a neighbour present too (the
 * guarantee does not apply, so a low-memory refusal actually refuses). */
export function agentsListing(withNeighbour = false): string {
	const agents = [{ sessionId: SELF_SESSION_ID, pid: 1 }];
	if (withNeighbour) agents.push({ sessionId: "a-neighbour", pid: 2 });
	return JSON.stringify(agents);
}

export interface StubClaudeOptions {
	week?: string;
	session?: string;
	advisorAttaches?: boolean;
	advisorReason?: string;
	/** A `claude` that refuses to start, so the launch never happens. */
	launchFails?: boolean;
	/** Where to write the stub — defaults to the WFC_CLAUDE_BIN stub path. A
	 * case exercising the bare-name fallback (mantahostels#1401) stands one on PATH instead,
	 * named exactly `claude`. */
	at?: string;
	/** What `agents --json` answers. Defaults to `agentsListing()`, this
	 * session alone, which both the duplicate gate's live limb and
	 * admission.js's session-count re-read (mantahostels#2553) read as "nobody else is
	 * running" rather than as unparseable. A case driving either with real
	 * sessions passes a JSON array here. */
	agentsJson?: string;
	/** The launch's own stdout first line — real `claude --bg` prints the job
	 * id here (`claude --help`'s own words, mantahostels#3488). Defaults to a plain
	 * "launched" for every case that does not care what the line says; a case
	 * asserting the ledger's `jobId` passes a short-id-shaped string. */
	launchOutput?: string;
	/** Where this stub records its argv — defaults to the shared `dir/argv`.
	 * A case standing up TWO stubs gives one its own log, so `argvLines()` can
	 * say which of them a call actually reached rather than reading a union of
	 * both (#275). */
	argvLog?: string;
	/** The probe rewrites this seat's usage cache, freshly stamped, with these
	 * bars, after writing its advisor line and before printing its own, as
	 * #2189 measured. */
	probeRefreshes?: { configDir: string; session: number; week: number };
	/** The probe hangs after its refresh, as the real one runs on past it on a
	 * section nothing reads (#2189); `dir/probe-ended` records one that ran on. */
	probeHangs?: boolean;
}

/** Its fields are re-pointed before every test: read them through the handle
 * inside the test body, never at module scope. Its functions read the handle
 * when called, so they may be destructured anywhere. */
export interface DispatchFixture {
	dir: string;
	/** The /proc/meminfo admission.js reads; a refusal case overwrites it. */
	meminfo: string;
	loadavg: string;
	/**
	 * A stub `claude`. It records every argv it was
	 * called with, answers the `/usage` probe from the given bars, and writes the
	 * advisor line into whatever `--debug-file` it was handed — which is the seam
	 * the real CLI reports advisor attachment through.
	 */
	stubClaude: (opts: StubClaudeOptions) => void;
	stubPath: () => string;
	/** The env every run needs, plus whatever a case overrides. */
	baseEnv: (extra?: Record<string, string>) => NodeJS.ProcessEnv;
	launchArgv: () => string | undefined;
	argvLines: (f?: string) => string[];
	/** A reg.exe that never answers, so the interop probe reads the bridge as
	 * wedged. */
	regWedged: () => string;
}

/** Register the beforeEach/afterEach that build and remove a fresh root. */
export function dispatchFixture(): DispatchFixture {
	const fx: DispatchFixture = {
		dir: "",
		meminfo: "",
		loadavg: "",
		stubClaude,
		stubPath,
		baseEnv,
		launchArgv,
		argvLines,
		regWedged,
	};
	let psEmpty = "";
	let reapEmpty = "";
	let regHealthy = "";
	let ghNoParent = "";
	let kernelClean = "";

	beforeEach(() => {
		fx.dir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-sessions-"));
		// The per-member re-read (mantahostels#2553) calls `node scripts/admission.js`, which
		// reads real /proc/meminfo, `ps` and the reap script unless these three
		// env vars point it elsewhere (`scripts/lib/admission.js`'s own injection
		// points). Every case gets a generous, deterministic reading by
		// default.
		fx.meminfo = path.join(fx.dir, "meminfo");
		fs.writeFileSync(fx.meminfo, "MemAvailable:    20000000 kB\n");
		psEmpty = writePsStub(fx.dir, [], { name: "ps-empty" });
		reapEmpty = path.join(fx.dir, "reap-empty.js");
		fs.writeFileSync(
			reapEmpty,
			"process.stdout.write(JSON.stringify({ reaped: [] }));\n",
		);
		// The interop probe (mantahostels#3111) runs before the allowance gate and again before
		// every spawn. Pointed at a stub that exits 1 at once — exactly what the real
		// reg.exe does for a key that does not exist — so no case queries the
		// machine's actual Windows bridge.
		regHealthy = path.join(fx.dir, "reg-healthy");
		fs.writeFileSync(regHealthy, "#!/bin/bash\nexit 1\n", { mode: 0o755 });
		// The duplicate gate asks GitHub for each member's parent (#2310); this
		// answers every one as an issue with none, so no case reaches GitHub.
		ghNoParent = path.join(fx.dir, "gh-no-parent");
		fs.writeFileSync(
			ghNoParent,
			"#!/bin/sh\necho 'gh: No parent issue found (HTTP 404)' >&2\nexit 1\n",
			{ mode: 0o755 },
		);
		// The re-read's CPU limb (#830) reads this rather than the live load, so a
		// busy machine never refuses a case; the load cases overwrite it.
		fx.loadavg = path.join(fx.dir, "loadavg");
		fs.writeFileSync(fx.loadavg, "0.50 0.50 0.50 1/300 1\n");
		// The kernel-stall check (#867) reads this rather than the machine's own
		// kernel log, so a stalled boot never refuses a case.
		kernelClean = path.join(fx.dir, "kernel-clean.log");
		fs.writeFileSync(
			kernelClean,
			"2026-10-07T23:18:35+08:00 host kernel: Booting Linux on physical CPU 0x0\n",
		);
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
			launchOutput = "launched",
			argvLog = path.join(fx.dir, "argv"),
			probeRefreshes,
			probeHangs = false,
		} = opts;
		const refresh = probeRefreshes
			? [
					`  mkdir -p '${probeRefreshes.configDir}'`,
					`  printf '{"cachedUsageUtilization":{"fetchedAtMs":%s,"utilization":{"limits":[{"kind":"session","percent":${probeRefreshes.session}},{"kind":"weekly_all","percent":${probeRefreshes.week}}]}}}' "$(($(date +%s%N) / 1000000))" > '${path.join(probeRefreshes.configDir, ".claude.json")}'`,
				]
			: [];
		const script = [
			"#!/bin/bash",
			`printf '%s\\n' "$*" >> "${argvLog}"`,
			// The probe call carries --debug-file; the launch calls do not.
			'log=""',
			'prev=""',
			'for a in "$@"; do',
			'  if [ "$prev" = "--debug-file" ]; then log="$a"; fi',
			'  prev="$a"',
			"done",
			'if [ -n "$log" ]; then',
			advisorAttaches
				? '  printf "[DEBUG] [AdvisorTool] Advisor model: opus\\n" > "$log"'
				: `  printf '%s' '${advisorReason ? `[DEBUG] [AdvisorTool] ${advisorReason}` : ""}' > "$log"`,
			// Where the probe ran from, and whether its stdin is at EOF at once.
			`  pwd > "${path.join(fx.dir, "probe-cwd")}"`,
			`  if read -r -t 5 _; then echo open; else echo "eof $?"; fi > "${path.join(fx.dir, "probe-stdin")}"`,
			...refresh,
			probeHangs ? `  sleep ${PROBE_HANG_SECONDS}` : "",
			`  echo ended > "${path.join(fx.dir, "probe-ended")}"`,
			`  printf 'Current session: ${session}%% used · resets Aug 23, 11:49pm\\n'`,
			`  printf 'Current week (all models): ${week}%% used · resets Aug 30, 7:59pm\\n'`,
			"  exit 0",
			"fi",
			`if [ "$1" = "agents" ]; then printf '%s\\n' '${agentsJson}'; exit 0; fi`,
			launchFails
				? "printf 'could not start\\n' >&2\nexit 1"
				: `printf '%s\\n' '${launchOutput}'`,
		]
			.filter(Boolean)
			.join("\n");
		fs.writeFileSync(at, script);
		fs.chmodSync(at, 0o755);
	}

	function stubPath(): string {
		return path.join(fx.dir, "claude");
	}

	function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
		return {
			...process.env,
			LC_ALL: "C",
			WFC_CLAUDE_BIN: stubPath(),
			/* An unset WFC_CLAUDE_BIN falls back to the union wrapper where the
			 * machine has one, so every case points that lookup at a path that
			 * does not exist. The case exercising the fallback overrides it —
			 * so any new case that deletes WFC_CLAUDE_BIN lands on the no-wrapper
			 * branch unless it sets this too. */
			WFC_UNION_WRAPPER: path.join(fx.dir, "no-such-union-wrapper"),
			/* The launcher records every launch to a ledger (mantahostels#1337). These runs drive
			 * the real script against a stubbed `claude`, so without redirecting it
			 * they append fake launches to the working ledger and the next real
			 * dispatch is refused as a duplicate. */
			WFC_DISPATCH_ROOT: fx.dir,
			/* The already-dispatched checker this script calls runs on check.js,
			 * which writes ::error::/::warning:: annotations to STDOUT under
			 * GITHUB_ACTIONS, polluting the stdout these cases assert on. */
			GITHUB_ACTIONS: "",
			// admission.js's session-count re-read (mantahostels#2553) is always strict about the
			// self-test (`listedSessionIds`) — the default `agentsJson` above lists
			// exactly this id, so the re-read sees itself and nobody else.
			CLAUDE_CODE_SESSION_ID: SELF_SESSION_ID,
			WFC_MEMINFO: fx.meminfo,
			WFC_PS: psEmpty,
			WFC_REAP_SCRIPT: reapEmpty,
			WFC_LOADAVG: fx.loadavg,
			WFC_LOAD_CEILING: "10",
			// Isolates the allowance gate's JSON source (#294) from this machine's
			// real `~/.claude/.claude.json` — absent here, so every case falls back
			// to the stub `claude -p "/usage"` transcript above.
			// dispatch-sessions.test.ts's JSON-path cases override it.
			CLAUDE_CONFIG_DIR: path.join(fx.dir, "no-such-config"),
			// The seat kind is read from `$HOME/.claude/refill-seats`, host
			// configuration this machine's real file must not reach.
			HOME: fx.dir,
			// Deterministic tests never wait on the real stagger;
			// dispatch-sessions.test.ts's stagger cases override it.
			WFC_DISPATCH_STAGGER_SECONDS: "0",
			// Never the machine's real switch: with burn mode on, every `--model
			// sonnet` assertion would read `opus[1m]` instead.
			WFC_BURN_MARKER: path.join(fx.dir, "burn-mode"),
			CLAUDE_INTEROP_REG: regHealthy,
			WFC_KERNEL_LOG: kernelClean,
			WFC_GH: ghNoParent,
			...extra,
		};
	}

	function launchArgv(): string | undefined {
		return argvLines().find((l) => l.includes("--bg"));
	}

	function argvLines(f: string = path.join(fx.dir, "argv")): string[] {
		if (!fs.existsSync(f)) return [];
		return fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean);
	}

	function regWedged(): string {
		const at = path.join(fx.dir, "reg-wedged");
		fs.writeFileSync(at, "#!/bin/bash\nsleep 600\n", { mode: 0o755 });
		return at;
	}

	return fx;
}
