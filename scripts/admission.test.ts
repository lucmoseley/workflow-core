// @vitest-environment node
/*
 * Pins admission.js's slot count — the memory, CPU and allowance limbs, the
 * reserves it holds back, and its refusal when memory or the session count
 * cannot be read — and the exit code each verdict carries (mantahostels#1144,
 * the ticket that put the count in code).
 *
 * Synthetic fixtures throughout: a fake `/proc/meminfo`, a fake `ps` and a fake
 * `claude agents --json`, so the arithmetic is checked against figures this
 * suite chose rather than against whatever the machine happens to be doing —
 * which is the thing the script reports on and so cannot also be its fixture.
 *
 * /pick-next §5 and scripts/dispatch-sessions.sh re-read this count before
 * every launch: loosen a case and a session can be admitted past the
 * machine's 10 GB cap, which freezes the machine, or a free slot held shut.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	admissionFrom,
	readRunningVitestSuites,
	readTreePssKb,
	SUITE_RESTING_MB,
	SWAP_HOLD_AVAILABLE_MB,
	WHOLE_SUITE_WORKERS,
} from "./lib/admission";
import {
	buildIsolatedEnv,
	type Lander,
	SELF,
	writeHostRepo,
	writeLoadavg,
	writeProcRoot,
	writeReapScript,
} from "./lib/admission-testkit";
import { writeCache } from "./lib/dispatch-sessions-testkit";
import { carrying } from "./lib/proc-fake";
import { writePsStub } from "./lib/ps-stub";
import { runInProcess } from "./lib/run-in-process";

/* earlyoom's kill line, which every verdict holds free and `floorMb` reports (#337). */
const FLOOR = 794;

/** A rung's resting MB, read out of admission.js rather than copied (mantahostels#2715). */
const rung = (n: 1 | 2 | 3) => SUITE_RESTING_MB[n];

const SCRIPT = path.resolve(__dirname, "admission.js");
/* The host draw every case declares unless it says otherwise (#2221): one
 * session's need at p95 is ceil(600k + 1.645 × 200 × √k), so 929, 1666, 2370
 * and 3058 MB for k of 1 to 4 with no live session. */
const HOST_DRAW = { sessionMeanMb: 600, sessionSigmaMb: 200 };
/* earlyoom's floor and the margin above it, off every budget (#2221). */
const HELD = FLOOR + 300;
/* The one spare pair every verdict reserves where `ps` lists no idle pair to
 * price it off (#2223): `IDLE_PAIR_MB` in lib/admission.js. */
const PAIR = 106;
/* A neighbour holding 640 MB, so the live draw still needs
 * ceil(600 + 329 − 640) = 289 MB for it. */
const GROWN = "other@701";
/** A pair PSS of `mb`, in the kB a `pss` fixture takes. */
const mbKb = (mb: number) => mb * 1024;
const GROWN_PSS = { "701": mbKb(640) };
const SPARE_DIR = "/tmp/x/spare";
/** `cwds` for `bg-spare` pids still sitting in it: their pairs read idle (#2502). */
const idleAt = (...pids: string[]) =>
	Object.fromEntries(pids.map((pid) => [pid, SPARE_DIR]));

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "admission-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A `/proc/meminfo` reporting `mb` available, or one with no MemAvailable
 * line, and `swap` in MB where given, or no swap lines. */
const meminfo = (
	mb: number | null,
	swap: { totalMb: number; freeMb: number } | null = null,
) => {
	const p = path.join(dir, "meminfo");
	fs.writeFileSync(
		p,
		`MemTotal:        8114464 kB\nMemFree:          554820 kB\n${
			mb === null ? "" : `MemAvailable: ${mb * 1024} kB\n`
		}${
			swap === null
				? ""
				: `SwapTotal: ${swap.totalMb * 1024} kB\nSwapFree: ${swap.freeMb * 1024} kB\n`
		}`,
	);
	return p;
};

/** A fake `ps -eo comm=,args=` printing `lines`, or one that fails outright. */
const ps = (lines: string[], { fails = false } = {}) =>
	writePsStub(dir, lines, { fails });

/** A fake `claude` whose `agents --json` lists `ids`, each at `cwd` and in its
 * `states` entry where it has one, or fails / lies. */
const claude = (
	ids: string[] | null,
	{
		raw,
		cwd,
		states = {},
	}: { raw?: string; cwd?: string; states?: Record<string, string> } = {},
) => {
	const p = path.join(dir, "claude");
	if (ids === null && raw === undefined) {
		fs.writeFileSync(p, '#!/bin/sh\necho "no daemon" >&2\nexit 1\n', {
			mode: 0o755,
		});
		return p;
	}
	const body =
		raw ??
		JSON.stringify(
			(ids ?? []).map((sessionId) => {
				const [id, pid] = sessionId.split("@");
				const state = states[id] ? { state: states[id] } : {};
				return pid
					? { sessionId: id, pid: Number(pid), cwd, ...state }
					: { sessionId, cwd, ...state };
			}),
		);
	const out = path.join(dir, "agents.json");
	fs.writeFileSync(out, body);
	fs.writeFileSync(p, `#!/bin/sh\ncat ${JSON.stringify(out)}\n`, {
		mode: 0o755,
	});
	return p;
};

interface Machine {
	mb?: number | null;
	sessions?: string[] | null;
	psLines?: string[];
	psFails?: boolean;
	self?: string;
	pss?: Record<string, number>;
	/** Each descendant pid's parent, for the fake `/proc`'s `stat` files. */
	parents?: Record<string, string>;
	/** Each pid's cwd, for the fake `/proc`'s `cwd` symlinks. */
	cwds?: Record<string, string>;
	/** Each pid's environment, for the fake `/proc`'s `environ` files. */
	environs?: Record<string, string[]>;
	reaped?: Array<{ pss: number | null }> | null;
	reapFails?: boolean;
	reapRaw?: string;
	/** argv past `--json` — `--launch` or `--load-only`. */
	args?: string[];
	/** false runs the text report, `json` then reading null. */
	json?: boolean;
	/** The host's config, HOST_DRAW unless given. */
	hostConfig?: Record<string, unknown>;
	/** The oracle's answer verbatim, in place of `sessions`. */
	agentsRaw?: string;
	/** load1 for the stand-in /proc/loadavg (#830); null names no such file. */
	load?: number | null;
	/** WFC_SESSION_CEILING (#2141); off unless given, so a case meets it only by asking. */
	sessionCeiling?: string;
	/** Lander queue markers (#2416), each carrying its charge (#3323), in the
	 * case's own queue dir. */
	landers?: Lander[];
	/** Each listed session's oracle `state`, by id; none where absent. */
	states?: Record<string, string>;
	/** `WFC_SESSION_FLOOR`, the machine's session floor (#2501); null unsets it,
	 * so `$HOME/.claude/session-floor` is read, `$HOME` the case's dir. */
	sessionFloor?: string | null;
	/** Swap in MB, as `/proc/meminfo` reports it; null writes no swap lines. */
	swap?: { totalMb: number; freeMb: number } | null;
}

/* This process as a lander holding a whole suite, at its charge (#3323). */
const WHOLE_LANDER: Lander = { pid: process.pid, chargeMb: 1150 };

const run = (m: Machine = {}) => {
	const {
		mb = 4000,
		sessions = [SELF],
		psLines = ["claude /usr/bin/claude"],
		psFails = false,
		self = SELF,
		pss = {},
		parents = {},
		cwds = {},
		environs = {},
		reaped = [],
		reapFails = false,
		reapRaw,
		args = [],
		hostConfig = HOST_DRAW,
		agentsRaw,
		load = 0.5,
		sessionCeiling = "0",
		json = true,
		landers = [],
		states = {},
		sessionFloor = "",
		swap = null,
	} = m;
	const host = writeHostRepo(dir, hostConfig);
	const r = runInProcess(SCRIPT, [...(json ? ["--json"] : []), ...args], {
		env: {
			...process.env,
			...buildIsolatedEnv(dir, { landers }),
			WFC_MEMINFO: meminfo(mb, swap),
			WFC_PS: ps(psLines, { fails: psFails }),
			WFC_CLAUDE_BIN: claude(sessions, { raw: agentsRaw, cwd: host, states }),
			WFC_PROC: writeProcRoot(dir, { pss, parents, cwds, environs }),
			WFC_REAP_SCRIPT: writeReapScript(dir, reaped, {
				fails: reapFails,
				raw: reapRaw,
			}),
			WFC_LOADAVG: writeLoadavg(dir, load),
			WFC_SESSION_CEILING: sessionCeiling,
			...(sessionFloor === null
				? { WFC_SESSION_FLOOR: undefined, HOME: dir }
				: { WFC_SESSION_FLOOR: sessionFloor }),
			CLAUDE_CODE_SESSION_ID: self,
			CLAUDE_PROJECT_DIR: host,
		},
	});
	return {
		status: r.status,
		stdout: r.stdout,
		stderr: r.stderr,
		json: r.stdout.trim().startsWith("{") ? JSON.parse(r.stdout) : null,
	};
};

describe("slot arithmetic", () => {
	it("admits the most sessions whose aggregate draw fits the budget (#2221)", () => {
		const { json, status } = run({
			mb: 2000 + HELD + PAIR,
			sessions: [SELF, GROWN],
			pss: GROWN_PSS,
		});
		expect(json.budgetMb).toBe(2000);
		expect(json.drawNeedMb).toBe(289);
		// ceil(3 × 600 + 1.645 × 200 × √3 − 640) = 1730 fits; 3 more need 2418
		expect(json.slots).toBe(2);
		expect(json.nextNeedMb).toBe(2418);
		expect(json.admit).toBe(true);
		expect(status).toBe(0);
	});

	it("holds — exit 1 — where the headroom is under one slot and a session is running", () => {
		const { json, status } = run({ mb: 500, sessions: [SELF, "other"] });
		expect(json.slots).toBe(0);
		expect(json.admit).toBe(false);
		expect(status).toBe(1);
	});

	it("admits one whatever the headroom when no session but this one is running", () => {
		const { json, status } = run({ mb: 100, sessions: [SELF] });
		expect(json.slots).toBe(1);
		expect(json.reason).toMatch(/no session is running/);
		expect(status).toBe(0);
	});

	it("prices the host's sessions at its declared draw (#2139)", () => {
		const { json } = run({
			mb: 2000 + HELD,
			sessions: [SELF, "other@701"],
			pss: { "701": mbKb(1000) },
			hostConfig: { sessionMeanMb: 1000, sessionSigmaMb: 100 },
		});
		// ceil(2 × 1000 + 1.645 × 100 × √2 − 1000) = 1233 fits
		expect(json.slots).toBe(1);
		expect(json.reason).toMatch(
			/; the live sessions' draw and 1 more need 1233 MB at p95/,
		);
		expect(
			run({
				json: false,
				hostConfig: { sessionMeanMb: 1000, sessionSigmaMb: 100 },
			}).stdout,
		).toMatch(
			/^session draw +mean 1000 MB, σ 100 MB — this repo's declared sessionMeanMb and sessionSigmaMb/m,
		);
	});

	it("prints why a malformed declared draw went unread, rather than a silent default (#2139)", () => {
		const { stdout } = run({
			json: false,
			hostConfig: { sessionMeanMb: "1000", sessionSigmaMb: 100 },
		});
		expect(stdout).toMatch(
			/^session draw +mean \d+ MB, σ 100 MB — one working session's draw.*a declared figure went unread: "sessionMeanMb" is not a positive integer/m,
		);
	});

	it("subtracts this run's own session from the count", () => {
		const { json } = run({ mb: 4000, sessions: [SELF, "a", "b"] });
		expect(json.sessions).toBe(2);
	});
});

describe("the session floor (#2501)", () => {
	/* Two neighbours working beside this run, so 3 of a floor of 6 are
	 * working; p95 prices one more, and 4 means of 600 fit above the 794 + 300. */
	const three = {
		mb: 500 + 4 * 600 + HELD + PAIR,
		sessions: [SELF, "a", "b"],
		states: { a: "working", b: "working" },
		sessionFloor: "6",
	};

	it("lifts the slots to the floor's working sessions, this run's own counted", () => {
		const { json, status } = run(three);
		expect(json.byMemory).toBe(1);
		expect(json.sessionFloorWorking).toBe(3);
		expect(json.sessionFloorSlots).toBe(3);
		expect(json.slots).toBe(3);
		expect(json.reason).toMatch(
			/^FLOOR: 3 slot\(s\) toward the 6 working sessions ~\/\.claude\/session-floor keeps \(#2501\), 3 working,/,
		);
		expect(status).toBe(0);
	});

	it("counts only sessions the oracle reads as working toward the floor (#2505)", () => {
		const { json, status } = run({
			...three,
			sessions: [SELF, "a", "b", "c", "d", "e"],
			states: { a: "working", b: "idle", c: "blocked", d: "done" },
		});
		// a and this run work; idle, blocked, done and stateless e do not
		expect(json.sessions).toBe(5);
		expect(json.sessionFloorWorking).toBe(2);
		expect(json.sessionFloorSlots).toBe(4);
		expect(status).toBe(0);
	});

	it("names the floor where it lifts the guaranteed slot, no session running (#2505)", () => {
		/* σ 600 prices one session at 1587 MB p95, over the 1300 left, while
		 * two means of 600 still fit. */
		const { json, status } = run({
			mb: 1300 + HELD + PAIR,
			sessions: [SELF],
			hostConfig: { sessionMeanMb: 600, sessionSigmaMb: 600 },
			sessionFloor: "4",
		});
		expect(json.byMemory).toBe(0);
		expect(json.slots).toBe(2);
		expect(json.reason).toMatch(
			/^FLOOR: 2 slot\(s\) toward the 4 working sessions .*, under the \d+ MB the live sessions' draw and one more need/,
		);
		expect(json.reason).not.toMatch(/so one is admitted/);
		expect(status).toBe(0);
	});

	it("names the floor in the slot arithmetic and its own line (#2505)", () => {
		const { stdout, status } = run({ ...three, json: false });
		expect(stdout).toMatch(
			/^ {2}slot arithmetic .*, so 1 slot\(s\), raised to 3 by the session floor of 6 working sessions \(#2501\)$/m,
		);
		expect(stdout).toMatch(
			/^session floor {6}6 working sessions \(~\/\.claude\/session-floor, #2501\); 3 working, this run's own counted, so 3 floor slot\(s\)$/m,
		);
		expect(status).toBe(0);
	});

	it("grants a floor slot only where free memory holds one more session's mean", () => {
		const { json, status } = run({
			mb: 599 + HELD + PAIR,
			sessions: [SELF, "a"],
			states: { a: "working" },
			sessionFloor: "8",
		});
		expect(json.sessionFloorSlots).toBe(0);
		expect(json.slots).toBe(0);
		expect(status).toBe(1);
	});

	it("is capped by the CPU ceiling", () => {
		const { json, status } = run({
			...three,
			psLines: ["900 1000 claude bg-pty-host --session x0"],
			sessionCeiling: "3",
		});
		expect(json.sessionFloorSlots).toBe(3);
		expect(json.memorySlots).toBe(3);
		expect(json.slots).toBe(2);
		expect(status).toBe(0);
	});

	it("is held at 0 by an overload", () => {
		const { json, status } = run({ ...three, load: 6 * os.cpus().length });
		expect(json.sessionFloorSlots).toBe(3);
		expect(json.slots).toBe(0);
		expect(status).toBe(1);
	});

	it("prices against memory the lander's suite reserve is not taken from (#2416)", () => {
		const roomy = { ...three, mb: 6000 + HELD + PAIR };
		const without = run(roomy).json;
		const withLander = run({ ...roomy, landers: [WHOLE_LANDER] }).json;
		expect(withLander.landerMb).toBeGreaterThan(0);
		expect(withLander.budgetMb).toBeLessThan(without.budgetMb);
		expect(withLander.sessionFloorSlots).toBe(without.sessionFloorSlots);
		expect(withLander.sessionFloorSlots).toBe(3);
	});

	it("adds nothing once the floor's sessions are working, or where none is declared", () => {
		const working = {
			mb: 8000,
			sessions: [SELF, "a", "b", "c"],
			states: { a: "working", b: "working", c: "working" },
		};
		const met = run({ ...working, sessionFloor: "4" });
		expect(met.json.sessionFloorSlots).toBe(0);
		expect(met.status).toBe(0);
		const none = run({ ...working, mb: 500 });
		expect(none.json.sessionFloorSlots).toBe(0);
		expect(none.json.sessionFloorProblem).toBe(null);
		expect(none.stdout).not.toMatch(/session floor/);
		expect(none.status).toBe(1);
		const absent = run({ ...working, mb: 500, sessionFloor: null });
		expect(absent.json.sessionFloorProblem).toBe(null);
		expect(absent.status).toBe(1);
	});

	it.each([
		["eight", /WFC_SESSION_FLOOR holds "eight", not a non-negative integer/],
		["8.5", /WFC_SESSION_FLOOR holds "8\.5", not a non-negative integer/],
	])("reads a malformed floor %s as none, printing why (#2505)", (raw, why) => {
		const r = run({ ...three, sessionFloor: raw });
		expect(r.json.sessionFloorSlots).toBe(0);
		expect(r.json.slots).toBe(1);
		expect(r.json.sessionFloorProblem).toMatch(why);
		expect(r.status).toBe(0);
		const text = run({ ...three, sessionFloor: raw, json: false });
		expect(text.stdout).toMatch(
			new RegExp(
				`^session floor {6}none — the declared floor went unread: ${why.source}$`,
				"m",
			),
		);
		expect(text.status).toBe(0);
	});

	it("reads an unreadable floor file as none, printing why (#2505)", () => {
		fs.mkdirSync(path.join(dir, ".claude", "session-floor"), {
			recursive: true,
		});
		const r = run({ ...three, sessionFloor: null });
		expect(r.json.sessionFloorSlots).toBe(0);
		expect(r.json.sessionFloorProblem).toMatch(
			/\.claude\/session-floor: EISDIR/,
		);
		expect(r.status).toBe(0);
	});

	it("reads the floor from $HOME/.claude/session-floor where no override is set", () => {
		fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
		fs.writeFileSync(path.join(dir, ".claude", "session-floor"), "6\n");
		const r = run({ ...three, sessionFloor: null });
		expect(r.json.sessionFloorSlots).toBe(3);
		expect(r.status).toBe(0);
	});
});

describe("the swap hold on the session floor (#2690)", () => {
	/* One neighbour working, so 2 of a floor of 4; 900 MB above the 794 + 300
	 * holds one mean of 600 and no p95 slot, and 2100 MB is under 2200. */
	const short = {
		mb: 900 + HELD + PAIR,
		sessions: [SELF, "a"],
		states: { a: "working" },
		sessionFloor: "4",
	};

	it("grants no floor slot while swap is under 25% free and memory under 2200 MB", () => {
		const free = run(short);
		expect(free.json.sessionFloorSlots).toBe(1);
		expect(free.json.swapHold).toEqual({ held: false });
		const held = run({ ...short, swap: { totalMb: 2048, freeMb: 245 } });
		expect(held.json.byMemory).toBe(0);
		expect(held.json.sessionFloorSlots).toBe(0);
		expect(held.json.slots).toBe(0);
		expect(held.json.swapHold).toEqual({
			held: true,
			swapFreeMb: 245,
			swapTotalMb: 2048,
			availableMb: 2100,
		});
		expect(held.status).toBe(1);
	});

	it("names the hold on the session floor line, with the swap and available figures", () => {
		const { stdout, status } = run({
			...short,
			swap: { totalMb: 2048, freeMb: 245 },
			json: false,
		});
		expect(status).toBe(1);
		expect(stdout).toMatch(
			/^session floor {6}4 working sessions \(~\/\.claude\/session-floor, #2501\); 2 working, this run's own counted, so 0 floor slot\(s\), held while swap is 245 of 2048 MB free and 2100 MB available, under 25% and 2200 MB \(#2690\)$/m,
		);
	});

	it("holds its memory line equal to the shell-start warning's default floor", () => {
		const shell = fs.readFileSync(
			path.join(__dirname, "shell-start-warn.sh"),
			"utf8",
		);
		expect(shell).toContain(
			`\${WFC_HEADROOM_FLOOR_MB:-${SWAP_HOLD_AVAILABLE_MB}}`,
		);
	});

	it.each([
		[
			"swap a quarter free",
			{ mb: short.mb, swap: { totalMb: 2048, freeMb: 512 } },
		],
		["2200 MB available", { mb: 2200, swap: { totalMb: 2048, freeMb: 0 } }],
		["no swap", { mb: short.mb, swap: { totalMb: 0, freeMb: 0 } }],
	])("holds nothing at %s", (_, m) => {
		const { json } = run({ ...short, ...m });
		expect(json.swapHold).toEqual({ held: false });
		expect(json.sessionFloorSlots).toBe(1);
	});
});

describe("the lander's suite reserve (#2416)", () => {
	/* The lander's draw is the charge its marker carries (#3323). */
	const LanderDraw = WHOLE_LANDER.chargeMb;
	/* Sessions of 2000 MB beside one live at 640 MB PSS: two more need
	 * ceil(6000 + 1.645 × 200 × √3 − 640) = 5930 MB, one more 3825 MB. */
	const big = {
		mb: 6000 + HELD + PAIR,
		sessions: [SELF, GROWN],
		pss: GROWN_PSS,
		hostConfig: { sessionMeanMb: 2000, sessionSigmaMb: 200 },
	};

	it("admits one fewer session while a lander's marker is live", () => {
		const without = run(big).json;
		const withLander = run({ ...big, landers: [WHOLE_LANDER] }).json;
		expect(without.slots).toBe(2);
		expect(withLander.landerMb).toBe(LanderDraw);
		expect(withLander.budgetMb).toBe(6000 - LanderDraw);
		expect(withLander.slots).toBe(1);
		expect(withLander.reason).toMatch(
			new RegExp(`holding ${LanderDraw} MB for the lander's suite`),
		);
	});

	it("holds the charge the lander's marker carries (#3323)", () => {
		const named = { pid: process.pid, chargeMb: 600 };
		expect(run({ ...big, landers: [named] }).json.landerMb).toBe(600);
	});

	it("samples a tester run's tree peak as the PSS of its root and every process under it (#3323)", () => {
		const was = process.env.WFC_PROC;
		process.env.WFC_PROC = writeProcRoot(dir, {
			pss: { "50": 100, "51": 200, "52": 300, "60": 9000 },
			parents: { "51": "50", "52": "51", "60": "1" },
		});
		try {
			expect(readTreePssKb(50)).toBe(600);
		} finally {
			if (was === undefined) delete process.env.WFC_PROC;
			else process.env.WFC_PROC = was;
		}
	});

	it("credits the lander's suite its current PSS, so it counts once, and the lander itself none", () => {
		const pid = String(process.pid);
		const { json } = run({
			...big,
			landers: [WHOLE_LANDER],
			pss: { ...GROWN_PSS, [pid]: mbKb(200), "9001": mbKb(800) },
			parents: { "9001": pid },
		});
		expect(json.landerMb).toBe(LanderDraw - 800);
	});

	it("credits a lander a session started nothing, the session's PSS already crediting it", () => {
		const pid = String(process.pid);
		const { json } = run({
			...big,
			landers: [WHOLE_LANDER],
			pss: { ...GROWN_PSS, "9001": mbKb(800) },
			parents: { [pid]: "701", "9001": pid },
		});
		expect(json.landerMb).toBe(LanderDraw);
	});

	it("holds nothing for a dead lander's marker", () => {
		// Past 2^22, 64-bit Linux's pid_max ceiling, so no process holds it.
		expect(
			run({ ...big, landers: [{ ...WHOLE_LANDER, pid: 2 ** 22 + 1 }] }).json
				.landerMb,
		).toBe(0);
	});

	it("prints the reserve in the slot arithmetic", () => {
		const { stdout } = run({ ...big, landers: [WHOLE_LANDER], json: false });
		expect(stdout).toMatch(
			new RegExp(`− ${PAIR} pool − ${LanderDraw} lander − ${FLOOR} floor`),
		);
	});
});

describe("daemon + spare-pool reservation", () => {
	/*
	 * One idle pair is reserved off the top before the draw is fitted, priced
	 * at the idle pairs' PSS over their count (#2223), the daemon's own process
	 * (`daemon run`) left out (#2283). A pair is idle while its `bg-spare` sits
	 * in its claim socket's directory (#2502); a live session's own host,
	 * matched on `--session-id` rather than `/spare/`, is no pair at all.
	 *
	 * `ps` here is `pid=,rss=,args=`; a pid with no fixture in `pss` has no
	 * readable rollup, so the scan falls back to that process's RSS. With no
	 * live session, 4000 MB less the floor, margin and one 106 MB pair leaves a
	 * budget that fits 3 sessions (2370) and not 4 (3058).
	 */
	it("prices the reserved pair without the daemon process, shrinking the slot count (#2283)", () => {
		const { json } = run({
			mb: 4000,
			psLines: [
				"110 305000 claude bg-pty-host --bg-pty-host /tmp/x/spare/abc.pty.sock",
				"111 300000 claude bg-spare --bg-spare /tmp/x/spare/abc.claim.sock",
				"112 223000 claude daemon run --origin transient",
				"113 400000 /home/u/.local/share/claude/versions/2.1.241 --session-id abc123",
			],
			cwds: idleAt("111"),
		});
		expect(json.reservedMb).toBe(590); // floor(605000 / 1024), the daemon's 223000 left out
		expect(json.memory.pool.mb).toBe(808); // floor((605000 + 223000) / 1024), the daemon kept
		expect(json.slots).toBe(2); // a 2316 MB budget fits 2 at 1666, not 3 at 2370
	});

	it("does not reserve a live session's own host, only the idle spare pool", () => {
		const { json } = run({
			mb: 4000,
			psLines: [
				"113 400000 /home/u/.local/share/claude/versions/2.1.241 --session-id abc123",
			],
		});
		expect(json.reservedMb).toBe(PAIR);
		expect(json.slots).toBe(3);
	});

	/*
	 * The pool's processes are near-identical forks, so RSS counts their
	 * shared pages once per process. PSS divides each shared page by its sharer
	 * count and is what the reserve must use (mantahostels#1287).
	 */
	it("prices a process by its PSS, not its far larger RSS", () => {
		const { json } = run({
			mb: 4000,
			psLines: [
				"111 700000 claude bg-spare --bg-spare /tmp/x/spare/abc.claim.sock",
				"112 700000 claude bg-spare --bg-spare /tmp/x/spare/def.claim.sock",
			],
			pss: { "111": 200_000, "112": 200_000 },
			cwds: idleAt("111", "112"),
		});
		expect(json.reservedMb).toBe(195); // floor(400000 / 1024) over 2 pairs, not 683
	});

	it("falls back to RSS for a process whose rollup cannot be read", () => {
		const { json } = run({
			mb: 4000,
			psLines: [
				"111 700000 claude bg-spare --bg-spare /tmp/x/spare/abc.claim.sock",
				"112 700000 claude bg-spare --bg-spare /tmp/x/spare/def.claim.sock",
			],
			pss: { "111": 200_000 }, // 112 has no rollup
			cwds: idleAt("111", "112"),
		});
		expect(json.reservedMb).toBe(439); // floor((200000 + 700000) / 1024) over 2 pairs
	});

	/*
	 * #2223: the pool is resident, so free memory already excludes it;
	 * reserving all of it charged it twice. One pair is what admission cannot
	 * yet see, and the breakdown still shows the whole pool.
	 */
	it("reserves one idle pair, not the whole pool, which the breakdown still shows", () => {
		const { json } = run({
			mb: 4000,
			psLines: [
				"111 300000 claude bg-spare --bg-spare /tmp/x/spare/abc.claim.sock",
				"112 300000 claude bg-spare --bg-spare /tmp/x/spare/def.claim.sock",
				"113 300000 claude bg-spare --bg-spare /tmp/x/spare/ghi.claim.sock",
			],
			cwds: idleAt("111", "112", "113"),
		});
		expect(json.reservedMb).toBe(292); // floor(900000 / 1024) over 3 pairs
		expect(json.memory.pool.mb).toBe(878);
		expect(json.slots).toBe(3); // a 2614 MB budget fits 3 at 2370
	});

	/*
	 * `docs/environment.md`: "Match `argv[0]` here too" (mantahostels#1287).
	 */
	it("ignores a non-claude process whose command line merely names /spare/ or `daemon run`", () => {
		const { json } = run({
			mb: 4000,
			psLines: [
				"111 900000 awk {print} /tmp/x/spare/abc.claim.sock",
				"112 900000 /bin/bash -c grep /spare/ somewhere",
				"113 900000 /bin/bash -c claude daemon run",
			],
			cwds: idleAt("111", "112"),
		});
		expect(json.reservedMb).toBe(PAIR);
		expect(json.memory.pool.mb).toBe(0);
		expect(json.slots).toBe(3);
	});

	/*
	 * A CLAIMED spare is a session and keeps its `/spare/` path, so the pool
	 * scan must not charge it as idle pre-warm — memory the session draw
	 * already prices. Its `bg-spare` has left the claim socket's directory for
	 * the job's cwd, whichever config dir it runs in and whether or not this
	 * run's listing names it (#2502). `abc` is claimed, `def` idle.
	 */
	const claimedAndIdle = [
		"111 300000 claude bg-spare --bg-spare /tmp/x/spare/abc.claim.sock",
		"110 100000 claude bg-pty-host --bg-pty-host /tmp/x/spare/abc.pty.sock 200 50 --",
		"333 300000 claude bg-spare --bg-spare /tmp/x/spare/def.claim.sock",
		"332 100000 claude bg-pty-host --bg-pty-host /tmp/x/spare/def.pty.sock 200 50 --",
	];
	it.each([
		["listed", [`${SELF}@111`, "other@222"]],
		["unlisted", [SELF]],
	])("prices only the idle pair, a %s claimed pair left out", (_, sessions) => {
		const { json } = run({
			mb: 4000,
			sessions,
			psLines: claimedAndIdle,
			cwds: { "111": "/home/u/repo", ...idleAt("333") },
		});
		// Only the idle `def` pair: floor((300000 + 100000) / 1024).
		expect(json.reservedMb).toBe(390);
		expect(json.memory.pool.mb).toBe(390);
	});

	it("puts a claimed listed pair in working, not the pool", () => {
		const { json } = run({
			mb: 4000,
			sessions: [SELF, "other@111"],
			states: { other: "working" },
			psLines: claimedAndIdle,
			pss: { "111": 102_400, "110": 51_200, "333": 102_400, "332": 51_200 },
			cwds: { "111": "/home/u/repo", ...idleAt("333") },
		});
		expect(json.memory.working).toMatchObject({ count: 2, mb: 150 });
		expect(json.memory.pool.mb).toBe(150);
	});

	it("counts a pair whose spare's cwd will not read as claimed", () => {
		const { json } = run({
			mb: 4000,
			psLines: claimedAndIdle,
			cwds: idleAt("333"),
		});
		expect(json.memory.pool.mb).toBe(390);
	});

	it("averages the reserved pair over the idle pairs alone", () => {
		const { json } = run({
			mb: 4000,
			psLines: [
				...claimedAndIdle,
				"444 300000 claude bg-spare --bg-spare /tmp/x/spare/ghi.claim.sock",
				"443 100000 claude bg-pty-host --bg-pty-host /tmp/x/spare/ghi.pty.sock 200 50 --",
			],
			pss: { "111": 900_000, "333": 200_000, "444": 100_000 },
			cwds: { "111": "/home/u/repo", ...idleAt("333", "444") },
		});
		// floor((200000 + 100000 + 100000 + 100000) / 1024) over 2 idle pairs
		expect(json.reservedMb).toBe(244);
	});

	it("fails open to no reservation where the overhead scan cannot run", () => {
		// A broken `ps` degrades only the process-count DISPLAY figure (procs.ok
		// stays true), so this isolates the reservation failure from the
		// memory/session fail-closed gate.
		const { json, status } = run({
			mb: 4000,
			psFails: true,
		});
		expect(status).toBe(0);
		expect(json.reservedMb).toBe(0);
		expect(json.slots).toBe(3);
	});
});

/*
 * #3322: a claimed pair no listing names is a session admission cannot see,
 * most often another config dir's. It gets its own row, labelled by that
 * dir, and leaves everything else, so the rows still sum once.
 */
describe("the unlisted row (#3322)", () => {
	/* `abc` claimed, by pid 111 at /home/u/repo; `def` idle. */
	const pairs = [
		"111 300000 claude bg-spare --bg-spare /tmp/x/spare/abc.claim.sock",
		"110 100000 claude bg-pty-host --bg-pty-host /tmp/x/spare/abc.pty.sock 200 50 --",
		"120 50000 node vitest",
		"333 300000 claude bg-spare --bg-spare /tmp/x/spare/def.claim.sock",
		"332 100000 claude bg-pty-host --bg-pty-host /tmp/x/spare/def.pty.sock 200 50 --",
	];
	const unlisted = (environs: Record<string, string[]> = {}, m: Machine = {}) =>
		run({
			mb: 4000,
			sessions: [SELF],
			psLines: pairs,
			pss: {
				"111": mbKb(300),
				"110": mbKb(100),
				"120": mbKb(50),
				"333": mbKb(10),
				"332": mbKb(10),
			},
			parents: { "120": "111" },
			cwds: { "111": "/home/u/repo", ...idleAt("333") },
			environs,
			...m,
		});

	it.each([
		[
			"CLAUDE_CONFIG_DIR, $HOME shown as ~",
			{ "111": ["PATH=/bin", `CLAUDE_CONFIG_DIR=${os.homedir()}/.claude-b`] },
			"~/.claude-b",
		],
		[
			"~/.claude where CLAUDE_CONFIG_DIR is absent",
			{ "111": ["PATH=/bin"] },
			"~/.claude",
		],
		[
			". where CLAUDE_CONFIG_DIR is set empty (#3500)",
			{ "111": ["PATH=/bin", "CLAUDE_CONFIG_DIR="] },
			".",
		],
		["the socket dir's hash id where environ will not read", {}, "x"],
	])(
		"sums a claimed unlisted pair and its tree, labelled %s",
		(_, environs, label) => {
			const { json } = unlisted(environs);
			expect(json.memory.unlisted).toEqual({
				count: 1,
				mb: 450,
				unknown: null,
				dirs: [{ dir: label, count: 1 }],
			});
			expect(json.memory.pool.mb).toBe(20);
		},
	);

	it("labels a pair naming no claim socket by its socket id where environ will not read", () => {
		const { json } = unlisted(
			{},
			{
				psLines: [
					"111 300000 claude bg-spare /tmp/x/spare/abc.claim.sock",
					"110 100000 claude bg-pty-host --bg-pty-host /tmp/x/spare/abc.pty.sock 200 50 --",
				],
			},
		);
		expect(json.memory.unlisted.dirs).toEqual([{ dir: "abc", count: 1 }]);
	});

	it("takes the unlisted pids out of everything else, so the rows sum once", () => {
		const { json } = unlisted();
		const m = json.memory;
		expect(
			m.free.mb +
				m.working.mb +
				m.finished.mb +
				m.pool.mb +
				m.unlisted.mb +
				m.other.mb,
		).toBe(m.totalMb);
		expect(m.other.largest.map((p: { pid: string }) => p.pid)).not.toContain(
			"111",
		);
		expect(m.other.largest.map((p: { pid: string }) => p.pid)).not.toContain(
			"120",
		);
	});

	it("prints the row with its config dirs", () => {
		const { stdout } = unlisted({ "111": ["PATH=/bin"] }, { json: false });
		expect(stdout).toContain(
			"  unlisted         1 session(s), 450 MB PSS — ~/.claude 1",
		);
	});

	it("reads none where the listing names the claimed pair", () => {
		const { json } = unlisted({}, { sessions: [SELF, "other@111"] });
		expect(json.memory.unlisted).toEqual({
			count: 0,
			mb: 0,
			unknown: null,
			dirs: [],
		});
		expect(json.memory.working.mb).toBe(450);
	});

	it("reads unknown where the listing was refused, as working does", () => {
		const { json } = unlisted({}, { agentsRaw: "not json" });
		expect(json.memory.unlisted.unknown).toMatch(/^session listing: /);
		expect(json.memory.unlisted.mb).toBeNull();
		expect(json.memory.other.mb).toBeNull();
	});
});

/*
 * #2502: the spare shape is vendor internals, so the breakdown names a break
 * in it under the pool row, the verdict unmoved.
 */
describe("spare shape drift (#2502)", () => {
	const sock = (id: string, made: boolean) => {
		const d = path.join(dir, "daemon", "spare");
		fs.mkdirSync(d, { recursive: true });
		const p = path.join(d, `${id}.claim.sock`);
		if (made) fs.writeFileSync(p, "");
		return p;
	};
	const pair = (pid: number, id: string, made = true) => [
		`${pid} 100000 claude bg-spare --bg-spare ${sock(id, made)}`,
		`${pid + 1} 100000 claude bg-pty-host --bg-pty-host ${path.dirname(sock(id, made))}/${id}.pty.sock`,
	];
	const spareDir = () => path.join(dir, "daemon", "spare");
	const driftLines = (stdout: string) =>
		stdout.split("\n").filter((l) => l.includes("spare shape drift"));

	it("names a daemon holding more than one idle pair", () => {
		const r = run({
			json: false,
			psLines: [...pair(110, "aaa"), ...pair(120, "bbb")],
			cwds: { "110": spareDir(), "120": spareDir() },
		});
		expect(driftLines(r.stdout)).toEqual([
			`    spare shape drift: ${spareDir()} holds 2 idle pairs, where its daemon keeps one`,
		]);
	});

	it("names a claimed pair that keeps its claim socket", () => {
		const r = run({
			json: false,
			psLines: pair(110, "aaa"),
			cwds: { "110": "/home/u/repo" },
		});
		expect(driftLines(r.stdout)).toEqual([
			`    spare shape drift: pair aaa reads claimed but keeps ${spareDir()}/aaa.claim.sock`,
		]);
	});

	it("reads a booting spare, its socket not yet made, as idle and no drift", () => {
		const r = run({
			mb: 4000,
			psLines: [...pair(110, "aaa"), ...pair(120, "bbb", false)],
			pss: { "110": 51_200, "111": 51_200, "120": 51_200, "121": 51_200 },
			cwds: { "110": spareDir(), "120": spareDir() },
		});
		expect(r.json.memory.pool).toEqual({ mb: 200, unknown: null, drift: [] });
		expect(r.json.reservedMb).toBe(100);
	});
});

/*
 * #2221: admission fits the live sessions' aggregate draw at p95, each at its
 * own repo's mean and σ, less what they already hold, and keeps earlyoom's
 * 794 MB kill line and a 300 MB margin free on top.
 */
describe("aggregate session draw (#2221)", () => {
	/** A repo under `dir` whose config holds `config`. */
	const repo = (name: string, config: Record<string, unknown> = {}) => {
		const root = path.join(dir, name);
		fs.mkdirSync(path.join(root, ".git"), { recursive: true });
		fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(root, ".claude", "workflow-core.json"),
			JSON.stringify(config),
		);
		return root;
	};

	/**
	 * The text report's live-draw line, with these sessions listed at these
	 * cwds and states. `self` is this run's session id, listed idle unless it
	 * is listed; an empty one leaves the id unset and lists nothing more.
	 */
	const readDrawLine = (listed: [string, string, string?][], self = SELF) => {
		const agents: Record<string, string>[] = listed.map(
			([sessionId, cwd, state = "working"]) => ({ sessionId, state, cwd }),
		);
		if (self && !listed.some(([id]) => id === self))
			agents.push({ sessionId: self, state: "idle", cwd: "" });
		const { stdout } = run({
			json: false,
			self,
			agentsRaw: JSON.stringify(agents),
		});
		return /^live draw +(.*)$/m.exec(stdout)?.[1];
	};

	it("charges each live session its own repo's draw, a subdirectory cwd reading its repo's", () => {
		const heavy = repo("heavy", { sessionMeanMb: 1000, sessionSigmaMb: 300 });
		const light = repo("light", { sessionMeanMb: 400, sessionSigmaMb: 100 });
		fs.mkdirSync(path.join(heavy, "src"));
		expect(
			readDrawLine([
				["a", path.join(heavy, "src")],
				["b", light],
				["c", heavy],
			]),
		).toBe(
			// σ is √(300² + 100² + 300²); no session lists a pid
			"3 live session(s): mean 2400 MB + 1.645 × σ 436 MB − 0 MB they already hold; 3 with no process, charged in full",
		);
	});

	it("counts idle and waiting sessions, and leaves out ended ones and this run's own", () => {
		const light = repo("light", { sessionMeanMb: 400, sessionSigmaMb: 100 });
		expect(
			readDrawLine([
				[SELF, light],
				["a", light, "idle"],
				["b", light, "waiting"],
			]),
		).toMatch(/^2 live session\(s\): mean 800 MB/);
		const { stdout } = run({
			json: false,
			agentsRaw: JSON.stringify([
				{ sessionId: SELF, pid: 200 },
				{ sessionId: "c", pid: 203, kind: "background", state: "done" },
				{ sessionId: "d", pid: 204, kind: "background", state: "failed" },
			]),
		});
		expect(stdout).toMatch(/^live draw +0 live session\(s\): mean 0 MB/m);
	});

	it("charges a lone listed session where no session id names it as this one", () => {
		expect(readDrawLine([["only", repo("light")]], "")).toMatch(
			/^1 live session\(s\)/,
		);
	});

	it("charges the default and says so for a cwd in no repo", () => {
		const loose = path.join(dir, "loose");
		fs.mkdirSync(loose);
		expect(readDrawLine([["a", loose]])).toMatch(
			new RegExp(
				`; charged the default draw where a repo's went unread: ${loose} is in no repo$`,
			),
		);
	});

	it("charges the default and says so for a session with no cwd", () => {
		expect(readDrawLine([["a", ""]])).toMatch(
			/; charged the default draw where a repo's went unread: session a lists no cwd$/,
		);
	});

	it("charges the default and says why where a repo's declared draw will not read", () => {
		expect(
			readDrawLine([["a", repo("bad", { sessionMeanMb: "900" })]]),
		).toMatch(
			/charged the default draw where a repo's went unread: .*"sessionMeanMb" is not a positive integer/,
		);
	});

	it("charges a session whose memory cannot be read its whole draw", () => {
		const machine = {
			mb: 6000,
			sessions: [SELF, "a@201", "b@202"],
			pss: {}, // neither 201 nor 202 has a rollup
		};
		// ceil(2 × 600 + 1.645 × 200 × √2), nothing credited as held
		expect(run(machine).json.drawNeedMb).toBe(1666);
		expect(run({ ...machine, json: false }).stdout).toMatch(
			/^live draw +2 live session\(s\): .*; 2 charged in full, memory unread$/m,
		);
	});

	it("charges a listed session with no pid its whole draw, and reads the working row without it (#2426)", () => {
		const { json, status } = run({
			mb: 6000,
			sessions: [SELF, "a", "b@202"],
			pss: { "202": mbKb(250) },
		});
		expect(status).toBe(0);
		// ceil(2 × 600 + 1.645 × 200 × √2 − 250): a, parked and retired by
		// the daemon, is charged as one that will resume
		expect(json.drawNeedMb).toBe(1416);
		expect(json.memory.working).toMatchObject({
			mb: 250,
			noProcess: 2, // a, and this run's own session, listed here with no pid
			unknown: null,
		});
		const { stdout } = run({
			mb: 6000,
			sessions: [SELF, "a", "b@202"],
			pss: { "202": mbKb(250) },
			json: false,
		});
		expect(stdout).toMatch(
			/^live draw +2 live session\(s\): .* − 250 MB they already hold; 1 with no process, charged in full$/m,
		);
		expect(stdout).toMatch(
			/^ {2}working +3 session\(s\) \(2 with no process\), 250 MB PSS$/m,
		);
	});

	it("credits a session's pair and every process it starts, but not a listed session among them", () => {
		const { json } = run({
			mb: 6000,
			sessions: [SELF, "a@201", "b@401"],
			psLines: [
				"201 400000 claude --bg-spare /tmp/x/spare/abc.claim.sock",
				"202 100000 claude bg-pty-host --bg-pty-host /tmp/x/spare/abc.pty.sock",
			],
			pss: {
				"201": mbKb(300),
				"202": mbKb(100),
				"301": mbKb(500),
				"302": mbKb(50),
				"401": mbKb(640),
			},
			// 301 and its child 302 are a's suite; 401 is b, nested under a
			parents: { "301": "201", "302": "301", "401": "201" },
		});
		// a holds 300 + 100 + 500 + 50, b 640: ceil(1200 + 465.3 − 1590), a's
		// running suite credited back here
		expect(json.drawNeedMb).toBe(76);
	});

	it("holds the floor and margin off the budget, and names both", () => {
		const { json } = run({ mb: 6000, sessions: [SELF, GROWN], pss: GROWN_PSS });
		expect(json.floorMb).toBe(FLOOR);
		expect(json.marginMb).toBe(300);
		expect(json.budgetMb).toBe(6000 - HELD - PAIR);
		expect(json.reason).toMatch(
			/holding 794 \+ 300 MB above earlyoom's kill line/,
		);
	});

	it("still admits one with no other session running, whatever the floor takes", () => {
		const { json } = run({ mb: 700, sessions: [SELF] });
		expect(json.slots).toBe(1);
	});

	it("gives the lenient verdict pick-next sizes a burst with the same answer", () => {
		const mem = { ok: true as const, mb: 4962 };
		const procs = { ok: true as const, sessions: 10, working: 0 };
		const a = admissionFrom(mem, procs, {
			live: {
				sessions: 10,
				meanMb: 6000,
				varianceMb2: 10 * 200 ** 2,
				pssMb: 3230,
				unread: 0,
				noProcess: 0,
				problems: [],
			},
			host: { meanMb: 600, sigmaMb: 200, declared: true },
		});
		expect(a.drawNeedMb).toBe(3811);
		expect(a.freeSlots).toBe(0);
		expect(a.reason).toMatch(
			/under the 4462 MB the live sessions' draw and one more need at p95/,
		);
	});

	it("holds a burst's second launch that the first has not grown into (19 Oct 2026)", () => {
		const young = Array.from({ length: 10 }, (_, i) => ({
			sessionId: `s${i}`,
			pid: 300 + i,
			state: "working",
			cwd: path.join(dir, "host"),
		}));
		const { json } = run({
			mb: 4962,
			agentsRaw: JSON.stringify([{ sessionId: SELF }, ...young]),
			pss: Object.fromEntries(young.map((s) => [`${s.pid}`, mbKb(323)])),
		});
		// ceil(6000 + 1.645 × 200 × √10 − 3230) = 3811 fits 3868; one more
		// needs 4462
		expect(json.drawNeedMb).toBe(3811);
		expect(json.slots).toBe(0);
	});
});

describe("reclaimable pool (mantahostels#1288)", () => {
	/*
	 * `reclaimableMb` credits exactly what the reaper's own `--dry-run --json`
	 * plan says it would reap, never re-deriving the gates itself.
	 */
	it("credits the reaper's reaped PSS into the slot count, and names it in the reason", () => {
		const { json } = run({
			mb: 2000 + HELD + PAIR, // 2 slots uncredited
			reaped: [{ pss: 273 }, { pss: 236 }, { pss: 255 }, { pss: 313 }], // 1077 MB
		});
		expect(json.reclaimedMb).toBe(1077);
		expect(json.slots).toBe(4); // a 3077 MB budget fits 4 at 3058
		expect(json.reason).toMatch(/credited 1077 MB about to be reclaimed/);
	});

	it("names the credit in the guaranteed-slot reason too, when no session is running", () => {
		const { json } = run({
			mb: 100,
			sessions: [SELF],
			reaped: [{ pss: 300 }],
		});
		expect(json.reclaimedMb).toBe(300);
		expect(json.reason).toMatch(/credited 300 MB about to be reclaimed/);
		expect(json.reason).toMatch(/no session is running/);
	});

	it("never credits a suite gate above the one-suite rung", () => {
		const { json } = run({
			mb: rung(2) - 1, // just under the two-suite rung
			reaped: [{ pss: 500 }],
		});
		expect(json.reclaimedMb).toBe(500);
		/* Not 2: admission cannot know how many suites a launched session will
		 * find running, so it cannot know which rung that session's pretest
		 * reap will judge against (mantahostels#1930, #631). */
		expect(json.suites).toBe(1);
	});

	it("credits the reclaim below the one-suite rung, where a first suite's pretest reap really fires", () => {
		const { json } = run({
			mb: rung(1) - 300 + PAIR, // under the one-suite rung, so pretest-reap runs
			reaped: [{ pss: 300 }],
		});
		expect(json.reclaimedMb).toBe(300);
		expect(json.suites).toBe(1); // mb − the pair + reclaimed lands exactly on the rung
	});

	it("still admits no suite where the reclaim cannot close the gap", () => {
		const { json } = run({ mb: rung(1) - 1100, reaped: [{ pss: 100 }] });
		expect(json.suites).toBe(0); // mb + reclaimed stays 1,000 MB under the rung
	});

	/* The reap gates on the RAW MemAvailable figure; the reservation is
	 * admission's own bookkeeping and no memory the reaper can see (mantahostels#1930).
	 * rung(1) + 100 MB raw is at or above the one-suite rung, so a
	 * first suite's pretest-reap.js returns without reaping, whatever the reserved figure
	 * makes of it. This is the ONLY case covering `suiteCapacity`'s `rawMb >=
	 * SUITE_RESTING_MB[1]` line, so its raw figure is derived off the rung
	 * (mantahostels#2673). The 390 MB reservation below comes
	 * from the fixed `pss: 400000` fixture, not from the rung, and must stay
	 * short of the +100 margin or the case stops covering that line. */
	it("refuses the credit where only the reservation puts the machine under the rung", () => {
		const { json } = run({
			mb: rung(1) + 100,
			psLines: [
				"111 400000 claude bg-spare --bg-spare /tmp/x/spare/abc.claim.sock",
			],
			pss: { "111": 400_000 },
			cwds: idleAt("111"),
			reaped: [{ pss: 400 }],
		});
		expect(json.reservedMb).toBe(390); // effective rung(1) - 290, under the rung
		expect(json.reclaimedMb).toBe(400);
		expect(json.suites).toBe(0); // a first suite's reap never fires at rung(1) + 100 MB raw
	});

	it("never lets the credit buy a SECOND suite from under the rung", () => {
		const mb = rung(1) - 700; // under the one-suite rung
		const reaped = rung(2) - mb + 100; // mb + reaped clears the two-suite rung
		const { json } = run({ mb, reaped: [{ pss: reaped }] });
		/* mb + reaped clears the two-suite rung arithmetically, but the reap
		 * never refuses — it prints and continues on a pool that stays short —
		 * so the credit answers "may this run at all" only (mantahostels#1930). */
		expect(json.suites).toBe(1);
	});

	it("fails closed to 0 where the reap plan cannot be spawned", () => {
		const { json, status } = run({
			mb: 2000 + HELD,
			reapFails: true,
		});
		expect(status).toBe(0);
		expect(json.reclaimedMb).toBe(0);
		expect(json.slots).toBe(2);
	});

	it("buys no suite from an unreadable reap plan, at a figure the credit could reach", () => {
		const { json } = run({ mb: rung(1) - 800, reapFails: true });
		expect(json.reclaimedMb).toBe(0);
		expect(json.suites).toBe(0); // mb alone is under the one-suite rung
	});

	it("fails closed to 0 where the reap plan carries no reaped list", () => {
		const { json } = run({
			mb: 2000 + HELD,
			reapRaw: JSON.stringify({ kept: [] }),
		});
		expect(json.reclaimedMb).toBe(0);
		expect(json.slots).toBe(2);
	});

	it("fails closed to 0 where the reap plan's own JSON will not parse", () => {
		const { json } = run({
			mb: 2000 + HELD,
			reapRaw: "not json",
		});
		expect(json.reclaimedMb).toBe(0);
		expect(json.slots).toBe(2);
	});

	it("credits an entry with an unreadable pss as 0 rather than guessing", () => {
		const { json } = run({
			mb: 2000,
			reaped: [{ pss: 300 }, { pss: null }],
		});
		expect(json.reclaimedMb).toBe(300);
	});

	it("surfaces a broken reap plan as an error, never as silent zero", () => {
		const { json } = run({ mb: 2000, reapFails: true });
		expect(json.reclaimedMb).toBe(0);
		expect(json.reclaimableError).toBeTruthy();
	});

	it("carries no reclaimableError once the plan reads clean", () => {
		const { json } = run({ mb: 2000, reaped: [{ pss: 100 }] });
		expect(json.reclaimableError).toBeNull();
	});
});

describe("session counting reads argv[0], never comm", () => {
	/*
	 * A BACKGROUNDED session re-execs a versioned binary whose `comm` is the
	 * version string, so a `comm` matcher finds no session at all
	 * (mantahostels#481).
	 */
	it("counts a backgrounded session whose comm is a version number", () => {
		const { json } = run({
			psLines: [
				// `comm` here is `2.0.14`; only argv[0] says this is claude.
				"2.0.14 /home/u/.local/share/claude/versions/2.0.14 --continue",
				"node /usr/bin/node other.js",
			],
		});
		expect(json.processes).toBe(1);
	});

	it("counts the launcher-path and bare-name shapes too, and nothing else", () => {
		const { json } = run({
			psLines: [
				"claude claude",
				"claude /home/u/.local/bin/claude --print",
				"2.0.14 /home/u/.local/share/claude/versions/2.0.14",
				"node /usr/bin/node scripts/pick-next.js",
				"bash /bin/bash",
			],
		});
		expect(json.processes).toBe(3);
	});
});

describe("test-suite bands", () => {
	/* `mb` is what is left after the one pair a pool-less reading reserves. */
	const suites = (mb: number) => run({ mb: mb + PAIR }).json.suites;

	/* All three rungs measured at #1603. Four is unmeasured, so no amount of
	 * memory buys more than the ladder's top rung, and mantahostels#462's
	 * 3,000 MB four-suite allowance buys one. */
	it("never allows four, which nothing has measured on this suite", () => {
		expect(suites(3000)).toBe(1);
		expect(suites(100_000)).toBe(3);
	});

	it("walks the 2.15 / 3.25 / 3.65 GB resting bands", () => {
		expect(suites(3650)).toBe(3);
		expect(suites(3649)).toBe(2);
		expect(suites(3250)).toBe(2);
		expect(suites(3249)).toBe(1);
		expect(suites(2150)).toBe(1);
		expect(suites(2149)).toBe(0);
	});
});

/** readRunningVitestSuites against a stub `ps` at `p`, the seam pretest-reap reads it through. */
const readSuitesWithPs = (p: string) => {
	const was = process.env.WFC_PS;
	process.env.WFC_PS = p;
	try {
		return readRunningVitestSuites();
	} finally {
		if (was === undefined) delete process.env.WFC_PS;
		else process.env.WFC_PS = was;
	}
};

/*
 * lib/suite-ladder.js's `runningSuites`, which guard-suite-concurrency.js
 * counts by too.
 */
describe("the running vitest suite count", () => {
	const read = (lines: string[]) => {
		const r = readSuitesWithPs(ps(lines));
		if (!r.ok) throw new Error(r.error);
		return r;
	};
	const wholeRuns = (lines: string[]) => read(lines).whole;

	it("counts one whole run per runner line, never the npm wrapper or a worker", () => {
		const listing = [
			"sh -c NODE_OPTIONS=--max-old-space-size=2048 vitest run",
			"node /repo/node_modules/.bin/vitest run",
			"node /repo/node_modules/vitest/dist/workers/forks.js",
			"node /repo/node_modules/vitest/dist/workers/forks.js",
		];
		expect(wholeRuns(listing)).toBe(1);
	});

	it("counts a watcher, which holds a rung, beside a one-shot", () => {
		const listing = [
			"node /a/node_modules/.bin/vitest",
			"node /b/node_modules/.bin/vitest --watch",
			"node /c/node_modules/.bin/vitest --silent --run",
		];
		expect(wholeRuns(listing)).toBe(3);
	});

	it("leaves non-vitest runners and look-alike binaries uncounted", () => {
		const listing = [
			"node --test scripts/foo.test.js",
			"python3 -m pytest scripts",
			"node /repo/node_modules/.bin/vitest-something run",
			"claude /usr/bin/claude",
		];
		expect(wholeRuns(listing)).toBe(0);
	});

	it("counts a wrapped direct launch once, skipping its shell and timeout lines (#1127)", () => {
		const command = "node_modules/.bin/vitest run scripts/a.test.ts";
		const listing = [
			`/bin/bash -c source /snap.sh && eval 'timeout 300 ${command}'`,
			`timeout 300 ${command}`,
			`node ${command}`,
			`-bash ${command}`,
			`/usr/bin/nohup ${command}`,
			`env FOO=1 ${command}`,
		];
		expect(read(listing)).toMatchObject({ workers: 1, whole: 0 });
	});

	it("leaves a `vitest list` selection probe uncounted (#1180)", () => {
		const listing = [
			"node /r/node_modules/.bin/vitest run",
			"node /r/node_modules/.bin/vitest run",
			"node /r/node_modules/.bin/vitest list --changed HEAD --filesOnly",
		];
		expect(wholeRuns(listing)).toBe(2);
	});

	it("still counts a run whose `-t` filter is the word list", () => {
		expect(wholeRuns(["node /r/node_modules/.bin/vitest run -t list"])).toBe(1);
	});
});

describe("readRunningVitestSuites", () => {
	it("counts the suites a real `ps` spawn lists", () => {
		const r = readSuitesWithPs(
			ps(["node /a/node_modules/.bin/vitest run", "ps -eo args="]),
		);
		expect(r).toEqual({ ok: true, workers: WHOLE_SUITE_WORKERS, whole: 1 });
	});

	it("reads an empty listing as unread, not as zero suites", () => {
		expect(readSuitesWithPs(ps([]))).toEqual({
			ok: false,
			error: "ps listed nothing",
		});
	});

	it("reads a failed `ps` as unread", () => {
		expect(readSuitesWithPs(ps([], { fails: true }))).toEqual({
			ok: false,
			error: "ps: cannot read /proc",
		});
	});

	/* A `--changed` or full run's runner line names no file, so only the
	 * weight its launch record carries can tell it from a whole suite. */
	describe("weighs a runner by the weight its launch record carries, not its argv (#2931)", () => {
		const procDirOf = (pid: number, launch: object | null) => {
			const procDir = path.join(dir, "procDir");
			carrying(procDir, pid, launch);
			return procDir;
		};
		const readWithProc = (procDir: string, lines: string[]) => {
			const was = process.env.WFC_PROC;
			process.env.WFC_PROC = procDir;
			try {
				return readSuitesWithPs(ps(lines));
			} finally {
				if (was === undefined) delete process.env.WFC_PROC;
				else process.env.WFC_PROC = was;
			}
		};
		const runner = "node /a/node_modules/.bin/vitest run";

		it("reads a run carrying a part-suite's weight as no whole suite", () => {
			const procDir = procDirOf(31, { resolvedFiles: 40, wholeSlot: false });
			expect(readWithProc(procDir, [`31 ${runner}`])).toEqual({
				ok: true,
				workers: WHOLE_SUITE_WORKERS,
				whole: 0,
			});
		});

		it("reads a run carrying a 2-file weight at 2 workers", () => {
			const procDir = procDirOf(32, { resolvedFiles: 2, wholeSlot: false });
			expect(readWithProc(procDir, [`32 ${runner}`])).toEqual({
				ok: true,
				workers: 2,
				whole: 0,
			});
		});

		it("reads a run carrying the whole slot as whole, whatever its argv names", () => {
			const procDir = procDirOf(33, { resolvedFiles: 200, wholeSlot: true });
			expect(readWithProc(procDir, [`33 ${runner} a.test.ts`])).toEqual({
				ok: true,
				workers: WHOLE_SUITE_WORKERS,
				whole: 1,
			});
		});

		it("falls back to the argv for a run carrying no record", () => {
			const procDir = procDirOf(34, null);
			expect(
				readWithProc(procDir, [`34 ${runner}`, `35 ${runner} a.test.ts`]),
			).toEqual({ ok: true, workers: WHOLE_SUITE_WORKERS + 1, whole: 1 });
		});
	});
});

describe("fails closed", () => {
	it("refuses — exit 2 — where MemAvailable cannot be read, and grants no slots", () => {
		const r = run({ mb: null });
		expect(r.status).toBe(2);
		expect(r.json.ok).toBe(false);
		expect(r.json.error).toMatch(/memory unreadable/);
		expect(r.json.slots).toBeUndefined();
	});

	it("refuses — exit 2 — where the session oracle will not answer", () => {
		const r = run({ sessions: null });
		expect(r.status).toBe(2);
		expect(r.json.error).toMatch(/session count unreadable/);
	});

	it("refuses an empty listing inside a session, where it must name at least this one", () => {
		const r = run({ sessions: [] });
		expect(r.status).toBe(2);
		expect(r.json.error).toMatch(/listed no agents at all/);
	});

	it("counts an empty listing outside a session as nothing live, so a session-less loop is not held at 0 slots (#2180)", () => {
		const r = run({ sessions: [], self: "" });
		expect(r.status).toBe(0);
		expect(r.json.ok).toBe(true);
		expect(r.json.sessions).toBe(0);
		expect(r.json.slots).toBe(r.json.byMemory);
		expect(r.json.slots).toBeGreaterThan(0);
	});

	it("never grants the no-session guarantee on an empty listing outside a session, only memory's slots (#2180)", () => {
		const r = run({ sessions: [], self: "", mb: 300 });
		expect(r.json.byMemory).toBe(0);
		expect(r.json.slots).toBe(0);
	});

	it("refuses at exit 2 rather than guessing when the oracle omits this session, reporting the session count unreadable", () => {
		const r = run({ sessions: ["someone-else", "another"] });
		expect(r.status).toBe(2);
		expect(r.json.error).toMatch(/session count unreadable/);
	});
});

/*
 * #830, reversing mantahostels#1979: a launch holds at load1 3 per core (#3223),
 * whatever memory is free.
 */
describe("the CPU limb (#830)", () => {
	const ceiling = 3 * os.cpus().length;

	it("holds at the load ceiling, naming the load, however much memory is free", () => {
		const r = run({ load: ceiling });
		expect(r.status).toBe(1);
		expect(r.json.admit).toBe(false);
		expect(r.json.reason).toMatch(/at or above the \d+ ceiling \(#830\)/);
	});

	it("admits just under it", () => {
		const r = run({ load: ceiling - 0.01 });
		expect(r.status).toBe(0);
		expect(r.json.admit).toBe(true);
	});

	it("fails open where the load cannot be read", () => {
		expect(run({ load: null }).status).toBe(0);
	});

	it("holds the guaranteed slot too, keeping the memory figure in byMemory", () => {
		const r = run({ load: ceiling, mb: 100, sessions: [SELF] });
		expect(r.status).toBe(1);
		expect(r.json.slots).toBe(0);
		expect(r.json.cpuIsSoleHold).toBe(true);
		expect(r.json.load).toMatchObject({ overloaded: true, load1: ceiling });
	});

	it("is not the only hold where memory holds as well", () => {
		const r = run({ load: ceiling, mb: 500, sessions: [SELF, "other"] });
		expect(r.status).toBe(1);
		expect(r.json.cpuIsSoleHold).toBe(false);
		expect(r.json.reason).toMatch(
			/\(#830\).*; were it not for the load, .*, under the \d+ MB the live sessions' draw and one more need/,
		);
	});

	const text = (m: Machine) =>
		run({
			sessions: [SELF, "other"],
			mb: 4000,
			...m,
			json: false,
		});

	/* dispatch-sessions.sh keys its remedy off this line (#834). */
	it("names the load on a `cpu load` line, saying when it is the only hold", () => {
		const sole = text({ load: ceiling });
		expect(sole.status).toBe(1);
		expect(sole.stdout).toMatch(
			/^cpu load\s+load1 \d+(\.\d+)? is at or above the \d+ ceiling \(#830\) — the only hold$/m,
		);
		const both = text({ load: ceiling, mb: 500 });
		expect(both.status).toBe(1);
		expect(both.stdout).toMatch(/^cpu load\s+.*\(#830\)$/m);
		expect(both.stdout).not.toMatch(/the only hold/);
		const calm = text({});
		expect(calm.status).toBe(0);
		expect(calm.stdout).not.toMatch(/^cpu load/m);
	});

	it("says the load is unknown rather than staying silent", () => {
		const r = text({ load: null });
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/^cpu load\s+unknown/m);
	});

	/* So dispatch names the load remedy beside the memory one. */
	it("names an overload on a memory refusal too", () => {
		const r = text({ load: ceiling, mb: null });
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/ADMISSION REFUSED/);
		expect(r.stderr).toMatch(/^cpu load\s+.*\(#830\)$/m);
	});

	/* What dispatch-sessions.sh --force-memory runs, so the override keeps the
	 * CPU limb armed (#834) — and reads nothing else, memory included. */
	it("judges the load alone under --load-only", () => {
		const held = text({ load: ceiling, mb: null, args: ["--load-only"] });
		expect(held.status).toBe(1);
		expect(held.stdout).toMatch(/^cpu load\s+.*— the only hold$/m);
		const calm = text({ mb: null, args: ["--load-only"] });
		expect(calm.status).toBe(0);
		expect(calm.stdout).toBe("");
		const unknown = text({ load: null, mb: null, args: ["--load-only"] });
		expect(unknown.status).toBe(0);
		expect(unknown.stdout).toMatch(/^cpu load\s+unknown/m);
	});
});

/* pick-next's lenient verdict carries the same limb (#834). */
describe("admissionFrom's CPU limb (#834)", () => {
	const mem = { ok: true as const, mb: 4000 + FLOOR };
	const procs = { ok: true as const, sessions: 1, working: 0 };
	const over = { overloaded: true, load1: 60, ceiling: 48 };
	const host = { meanMb: 600, sigmaMb: 200, declared: true };

	it("holds every slot over the ceiling", () => {
		const a = admissionFrom(mem, procs, { host, load: over });
		expect(a.freeSlots).toBe(0);
		expect(a.admit).toBe(false);
		expect(a.reason).toMatch(/load1 60 is at or above the 48 ceiling/);
	});

	it("overrides the always-admit-one guarantee", () => {
		const a = admissionFrom(
			mem,
			{ ok: true, sessions: 0, working: 0 },
			{ host, load: over },
		);
		expect(a.admit).toBe(false);
	});

	it("leaves an unread memory figure unknown rather than zero", () => {
		const a = admissionFrom({ ok: false, error: "x" }, procs, {
			host,
			load: over,
		});
		expect(a.freeSlots).toBeNull();
		expect(a.admit).toBe(false);
	});

	it("caps the slots at the session ceiling, the guarantee included (#2141)", () => {
		const cpu = {
			ceiling: 3,
			sessions: 2,
			idleSpares: 0,
			slots: 1,
			full: false,
			unknown: null,
		};
		const a = admissionFrom(mem, procs, { host, cpu });
		expect(a.freeSlots).toBe(1);
		expect(a.reason).toMatch(/; capped by the CPU: 2 session\(s\) running/);
		const full = { ...cpu, sessions: 3, slots: 0, full: true };
		const held = admissionFrom(
			mem,
			{ ok: true, sessions: 0, working: 0 },
			{ host, cpu: full },
		);
		expect(held.freeSlots).toBe(0);
		expect(held.admit).toBe(false);
		expect(held.reason).toMatch(/3-session CPU ceiling \(#2141\)/);
	});

	it("is unchanged where the load is not read", () => {
		// a 3700 MB budget fits 4 at 3058, not 5 at 3736
		expect(admissionFrom(mem, procs, { host }).freeSlots).toBe(4);
	});
});

/* pick-next's lenient verdict charges the per-slot pair as the strict one does (#2568). */
describe("admissionFrom's per-slot pending pair (#2568)", () => {
	const mem = { ok: true as const, mb: 4000 + FLOOR };
	const procs = { ok: true as const, sessions: 1, working: 0 };
	const host = { meanMb: 600, sigmaMb: 200, declared: true };

	it("charges each slot past the first its own pair", () => {
		// a 3700 MB budget: 4 at 3058 plus 3 pairs is 3808, 3 at 2370 plus 2 is 2870
		const a = admissionFrom(mem, procs, { host, launchMb: 250 });
		expect(a.freeSlots).toBe(3);
		expect(a.reason).toMatch(
			/^3 free slots on the live sessions' draw at p95 and 2 more spare pair\(s\) at 250 MB/,
		);
	});

	it("charges nothing without a launch price", () => {
		const a = admissionFrom(mem, procs, { host });
		expect(a.freeSlots).toBe(4);
		expect(a.reason).not.toMatch(/spare pair/);
	});
});

/* pick-next's lenient verdict applies the session floor as the strict one does (#2507). */
describe("admissionFrom's session floor (#2507)", () => {
	// a 1300 MB budget: 1 slot at p95 (929, not 1666), 2 at the 600 MB mean
	const mem = { ok: true as const, mb: 1300 + HELD };
	const procs = { ok: true as const, sessions: 3, working: 2, self: true };
	const host = { meanMb: 600, sigmaMb: 200, declared: true };

	it("lifts the free slots toward the floor, counting working sessions and this one", () => {
		const a = admissionFrom(mem, procs, { host, sessionFloor: 6 });
		expect(a.freeSlots).toBe(2);
		expect(a.sessionFloorWorking).toBe(3);
		expect(a.sessionFloorSlots).toBe(2);
		expect(a.sessionFloorLifted).toBe(true);
		expect(a.reason).toMatch(
			/^2 free slots, FLOOR: 2 slot\(s\) toward the 6 working sessions ~\/\.claude\/session-floor keeps \(#2501\), 3 working, over the p95 pricing/,
		);
	});

	it("never lowers the p95 slots, and is silent where none is declared", () => {
		const met = admissionFrom(mem, procs, { host, sessionFloor: 3 });
		expect(met.freeSlots).toBe(1);
		expect(met.sessionFloorLifted).toBe(false);
		expect(met.reason).toMatch(/^1 free slot on the live sessions' draw/);
		expect(admissionFrom(mem, procs, { host }).sessionFloorSlots).toBe(0);
	});

	it("names no lift where the always-admit-one guarantee already gives the slot", () => {
		const alone = { ok: true as const, sessions: 0, working: 0, self: true };
		const a = admissionFrom({ ok: true, mb: 700 + HELD }, alone, {
			host,
			sessionFloor: 2,
		});
		expect(a.sessionFloorSlots).toBe(1);
		expect(a.sessionFloorLifted).toBe(false);
	});

	it("is capped by the CPU like any slot", () => {
		const cpu = {
			ceiling: 3,
			sessions: 2,
			idleSpares: 0,
			slots: 1,
			full: false,
			unknown: null,
		};
		const a = admissionFrom(mem, procs, { host, cpu, sessionFloor: 6 });
		expect(a.freeSlots).toBe(1);
		expect(a.reason).toMatch(/; capped by the CPU: /);
	});

	it("grants nothing where memory is unread", () => {
		const a = admissionFrom({ ok: false, error: "x" }, procs, {
			host,
			sessionFloor: 6,
		});
		expect(a.freeSlots).toBeNull();
		expect(a.sessionFloorSlots).toBe(0);
	});

	it("grants no floor slot while the swap hold binds, keeping the p95 slot (#2690)", () => {
		const swapHold = {
			held: true as const,
			swapFreeMb: 245,
			swapTotalMb: 2048,
			availableMb: 1300 + HELD,
		};
		const a = admissionFrom(mem, procs, { host, sessionFloor: 6, swapHold });
		expect(a.freeSlots).toBe(1);
		expect(a.sessionFloorSlots).toBe(0);
		expect(a.sessionFloorLifted).toBe(false);
		expect(a.swapHold).toEqual(swapHold);
	});
});

/*
 * #2141: the machine's sessions, counted as `bg-pty-host` processes, fill a
 * session ceiling of 1.5 per core whatever memory is free.
 */
describe("the session ceiling (#2141)", () => {
	const roomy = 20_000;
	/* `n` session hosts, as `ps -eo pid=,rss=,args=` lists them. */
	const hosts = (n: number) =>
		Array.from(
			{ length: n },
			(_, i) => `${900 + i} 1000 claude bg-pty-host --session x${i}`,
		);

	it("caps memory's slots at the ceiling less the session hosts running", () => {
		const r = run({ mb: roomy, psLines: hosts(3), sessionCeiling: "5" });
		expect(r.json.memorySlots).toBeGreaterThan(2);
		expect(r.json.slots).toBe(2);
		expect(r.json.cpu).toEqual({
			ceiling: 5,
			sessions: 3,
			idleSpares: 0,
			slots: 2,
			full: false,
			unknown: null,
		});
		expect(r.json.reason).toMatch(
			/^3 session\(s\) running on the machine against the 5-session CPU ceiling \(#2141\), so 2 slot\(s\); were it not for the CPU, /,
		);
		expect(r.status).toBe(0);
	});

	/* `claude agents` lists one plan's sessions; the hosts are every plan's. */
	it("counts hosts the session listing does not name", () => {
		const r = run({
			mb: roomy,
			sessions: [SELF],
			psLines: hosts(4),
			sessionCeiling: "5",
		});
		expect(r.json.cpu.sessions).toBe(4);
		expect(r.json.slots).toBe(1);
	});

	/* Counted all the same, the unit #2141's ceiling was fitted in (#2502). */
	it("names how many of the hosts are an idle spare's", () => {
		const r = run({
			mb: roomy,
			psLines: [
				...hosts(2),
				"950 1000 claude bg-spare --bg-spare /tmp/x/spare/ab.claim.sock",
				"951 1000 claude bg-pty-host --bg-pty-host /tmp/x/spare/ab.pty.sock",
			],
			cwds: idleAt("950"),
			sessionCeiling: "5",
			json: false,
		});
		expect(r.stdout).toMatch(
			/^ {2}cpu slots {8}3 session\(s\) running on the machine \(1 of them an idle spare\) against the 5-session CPU ceiling \(#2141\), so 2 slot\(s\)$/m,
		);
	});

	it("leaves out a host whose daemon has gone, and any other claude process", () => {
		const r = run({
			mb: roomy,
			psLines: [
				...hosts(2),
				"950 1000 claude bg-spare --bg-spare /tmp/d/spare/ab.claim.sock",
				"951 1000 node bg-pty-host",
			],
			parents: { "901": "1" },
			sessionCeiling: "5",
		});
		expect(r.json.cpu.sessions).toBe(1);
	});

	it("leaves memory's reason alone where the ceiling does not bind", () => {
		const r = run({
			mb: 500,
			sessions: [SELF, "other"],
			psLines: hosts(2),
			sessionCeiling: "5",
		});
		expect(r.json.slots).toBe(0);
		expect(r.json.reason).not.toMatch(/#2141/);
	});

	/* dispatch-sessions.sh keys its remedy off this line. */
	it("holds — exit 1 — at the ceiling, on a `cpu sessions` line saying when it is the only hold", () => {
		const text = (m: Machine) =>
			run({
				sessions: [SELF, "a"],
				psLines: hosts(2),
				sessionCeiling: "2",
				...m,
				json: false,
			});
		const sole = text({ mb: roomy });
		expect(sole.status).toBe(1);
		expect(sole.stdout).toMatch(
			/^cpu sessions\s+2 session\(s\) running on the machine against the 2-session CPU ceiling \(#2141\), so 0 slot\(s\) — the only hold$/m,
		);
		const both = text({ mb: 500 });
		expect(both.stdout).toMatch(/^cpu sessions\s+.*so 0 slot\(s\)$/m);
		expect(both.stdout).not.toMatch(/the only hold/);
	});

	it("holds the guaranteed slot too", () => {
		const r = run({
			mb: 100,
			sessions: [SELF],
			psLines: hosts(1),
			sessionCeiling: "1",
		});
		expect(r.json.memorySlots).toBe(1);
		expect(r.json.slots).toBe(0);
		expect(r.json.cpuIsSoleHold).toBe(true);
	});

	it("caps nothing at WFC_SESSION_CEILING=0, saying so in the breakdown and nowhere else", () => {
		const r = run({ mb: roomy, psLines: hosts(3), sessionCeiling: "0" });
		expect(r.json.slots).toBe(r.json.memorySlots);
		const out = run({
			psLines: hosts(3),
			sessionCeiling: "0",
			json: false,
		}).stdout;
		expect(out).toMatch(/^ {2}cpu slots {8}none capped — no session ceiling/m);
		expect(out).not.toMatch(/^cpu sessions/m);
		const limbOnly = run({
			mb: null,
			sessionCeiling: "0",
			args: ["--load-only"],
			json: false,
		});
		expect(limbOnly.status).toBe(0);
		expect(limbOnly.stdout).toBe("");
	});

	it("prints the cpu slots beside the slot arithmetic", () => {
		const { stdout } = run({
			mb: roomy,
			psLines: hosts(2),
			sessionCeiling: "3",
			json: false,
		});
		expect(stdout).toMatch(
			/^ {2}slot arithmetic .*, capped to 1 by the cpu slots below\n {2}cpu slots {8}2 session\(s\) running on the machine against the 3-session CPU ceiling \(#2141\), so 1 slot\(s\)$/m,
		);
	});

	/* --force-memory runs --load-only, so overriding memory keeps it armed. */
	it("holds under --load-only too, and says when the count is unread", () => {
		const held = run({
			mb: null,
			psLines: hosts(2),
			sessionCeiling: "2",
			args: ["--load-only"],
			json: false,
		});
		expect(held.status).toBe(1);
		expect(held.stdout).toMatch(/^cpu sessions\s+.*— the only hold$/m);
		const unread = run({
			mb: null,
			psFails: true,
			sessionCeiling: "2",
			args: ["--load-only"],
			json: false,
		});
		expect(unread.status).toBe(0);
		expect(unread.stdout).toMatch(/^cpu sessions\s+unknown — ps unreadable/m);
	});
});

describe("hungJobs (mantahostels#2598)", () => {
	it("includes hungJobs in --json even when empty", () => {
		const r = run({});
		expect(r.json.hungJobs).toEqual([]);
	});
});

describe("text output stays a handful of figures", () => {
	it("prints seven lines plus the allowance warning line, and no other prose", () => {
		const r = runInProcess(SCRIPT, [], {
			env: {
				...process.env,
				...buildIsolatedEnv(dir),
				WFC_MEMINFO: meminfo(4000),
				WFC_PS: ps(["claude /usr/bin/claude"]),
				WFC_CLAUDE_BIN: claude([SELF, "other"], {
					cwd: writeHostRepo(dir, HOST_DRAW),
				}),
				CLAUDE_PROJECT_DIR: writeHostRepo(dir, HOST_DRAW),
			},
		});
		const [figures, memory] = r.stdout.split("\n\n");
		const lines = figures.split("\n");
		expect(lines).toHaveLength(8);
		expect(memory.trim().split("\n")).toHaveLength(9);
		expect(lines[0]).toMatch(/^available memory\s+4000 MB$/);
		expect(lines[2]).toMatch(/^session draw\s+mean 600 MB, σ 200 MB — /);
		expect(lines[3]).toMatch(
			/^live draw\s+1 live session\(s\): mean 600 MB \+ 1\.645 × σ 200 MB − 0 MB they already hold; 1 with no process, charged in full$/,
		);
		expect(lines[4]).toMatch(/^reclaimable\s+0 MB about to be reaped$/);
		// a 2906 MB budget holds the live draw and 2 more at 2370, not 3 at 3058
		expect(lines[5]).toMatch(/^slots\s+2 — ADMIT/);
		expect(lines[7]).toMatch(/^allowance\s+.*absent — admitting anyway/);
	});

	it("says REFUSED on stderr, with nothing on stdout to misread as a slot count", () => {
		const r = runInProcess(SCRIPT, [], {
			env: {
				...process.env,
				...buildIsolatedEnv(dir),
				WFC_MEMINFO: meminfo(null),
				WFC_PS: ps(["claude /usr/bin/claude"]),
				WFC_CLAUDE_BIN: claude([SELF]),
			},
		});
		expect(r.status).toBe(2);
		expect(r.stdout).toBe("");
		expect(r.stderr).toMatch(/ADMISSION REFUSED/);
	});
});

/*
 * mantahostels#2588. The re-read `dispatch-sessions.sh` takes before each spawn sees the
 * spare pool as it stands, and none of the pair the daemon warms the moment
 * this launch claims its own — which is exactly the memory the NEXT member of
 * the set will find gone. `--launch` charges for it up front.
 */
describe("the pending-spare reserve (mantahostels#2588)", () => {
	/* Two idle pairs at 200,000 kB PSS each: 781 MB of pool, 390 MB a pair,
	 * one of which is reserved without the flag. */
	const twoIdlePairs = {
		psLines: [
			"111 700000 claude bg-spare --bg-spare /tmp/x/spare/abc.claim.sock",
			"112 700000 claude bg-pty-host --bg-pty-host /tmp/x/spare/abc.pty.sock",
			"113 700000 claude bg-spare --bg-spare /tmp/x/spare/def.claim.sock",
			"114 700000 claude bg-pty-host --bg-pty-host /tmp/x/spare/def.pty.sock",
		],
		pss: { "111": 200_000, "112": 200_000, "113": 200_000, "114": 200_000 },
		cwds: idleAt("111", "113"),
	};

	it("reserves nothing extra without the flag", () => {
		const { json } = run({ mb: 8000, ...twoIdlePairs });
		expect(json.reservedMb).toBe(390);
	});

	it("adds one pair's own price for --launch", () => {
		const { json } = run({ mb: 8000, ...twoIdlePairs, args: ["--launch"] });
		// floor(781 / 2), twice
		expect(json.reservedMb).toBe(390 + 390);
	});

	/*
	 * The pool may hold no idle pair at all — every spare claimed, or a machine
	 * that has just started. The measured constant prices both the reserved
	 * pair and the pending one then; a 0 would read as a free spare.
	 */
	it("falls back to the measured 106 MB where no idle pair is resident", () => {
		const { json } = run({
			mb: 8000,
			psLines: ["999 100000 claude daemon run"],
			pss: { "999": 51_200 },
			args: ["--launch"],
		});
		expect(json.reservedMb).toBe(PAIR + PAIR);
	});

	it("costs a slot, which is the whole point", () => {
		/* A 3,300 MB budget, after the 390 MB pair reserved without the flag. */
		const grown = {
			mb: 3300 + 390 + HELD,
			sessions: [SELF, GROWN],
			...twoIdlePairs,
			pss: { ...twoIdlePairs.pss, ...GROWN_PSS },
		};
		const without = run(grown);
		const launching = run({ ...grown, args: ["--launch"] });
		expect(without.json.slots).toBe(4); // the live draw and 4 more need 3096
		expect(launching.json.slots).toBe(2); // 2910 MB left, less a pair per slot past the first
	});

	/*
	 * #2511: the dispatcher re-reads before each member of a batch, finding the
	 * pairs the earlier members warmed resident, so `slots` N holds only where
	 * the k-th slot pays for k pending pairs, the first in the reserve.
	 */
	it("charges each slot past the first its own pending pair (#2511)", () => {
		const { json } = run({
			mb: 3300 + 390 + HELD,
			sessions: [SELF, GROWN],
			...twoIdlePairs,
			pss: { ...twoIdlePairs.pss, ...GROWN_PSS },
			args: ["--launch"],
		});
		expect(json.budgetMb).toBe(2910);
		// the live draw and 3 more need 2418, which fits, but 2 more pairs do not
		expect(json.nextNeedMb).toBe(2418 + 2 * 390);
		expect(json.slots).toBe(2);
		// 1730 for the live draw and 2 more, and one more pair
		expect(json.reason).toMatch(
			/the live sessions' draw and 2 more, with 1 more spare pair\(s\) at 390 MB, need 2120 MB/,
		);
	});
});

/*
 * The per-spawn allowance re-read (#293 ruling 3, #294). A `.claude.json`
 * fixture stands in for `$CLAUDE_CONFIG_DIR`'s real cache — the same shape
 * `scripts/lib/allowance.js` reads.
 */
describe("the allowance re-read (#293, #294)", () => {
	const cacheDir = () => {
		const d = path.join(dir, "config");
		fs.mkdirSync(d, { recursive: true });
		return d;
	};

	const runWithConfig = (configDir: string, m: Machine = {}) => {
		const {
			mb = 4000,
			sessions = [SELF],
			psLines = ["claude /usr/bin/claude"],
			reaped = [],
		} = m;
		const r = runInProcess(SCRIPT, ["--json"], {
			env: {
				...process.env,
				...buildIsolatedEnv(dir, { configDir }),
				WFC_MEMINFO: meminfo(mb),
				WFC_PS: ps(psLines),
				WFC_CLAUDE_BIN: claude(sessions),
				WFC_REAP_SCRIPT: writeReapScript(dir, reaped),
			},
		});
		return {
			status: r.status,
			json: r.stdout.trim().startsWith("{") ? JSON.parse(r.stdout) : null,
		};
	};

	it("turns an ADMIT into a HOLD on a fresh session reading at the 100% backstop", () => {
		const configDir = cacheDir();
		writeCache(configDir, { session: 100, weeklyAll: 3 });
		const { json, status } = runWithConfig(configDir);
		expect(json.admit).toBe(false);
		expect(json.reason).toMatch(
			/session allowance 100% used \(backstop 100%\)/,
		);
		expect(status).toBe(1);
	});

	it("turns an ADMIT into a HOLD on a fresh weekly reading at the 100% backstop", () => {
		const configDir = cacheDir();
		writeCache(configDir, { session: 5, weeklyAll: 100 });
		const { json, status } = runWithConfig(configDir);
		expect(json.admit).toBe(false);
		expect(json.reason).toMatch(/weekly allowance 100% used \(backstop 100%\)/);
		expect(status).toBe(1);
	});

	/* #371 item 5: the 90/97 thresholds are the launcher's cap alone, so a set
	 * the cap admitted is not refused member by member on the same reading. */
	it("admits past the launcher's thresholds, and carries no allowance warning", () => {
		const configDir = cacheDir();
		writeCache(configDir, { session: 99, weeklyAll: 99 });
		const { json } = runWithConfig(configDir);
		expect(json.admit).toBe(true);
		expect(json.allowanceWarning).toBeNull();
	});

	it("warns rather than refuses on an absent reading, and still admits", () => {
		const { json, status } = runWithConfig(path.join(dir, "no-such-config"));
		expect(json.allowanceWarning).toMatch(/absent — admitting anyway/);
		expect(json.admit).toBe(true);
		expect(status).toBe(0);
	});

	it("warns rather than refuses on a stale reading, even at the backstop", () => {
		const configDir = cacheDir();
		writeCache(
			configDir,
			{ session: 100, weeklyAll: 100 },
			Date.now() - 10 * 60 * 1000,
		);
		const { json } = runWithConfig(configDir);
		expect(json.allowanceWarning).toMatch(/stale — admitting anyway/);
		expect(json.admit).toBe(true);
	});

	/* #299: what `dispatch-sessions.sh --force` passes. The allowance limb
	 * goes; the memory limb, asserted on the second run, stays. */
	it("--skip-allowance admits past a fresh breach, but still holds on memory", () => {
		const configDir = cacheDir();
		writeCache(configDir, { session: 100, weeklyAll: 100 });
		const env = (mb: number) => ({
			...process.env,
			...buildIsolatedEnv(dir, { configDir }),
			WFC_MEMINFO: meminfo(mb),
			WFC_PS: ps(["claude /usr/bin/claude"]),
			WFC_CLAUDE_BIN: claude([SELF, "a-neighbour"]),
		});
		const ok = runInProcess(SCRIPT, ["--json", "--skip-allowance"], {
			env: env(20_000),
		});
		expect(ok.status).toBe(0);
		expect(JSON.parse(ok.stdout).allowanceWarning).toBeNull();

		const low = runInProcess(SCRIPT, ["--json", "--skip-allowance"], {
			env: env(1),
		});
		expect(low.status).toBe(1);
		expect(JSON.parse(low.stdout).reason).toMatch(
			/, under the \d+ MB the live sessions' draw and one more need/,
		);
	});

	/* The launcher's threshold vars do not reach this limb (#371 item 5). */
	it("ignores WFC_DISPATCH_*_CEILING, which size the launcher's cap only", () => {
		const configDir = cacheDir();
		writeCache(configDir, { session: 80, weeklyAll: 3 });
		const r = runInProcess(SCRIPT, ["--json"], {
			env: {
				...process.env,
				...buildIsolatedEnv(dir, { configDir }),
				WFC_MEMINFO: meminfo(4000),
				WFC_PS: ps(["claude /usr/bin/claude"]),
				WFC_CLAUDE_BIN: claude([SELF]),
				WFC_DISPATCH_SESSION_CEILING: "75",
			},
		});
		expect(JSON.parse(r.stdout).admit).toBe(true);
	});
});

/*
 * #589. The breakdown rides after the figures and before the hung-job section,
 * so every line a caller already parses stays byte-identical — the fixture's
 * `expected` was captured from admission.js before the breakdown existed. Its
 * figures move with the slot rule, as #2140's suite reserve moved them.
 */
describe("the memory breakdown (#589)", () => {
	interface Scenario {
		args: string[];
		meminfo: string;
		agents: object[];
		ps: string[];
		pss: Record<string, number>;
		reaped: Array<{ pss: number }>;
		expected: { status: number; stdout: string; stderr: string };
	}
	const scenarios: Record<string, Scenario> = JSON.parse(
		fs.readFileSync(
			path.join(__dirname, "fixtures", "admission-pre-589.json"),
			"utf8",
		),
	);

	const runScenario = (
		s: Scenario,
		{ json = false, reapFails = false } = {},
	) => {
		const meminfoPath = path.join(dir, "meminfo");
		fs.writeFileSync(meminfoPath, s.meminfo);
		const host = writeHostRepo(dir, HOST_DRAW);
		const agents = s.agents.map((a) => ({ cwd: host, ...a }));
		const r = runInProcess(SCRIPT, [...(json ? ["--json"] : []), ...s.args], {
			cwd: host,
			env: {
				PATH: process.env.PATH,
				HOME: dir,
				...buildIsolatedEnv(dir),
				WFC_MEMINFO: meminfoPath,
				WFC_PS: ps(s.ps),
				WFC_CLAUDE_BIN: claude(null, { raw: JSON.stringify(agents) }),
				WFC_PROC: writeProcRoot(dir, { pss: s.pss, cwds: idleAt("112") }),
				WFC_REAP_SCRIPT: writeReapScript(dir, s.reaped, { fails: reapFails }),
				CLAUDE_PROJECT_DIR: host,
			},
		});
		const norm = (t: string) => t.split(dir).join("<dir>");
		return { ...r, stdout: norm(r.stdout), stderr: norm(r.stderr) };
	};
	const withoutBreakdown = (t: string) =>
		t.replace(/\n\nmemory {13}[\s\S]*?(?=\n\nhung job|\n$)/, "");

	for (const name of ["admit", "hold", "refused"])
		it(`leaves the ${name} case's existing lines and exit code byte-identical`, () => {
			const s = scenarios[name];
			const r = runScenario(s);
			expect(r.status).toBe(s.expected.status);
			expect(withoutBreakdown(r.stdout)).toBe(s.expected.stdout);
			expect(withoutBreakdown(r.stderr)).toBe(s.expected.stderr);
			expect(`${r.stdout}${r.stderr}`).toMatch(/\n\nmemory {13}of /);
		});

	it("carries a memory object in --json whose rows reconcile to MemTotal", () => {
		const m = JSON.parse(
			runScenario(scenarios.admit, { json: true }).stdout,
		).memory;
		/* MemTotal 10,240,000 kB = 10,000 MB. Each session is its PAIR's PSS:
		 * 400,000 + 80,000 and 420,000 + 80,000 kB working, 350,000 + 70,000 kB
		 * finished. The pool is the daemon plus the idle pair: 410,000 kB. */
		expect(m.totalMb).toBe(10_000);
		expect(m.free).toEqual({ mb: 6000, unknown: null });
		expect(m.working).toEqual({ count: 2, mb: 957, unknown: null });
		expect(m.finished).toMatchObject({ count: 1, mb: 410, reapable: 1 });
		expect(m.pool).toEqual({ mb: 400, unknown: null, drift: [] });
		expect(m.other.mb).toBe(10_000 - 6000 - 957 - 410 - 400);
		expect(
			m.free.mb + m.working.mb + m.finished.mb + m.pool.mb + m.other.mb,
		).toBe(m.totalMb);
	});

	it("names the three largest processes that are neither a session nor the pool", () => {
		const m = JSON.parse(
			runScenario(scenarios.admit, { json: true }).stdout,
		).memory;
		expect(m.other.largest).toEqual([
			{ pid: "900", rssMb: 878, command: "node node_modules/.bin/vitest run" },
			{ pid: "901", rssMb: 292, command: "node next dev" },
			{ pid: "902", rssMb: 195, command: "/usr/bin/python3 pipeline.py" },
		]);
	});

	it("prints the slot arithmetic from free memory to the slot count", () => {
		const r = runScenario(scenarios.admit);
		expect(r.stdout).toMatch(
			/ {2}slot arithmetic {2}6000 free − 506 pool − 794 floor − 300 margin \+ 420 reclaim = 4820 MB; the live sessions' draw needs 441 MB of it, and with 5 more, with 4 more spare pair\(s\) at 253 MB, 4930 MB, so 4 slot\(s\)\n/,
		);
	});

	it("prints an unreadable session PSS as unknown, and the remainder with it, never 0", () => {
		const s = scenarios.admit;
		const { "301": _, ...pss } = s.pss;
		const r = runScenario({ ...s, pss });
		expect(r.status).toBe(s.expected.status);
		expect(r.stdout).toMatch(
			/ {2}working {10}unknown \(pid 301's smaps_rollup unreadable\)/,
		);
		expect(r.stdout).toMatch(
			/ {2}everything else {2}unknown \(a row above it is unknown\)/,
		);
	});

	it("prints how many the next reap takes as unknown where the reap plan fails", () => {
		const r = runScenario(scenarios.admit, { reapFails: true });
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/410 MB PSS, unknown \(reap plan: /);
	});

	it("prints every memory row as unknown on a refused read, with the reason", () => {
		const r = runScenario(scenarios.refused);
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(
			/ {2}free {13}unknown \(memory unreadable: <dir>\/meminfo carries no MemAvailable line\)/,
		);
		expect(r.stderr).toMatch(
			/ {2}slot arithmetic {2}unknown \(memory unreadable/,
		);
	});

	it("prints the verdict's own slot figures where the pool reserve exceeds free memory", () => {
		/* Two pairs at 253 MB reserve 506 MB against 400 free; the verdict
		 * counts from 0, and the reclaim, less the floor and margin, buys the
		 * slots: one, a second paying for its own pending pair. */
		const s = {
			...scenarios.admit,
			meminfo: scenarios.admit.meminfo.replace(
				/MemAvailable: +\d+/,
				"MemAvailable:     409600",
			),
		};
		const reaped = [{ pss: 3000 }];
		const r = runScenario({ ...s, reaped }, { json: true });
		const out = JSON.parse(r.stdout);
		expect(out.memory.slots).toMatchObject({
			budgetMb: out.budgetMb,
			byMemory: 1,
			slots: out.slots,
		});
		const text = runScenario({ ...s, reaped }).stdout;
		expect(text).toMatch(
			/[=] 1906 MB; .*, so 1 slot\(s\), the pool reserve exceeding free memory so the rest counting from 0\n/,
		);
	});

	it("names the overlap rather than printing everything else negative", () => {
		/* A 5,000,000 kB session PSS: the rows above everything else pass MemTotal. */
		const s = scenarios.admit;
		const r = runScenario(
			{ ...s, pss: { ...s.pss, "201": 5_000_000 } },
			{ json: true },
		);
		const m = JSON.parse(r.stdout).memory;
		expect(m.other.mb).toBe(0);
		expect(m.other.overlapMb).toBeGreaterThan(0);
		expect(m.free.mb + m.working.mb + m.finished.mb + m.pool.mb).toBe(
			m.totalMb + m.other.overlapMb,
		);
	});

	it("splits the finished sessions by how many the next reap takes", () => {
		const s = scenarios.admit;
		const r = runScenario(
			{
				...s,
				agents: [
					...s.agents,
					{
						sessionId: "second-done",
						pid: 501,
						kind: "background",
						state: "done",
					},
				],
				ps: [
					...s.ps,
					"501 400000 claude bg-spare --bg-spare /tmp/x/spare/eee.claim.sock",
				],
				pss: { ...s.pss, "501": 102_400 },
			},
			{ json: true },
		);
		expect(JSON.parse(r.stdout).memory.finished).toMatchObject({
			count: 2,
			mb: 510,
			reapable: 1,
		});
	});
});
