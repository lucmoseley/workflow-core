// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	admissionFrom,
	buildMemoryBreakdownLines,
	buildWindowsLine,
	readRunningVitestSuites,
	readSwapHold,
	readTreePssKb,
	SUITE_RESTING_MB,
	SWAP_HOLD_AVAILABLE_MB,
	selectionAdmission,
	WHOLE_SUITE_WORKERS,
} from "./lib/admission";
import {
	buildIsolatedEnv,
	type Gate,
	type HeldRun,
	type Lander,
	SELF,
	type Typecheck,
	writeHostRepo,
	writeLoadavg,
	writeProcRoot,
	writeReapScript,
} from "./lib/admission-testkit";
import { admissionSessionIds } from "./lib/agent-liveness";
import { writeCache } from "./lib/dispatch-sessions-testkit";
import { GATE_SEAT_DEFAULT_MB } from "./lib/gate-seat";
import { chargeMb as launchChargeMb } from "./lib/launch-charge";
import { readLiveLanders } from "./lib/local-tester";
import { carrying } from "./lib/proc-fake";
import { writePsStub } from "./lib/ps-stub";
import { runInProcess } from "./lib/run-in-process";
import { shellQuote } from "./lib/sh-quote.js";
import { readLiveGateSeats, readLiveTypechecks } from "./lib/suite-queue";

const FLOOR = 794;

const rung = (n: 1 | 2 | 3) => SUITE_RESTING_MB[n];

const SCRIPT = path.resolve(__dirname, "admission.js");
const HOST_DRAW = { sessionMeanMb: 600, sessionSigmaMb: 200 };
const HELD = FLOOR + 300;
const PAIR = 106;
const GROWN = "other@701";
const mbKb = (mb: number) => mb * 1024;
const GROWN_PSS = { "701": mbKb(640) };
const SPARE_DIR = "/tmp/x/spare";
const idleAt = (...pids: string[]) =>
	Object.fromEntries(pids.map((pid) => [pid, SPARE_DIR]));

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "admission-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

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

const ps = (lines: string[], { fails = false } = {}) =>
	writePsStub(dir, lines, { fails });

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
	fs.writeFileSync(p, `#!/bin/sh\ncat ${shellQuote(out)}\n`, {
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
	parents?: Record<string, string>;
	cwds?: Record<string, string>;
	environs?: Record<string, string[]>;
	reaped?: Array<{ pss: number | null }> | null;
	reapFails?: boolean;
	reapRaw?: string;
	args?: string[];
	json?: boolean;
	hostConfig?: Record<string, unknown>;
	agentsRaw?: string;
	load?: number | null;
	sessionCeiling?: string;
	landers?: Lander[];
	gates?: Gate[];
	heldRuns?: HeldRun[];
	typechecks?: Typecheck[];
	states?: Record<string, string>;
	windowsMb?: number;
	queueUnreadable?: boolean;
}

const WHOLE_LANDER: Lander = { pid: process.pid, chargeMb: 1150 };

const machineEnv = (m: Machine = {}) => {
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
		hostConfig = HOST_DRAW,
		agentsRaw,
		load = 0.5,
		sessionCeiling = "0",
		landers = [],
		gates = [],
		heldRuns = [],
		typechecks = [],
		states = {},
		windowsMb,
	} = m;
	const host = writeHostRepo(dir, hostConfig);
	const minuteLog = path.join(dir, "memwatch-minute.jsonl");
	fs.rmSync(minuteLog, { force: true });
	if (windowsMb !== undefined)
		fs.writeFileSync(
			minuteLog,
			`${JSON.stringify({
				ts: new Date().toISOString(),
				win_avail_mb: windowsMb,
				win_age_s: 0,
			})}\n`,
		);
	return {
		MEMWATCH_MINUTE_LOG: minuteLog,
		...buildIsolatedEnv(dir, { landers, gates, heldRuns, typechecks }),
		WFC_MEMINFO: meminfo(mb),
		WFC_PS: ps(psLines, { fails: psFails }),
		WFC_CLAUDE_BIN: claude(sessions, { raw: agentsRaw, cwd: host, states }),
		WFC_PROC: writeProcRoot(dir, { pss, parents, cwds, environs }),
		WFC_REAP_SCRIPT: writeReapScript(dir, reaped, {
			fails: reapFails,
			raw: reapRaw,
		}),
		WFC_LOADAVG: writeLoadavg(dir, load),
		WFC_SESSION_CEILING: sessionCeiling,
		CLAUDE_CODE_SESSION_ID: self,
		CLAUDE_PROJECT_DIR: host,
	};
};

const run = (m: Machine = {}) => {
	const { args = [], json = true, queueUnreadable = false } = m;
	const env = machineEnv(m);
	const queue = path.join(env.TMPDIR, "wfc-suite-queue");
	if (queueUnreadable) fs.chmodSync(queue, 0o000);
	let r: ReturnType<typeof runInProcess>;
	try {
		r = runInProcess(SCRIPT, [...(json ? ["--json"] : []), ...args], {
			env: { ...process.env, ...env },
		});
	} finally {
		if (queueUnreadable) fs.chmodSync(queue, 0o755);
	}
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

describe("the swap hold (#2690)", () => {
	const holdAt = (
		mb: number,
		swap: { totalMb: number; freeMb: number } | null,
	) => {
		vi.stubEnv("WFC_MEMINFO", meminfo(mb, swap));
		return readSwapHold();
	};

	it("binds while swap is under 25% free and memory under 2200 MB", () => {
		expect(holdAt(2100, { totalMb: 2048, freeMb: 245 })).toEqual({
			held: true,
			swapFreeMb: 245,
			swapTotalMb: 2048,
			availableMb: 2100,
		});
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
		["swap a quarter free", 2100, { totalMb: 2048, freeMb: 512 }],
		["2200 MB available", 2200, { totalMb: 2048, freeMb: 0 }],
		["no swap", 2100, { totalMb: 0, freeMb: 0 }],
		["no swap lines", 2100, null],
	])("holds nothing at %s", (_, mb, swap) => {
		expect(holdAt(mb, swap)).toEqual({ held: false });
	});
});

describe("the lander's suite reserve (#2416)", () => {
	const LanderDraw = WHOLE_LANDER.chargeMb;
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
		vi.stubEnv(
			"WFC_PROC",
			writeProcRoot(dir, {
				pss: { "50": 100, "51": 200, "52": 300, "60": 9000 },
				parents: { "51": "50", "52": "51", "60": "1" },
			}),
		);
		expect(readTreePssKb(50)).toBe(600);
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

describe("the gate-seat reserve (#5274, spec #5273 §2)", () => {
	const Undeclared = GATE_SEAT_DEFAULT_MB;
	const big = {
		mb: Undeclared + 3000 + HELD + PAIR,
		sessions: [SELF, GROWN],
		pss: GROWN_PSS,
	};
	const pid = String(process.pid);

	it("holds the whole-suite rung for a gate seat declaring no charge, queued or running", () => {
		const without = run(big).json;
		const { json } = run({ ...big, gates: [{ pid: process.pid }] });
		expect(Undeclared).toBe(3350);
		expect(without.gateMb).toBe(0);
		expect(json.gateMb).toBe(Undeclared);
		expect(json.budgetMb).toBe(without.budgetMb - Undeclared);
		expect(json.slots).toBeLessThan(without.slots);
		expect(json.reason).toMatch(
			new RegExp(`holding ${Undeclared} MB for the gate seat`),
		);
	});

	it("holds the gateSeatMb charge the seat's marker carries", () => {
		expect(
			run({ ...big, gates: [{ pid: process.pid, chargeMb: 1800 }] }).json
				.gateMb,
		).toBe(1800);
	});

	it("holds one reserve, the largest charge, never a sum", () => {
		const { json } = run({
			...big,
			gates: [
				{ pid: process.pid, chargeMb: 1800 },
				{ pid: 1, chargeMb: 1200 },
			],
		});
		expect(json.gateMb).toBe(1800);
	});

	it("holds the largest charge less a running seat's draw while another waits, never the draw twice", () => {
		const { json } = run({
			...big,
			gates: [
				{ pid: process.pid, chargeMb: Undeclared, spawned: true },
				{ pid: 1, chargeMb: Undeclared },
			],
			pss: { ...GROWN_PSS, "9001": mbKb(3000) },
			parents: { "9001": pid },
		});
		expect(json.gateMb).toBe(Undeclared - 3000);
	});

	it("credits a queued seat nothing, its holder having started no command", () => {
		const { json } = run({
			...big,
			gates: [{ pid: process.pid, chargeMb: 1800 }],
			pss: { ...GROWN_PSS, "9001": mbKb(500) },
			parents: { "9001": pid },
		});
		expect(json.gateMb).toBe(1800);
	});

	it("floors the reserve at nothing where a running seat draws past its charge", () => {
		const { json } = run({
			...big,
			gates: [{ pid: process.pid, chargeMb: 1800, spawned: true }],
			pss: { ...GROWN_PSS, "9001": mbKb(2500) },
			parents: { "9001": pid },
		});
		expect(json.gateMb).toBe(0);
	});

	it("reduces the reserve by the PSS of the processes the seat started, the holder itself earning none", () => {
		const { json } = run({
			...big,
			gates: [{ pid: process.pid, chargeMb: 1800, spawned: true }],
			pss: {
				...GROWN_PSS,
				[pid]: mbKb(200),
				"9001": mbKb(500),
				"9002": mbKb(300),
			},
			parents: { "9001": pid, "9002": "9001" },
		});
		expect(json.gateMb).toBe(1800 - 800);
	});

	it("reduces the reserve by a gate a session started, and credits the session none of the gate's subtree", () => {
		const machine = {
			...big,
			pss: { ...GROWN_PSS, [pid]: mbKb(200), "9001": mbKb(800) },
			parents: { [pid]: "701", "9001": pid },
		};
		const ungated = run(machine).json;
		expect(ungated.memory.live.mb).toBe(640 + 200 + 800);
		const { json } = run({
			...machine,
			gates: [{ pid: process.pid, chargeMb: 1800, spawned: true }],
		});
		expect(json.gateMb).toBe(1800 - 800);
		expect(json.memory.live.mb).toBe(640);
		expect(json.drawNeedMb).toBe(ungated.drawNeedMb + 200 + 800);
	});

	it("holds nothing for a dead gate seat's marker", () => {
		expect(run({ ...big, gates: [{ pid: 2 ** 22 + 1 }] }).json.gateMb).toBe(0);
	});

	it("holds both reserves' default charges, and says why, where the suite queue will not read (#5301)", () => {
		const without = run(big).json;
		const { json } = run({
			...big,
			gates: [{ pid: process.pid, chargeMb: 1800 }],
			queueUnreadable: true,
		});
		const lander = launchChargeMb({ kind: "lander", files: [] });
		expect(json.gateMb).toBe(Undeclared);
		expect(json.landerMb).toBe(lander);
		expect(json.budgetMb).toBe(without.budgetMb - Undeclared - lander);
		expect(json.reason).toMatch(
			new RegExp(
				`holding ${lander} MB for the lander's suite, as the suite queue .* would not read \\(EACCES`,
			),
		);
		expect(json.reason).toMatch(
			new RegExp(
				`holding ${Undeclared} MB for the gate seat, as the suite queue .* would not read \\(EACCES`,
			),
		);
	});

	it("prints the reserve in the slot arithmetic beside the lander's", () => {
		const { stdout } = run({
			...big,
			landers: [WHOLE_LANDER],
			gates: [{ pid: 1, chargeMb: 1800 }],
			json: false,
		});
		expect(stdout).toMatch(
			new RegExp(
				`− ${PAIR} pool − ${WHOLE_LANDER.chargeMb} lander − 1800 gate seat − ${FLOOR} floor`,
			),
		);
	});
});

describe("the held-run reserve (#5555)", () => {
	const Suite = 3000;
	const room = Suite + HELD + PAIR;

	it("refuses a session that fits without the reserve while a held run's charge would not fit beside it", () => {
		const machine = { mb: room, sessions: [SELF, GROWN], pss: GROWN_PSS };
		const without = run(machine).json;
		expect(without.slots).toBeGreaterThan(0);
		const { json } = run({
			...machine,
			heldRuns: [{ pid: process.pid, chargeMb: Suite }],
		});
		expect(json.heldRunMb).toBe(Suite);
		expect(json.budgetMb).toBe(without.budgetMb - Suite);
		expect(json.slots).toBe(0);
		expect(json.reason).toMatch(
			new RegExp(
				`holding ${Suite} MB for the queued test run the memory rung holds`,
			),
		);
	});

	it("still admits a session that fits beside the held run's charge", () => {
		const { json } = run({
			mb: room + Suite,
			sessions: [SELF, GROWN],
			pss: GROWN_PSS,
			heldRuns: [{ pid: process.pid, chargeMb: Suite }],
		});
		expect(json.heldRunMb).toBe(Suite);
		expect(json.slots).toBeGreaterThan(0);
	});

	it("holds the room the run's rung needs where it is more than its charge", () => {
		const { json } = run({
			mb: room + 4000,
			heldRuns: [{ pid: process.pid, chargeMb: 1929, rungMb: 3350 }],
		});
		expect(json.heldRunMb).toBe(3350 - HELD);
	});

	it("prints the reserve in the slot arithmetic", () => {
		const { stdout } = run({
			mb: room + 4000,
			heldRuns: [{ pid: process.pid, chargeMb: Suite }],
			json: false,
		});
		expect(stdout).toMatch(new RegExp(`− ${Suite} held run − ${FLOOR} floor`));
	});
});

describe("daemon + spare-pool reservation", () => {
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
		expect(json.reservedMb).toBe(590);
		expect(json.memory.pool.mb).toBe(808);
		expect(json.slots).toBe(2);
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
		expect(json.reservedMb).toBe(195);
	});

	it("falls back to RSS for a process whose rollup cannot be read", () => {
		const { json } = run({
			mb: 4000,
			psLines: [
				"111 700000 claude bg-spare --bg-spare /tmp/x/spare/abc.claim.sock",
				"112 700000 claude bg-spare --bg-spare /tmp/x/spare/def.claim.sock",
			],
			pss: { "111": 200_000 },
			cwds: idleAt("111", "112"),
		});
		expect(json.reservedMb).toBe(439);
	});

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
		expect(json.reservedMb).toBe(292);
		expect(json.memory.pool.mb).toBe(878);
		expect(json.slots).toBe(3);
	});

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
		expect(json.memory.live).toMatchObject({ count: 2, mb: 150 });
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
		expect(json.reservedMb).toBe(244);
	});

	it("fails open to no reservation where the overhead scan cannot run", () => {
		const { json, status } = run({
			mb: 4000,
			psFails: true,
		});
		expect(status).toBe(0);
		expect(json.reservedMb).toBe(0);
		expect(json.slots).toBe(3);
	});
});

describe("the unlisted row (#3322)", () => {
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
				m.live.mb +
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
		expect(json.memory.live.mb).toBe(450);
	});

	it("reads unknown where the listing was refused, as working does", () => {
		const { json } = unlisted({}, { agentsRaw: "not json" });
		expect(json.memory.unlisted.unknown).toMatch(/^session listing: /);
		expect(json.memory.unlisted.mb).toBeNull();
		expect(json.memory.other.mb).toBeNull();
	});

	it("reads unknown where the listing is empty and unvouched, never every claimed pair as unlisted (#3504)", () => {
		const { json } = unlisted({}, { sessions: [], self: "" });
		expect(json.memory.unlisted).toEqual({
			count: null,
			mb: null,
			unknown: expect.stringMatching(/^session listing: empty and unvouched/),
			dirs: [],
		});
		expect(json.memory.other.mb).toBeNull();
	});

	it("reads none where the listing is empty and unvouched but no pair is claimed (#3504)", () => {
		const { json } = unlisted(
			{},
			{ sessions: [], self: "", cwds: idleAt("111", "333") },
		);
		expect(json.memory.unlisted).toEqual({
			count: 0,
			mb: 0,
			unknown: null,
			dirs: [],
		});
		expect(json.memory.other.mb).not.toBeNull();
	});
});

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

describe("aggregate session draw (#2221)", () => {
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
			"3 live session(s): mean 2000 MB + 1.645 × σ 424 MB − 0 MB they already hold; 2 with no process, charged in full, 1 more charged nothing until they wake",
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
			pss: {},
		};
		expect(run(machine).json.drawNeedMb).toBe(1666);
		expect(run({ ...machine, json: false }).stdout).toMatch(
			/^live draw +2 live session\(s\): .*; 2 charged in full, memory unread$/m,
		);
	});

	it("charges a listed session with no pid, within the cap of two, its whole draw, and reads the live row without it (#2426, #5283)", () => {
		const { json, status } = run({
			mb: 6000,
			sessions: [SELF, "a", "b@202"],
			pss: { "202": mbKb(250) },
		});
		expect(status).toBe(0);
		expect(json.drawNeedMb).toBe(1416);
		expect(json.memory.live).toMatchObject({
			mb: 250,
			noProcess: 2,
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
			/^ {2}live +3 session\(s\) \(2 with no process\), 250 MB PSS$/m,
		);
	});

	it("charges only two of five listed sessions with no pid, and says how many it charged (#5283, #5706)", () => {
		const machine = {
			mb: 6000,
			sessions: [SELF, "a", "b", "c", "d", "e"],
			pss: {},
		};
		expect(run(machine).json).toMatchObject({
			drawNeedMb: 1666,
			noProcessCharged: 2,
		});
		expect(run({ ...machine, json: false }).stdout).toMatch(
			/^live draw +5 live session\(s\): mean 1200 MB \+ 1\.645 × σ 283 MB − 0 MB they already hold; 2 with no process, charged in full, 3 more charged nothing until they wake$/m,
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
			parents: { "301": "201", "302": "301", "401": "201" },
		});
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

	it("gives the admission verdict pick-next sizes a burst with the same answer", () => {
		const mem = { ok: true as const, mb: 4962 };
		const procs = { ok: true as const, sessions: 10 };
		const a = admissionFrom(mem, procs, {
			live: {
				sessions: 10,
				meanMb: 6000,
				varianceMb2: 10 * 200 ** 2,
				pssMb: 3230,
				unread: 0,
				noProcessCharged: 0,
				noProcessUncharged: 0,
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
		expect(json.drawNeedMb).toBe(3811);
		expect(json.slots).toBe(0);
	});
});

describe("reclaimable pool (mantahostels#1288)", () => {
	it("credits the reaper's reaped PSS into the slot count, and names it in the reason", () => {
		const { json } = run({
			mb: 2000 + HELD + PAIR,
			reaped: [{ pss: 273 }, { pss: 236 }, { pss: 255 }, { pss: 313 }],
		});
		expect(json.reclaimedMb).toBe(1077);
		expect(json.slots).toBe(4);
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
			mb: rung(2) - 1,
			reaped: [{ pss: 500 }],
		});
		expect(json.reclaimedMb).toBe(500);
		expect(json.suites).toBe(1);
	});

	it("credits the reclaim below the one-suite rung, where a first suite's pretest reap really fires", () => {
		const { json } = run({
			mb: rung(1) - 300 + PAIR,
			reaped: [{ pss: 300 }],
		});
		expect(json.reclaimedMb).toBe(300);
		expect(json.suites).toBe(1);
	});

	it("still admits no suite where the reclaim cannot close the gap", () => {
		const { json } = run({ mb: rung(1) - 1100, reaped: [{ pss: 100 }] });
		expect(json.suites).toBe(0);
	});

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
		expect(json.reservedMb).toBe(390);
		expect(json.reclaimedMb).toBe(400);
		expect(json.suites).toBe(0);
	});

	it("never lets the credit buy a SECOND suite from under the rung", () => {
		const mb = rung(1) - 700;
		const reaped = rung(2) - mb + 100;
		const { json } = run({ mb, reaped: [{ pss: reaped }] });
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
		expect(json.suites).toBe(0);
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
	it("counts a backgrounded session whose comm is a version number", () => {
		const { json } = run({
			psLines: [
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
	const suites = (mb: number) => run({ mb: mb + PAIR }).json.suites;

	it("never allows four, which nothing has measured on this suite", () => {
		expect(suites(3000)).toBe(1);
		expect(suites(100_000)).toBe(3);
	});

	it("walks the 2.7 / 3.65 / 4.7 GB resting bands", () => {
		expect(suites(4700)).toBe(3);
		expect(suites(4699)).toBe(2);
		expect(suites(3650)).toBe(2);
		expect(suites(3649)).toBe(1);
		expect(suites(2700)).toBe(1);
		expect(suites(2699)).toBe(0);
	});
});

const readSuitesWithPs = (p: string) => {
	vi.stubEnv("WFC_PS", p);
	return readRunningVitestSuites();
};

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

	describe("weighs a runner by the weight its launch record carries, not its argv (#2931)", () => {
		const procDirOf = (pid: number, launch: object | null) => {
			const procDir = path.join(dir, "procDir");
			carrying(procDir, pid, launch);
			return procDir;
		};
		const readWithProc = (procDir: string, lines: string[]) => {
			vi.stubEnv("WFC_PROC", procDir);
			return readSuitesWithPs(ps(lines));
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

	it("names an overload on a memory refusal too", () => {
		const r = text({ load: ceiling, mb: null });
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/ADMISSION REFUSED/);
		expect(r.stderr).toMatch(/^cpu load\s+.*\(#830\)$/m);
	});

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

describe("admissionFrom's own fallback and wording", () => {
	const host = { meanMb: 600, sigmaMb: 200, declared: true };
	const roomy = { ok: true as const, mb: 4000 + FLOOR };
	const tight = { ok: true as const, mb: 1300 + HELD };
	const one = { ok: true as const, sessions: 1 };
	const three = { ok: true as const, sessions: 3 };
	const over = { overloaded: true, load1: 60, ceiling: 48 };
	const capped = {
		ceiling: 3,
		sessions: 2,
		idleSpares: 0,
		slots: 1,
		full: false,
		unknown: null,
	};

	it("admits on unread memory, naming the headroom unmeasured, its slots unknown", () => {
		const a = admissionFrom({ ok: false, error: "x" }, three, { host });
		expect(a.freeSlots).toBeNull();
		expect(a.admit).toBe(true);
		expect(a.reason).toMatch(/^headroom unmeasured/);
	});

	it("names the load over the ceiling, holding even unread memory and the guarantee", () => {
		const a = admissionFrom(roomy, one, { host, load: over });
		expect(a.freeSlots).toBe(0);
		expect(a.admit).toBe(false);
		expect(a.reason).toMatch(/load1 60 is at or above the 48 ceiling/);
		expect(
			admissionFrom(roomy, { ok: true, sessions: 0 }, { host, load: over })
				.admit,
		).toBe(false);
		const unread = admissionFrom({ ok: false, error: "x" }, one, {
			host,
			load: over,
		});
		expect(unread.freeSlots).toBeNull();
		expect(unread.admit).toBe(false);
	});

	it("holds on a queued test run the Windows hold is holding, and names what the budget held back (#4956)", () => {
		const held = admissionFrom(roomy, one, { host, testsHeld: 2 });
		expect(held.admit).toBe(false);
		expect(held.freeSlots).toBe(0);
		expect(held.reason).toBe(
			"2 queued test run(s) are held on Windows memory, so no session is added until they run (#4956)",
		);
		const charged = admissionFrom(roomy, one, {
			host,
			typecheckChargeMb: 1497,
			windows: { state: "fresh", mb: 1250, ageS: 30 },
			guestFreeMb: 900,
		});
		expect(charged.reason).toMatch(
			/, holding 1497 MB for a type-check, less 400 MB of guest free memory Windows cannot back, holding 794 \+ 300 MB/,
		);
	});

	it("names the CPU cap, and the full ceiling", () => {
		const a = admissionFrom(roomy, one, { host, cpu: capped });
		expect(a.freeSlots).toBe(1);
		expect(a.reason).toMatch(/; capped by the CPU: 2 session\(s\) running/);
		const full = { ...capped, sessions: 3, slots: 0, full: true };
		const held = admissionFrom(
			roomy,
			{ ok: true, sessions: 0 },
			{ host, cpu: full },
		);
		expect(held.freeSlots).toBe(0);
		expect(held.admit).toBe(false);
		expect(held.reason).toMatch(/3-session CPU ceiling \(#2141\)/);
	});

	it("names the pending pairs past the first slot, and none without a launch price", () => {
		const a = admissionFrom(roomy, one, { host, launchMb: 250 });
		expect(a.freeSlots).toBe(3);
		expect(a.reason).toMatch(
			/^3 free slots on the live sessions' draw at p95 and 2 more spare pair\(s\) at 250 MB/,
		);
		expect(admissionFrom(roomy, one, { host }).reason).not.toMatch(
			/spare pair/,
		);
	});

	it("names a single free slot in the singular", () => {
		const a = admissionFrom(tight, three, { host });
		expect(a.freeSlots).toBe(1);
		expect(a.reason).toMatch(/^1 free slot on the live sessions' draw/);
	});

	it("clamps memory less a reserve larger than it at 0", () => {
		const a = admissionFrom({ ok: true, mb: 500 }, one, {
			host,
			overhead: { ok: true, mb: 800 },
		});
		expect(a.budgetMb).toBe(-HELD);
		expect(a.reason).toMatch(
			new RegExp(
				`^-${HELD} MB available after reserving 800 MB for the spare pool`,
			),
		);
	});

	it("reports freeSlots before the guarantee, which admits on its own branch", () => {
		const a = admissionFrom(
			{ ok: true, mb: 100 },
			{ ok: true, sessions: 0 },
			{ host },
		);
		expect(a.freeSlots).toBe(0);
		expect(a.admit).toBe(true);
		expect(a.reason).toMatch(/^no session is running, so one is admitted/);
	});
});

describe("the Windows limbs, read off the machine (#4956)", () => {
	const GuestFree = 541;

	it("charges the guest free memory a fresh Windows reading cannot back, and prints it", () => {
		const m = { mb: 4000, windowsMb: 950 };
		const { json } = run(m);
		expect(json.windowsChargeMb).toBe(GuestFree - 200);
		expect(json.guestFreeMb).toBe(GuestFree);
		expect(json.budgetMb).toBe(run({ mb: 4000 }).json.budgetMb - 341);
		expect(run({ ...m, json: false }).stdout).toMatch(
			/windows memory {5}950 MB free on Windows \(memwatch, \d+ s old\), 200 MB above its 750 MB floor, against 541 MB free in the guest that it does not yet back, so 341 MB comes off the budget \(#4956\)/,
		);
	});

	it("charges nothing with no memwatch, or with Windows backing all the guest's free memory", () => {
		expect(run({ mb: 4000 }).json.windowsChargeMb).toBe(0);
		expect(run({ mb: 4000, windowsMb: 3000 }).json.windowsChargeMb).toBe(0);
	});

	it("holds every slot while a queued test run is held on Windows memory", () => {
		const q = path.join(dir, "tmp", "wfc-suite-queue");
		fs.mkdirSync(q, { recursive: true });
		fs.writeFileSync(
			path.join(q, `wfc-suite-queue-${process.pid}.json`),
			JSON.stringify({ pid: process.pid, at: Date.now(), windowsHeld: true }),
		);
		const { json, status } = run({ mb: 6000, sessions: [SELF, "other"] });
		expect(json.testsHeld).toBe(1);
		expect(json.slots).toBe(0);
		expect(json.memorySlots).toBeGreaterThan(0);
		expect(json.admit).toBe(false);
		expect(status).toBe(1);
	});
});

describe("buildWindowsLine (#4956)", () => {
	const fresh = { state: "fresh" as const, mb: 550, ageS: 30 };

	it("words Windows under its floor as a shortfall", () => {
		expect(
			buildWindowsLine({
				windows: fresh,
				guestFreeMb: 300,
				windowsChargeMb: 300,
			}),
		).toBe(
			"550 MB free on Windows (memwatch, 30 s old), 200 MB under its 750 MB floor, against 300 MB free in the guest that it does not yet back, so 300 MB comes off the budget (#4956)",
		);
	});

	it("names an unread guest and a stale reading, and is silent with no memwatch", () => {
		expect(
			buildWindowsLine({
				windows: fresh,
				guestFreeMb: null,
				windowsChargeMb: 0,
			}),
		).toBe(
			"550 MB free on Windows, the guest's free memory unread, so nothing is charged against it",
		);
		expect(
			buildWindowsLine({
				windows: { state: "stale", why: "old" },
				guestFreeMb: 300,
				windowsChargeMb: 0,
			}),
		).toBe("Windows memory unread — old; sessions not held on it (#4557)");
		expect(
			buildWindowsLine({
				windows: { state: "absent" },
				guestFreeMb: 300,
				windowsChargeMb: 0,
			}),
		).toBeNull();
	});
});

describe("the type-check reserve (#5703)", () => {
	const Tsc = 1497;
	const pid = String(process.pid);
	const big = {
		mb: 9000,
		sessions: [SELF, GROWN],
		pss: GROWN_PSS,
	};

	it("holds none where no type-check is queued or running", () => {
		expect(run(big).json.typecheckReserveMb).toBe(0);
	});

	it("holds a queued type-check's charge, less the live sessions' suite share", () => {
		const without = run(big).json;
		const { json } = run({
			...big,
			typechecks: [{ pid: process.pid, chargeMb: Tsc }],
		});
		expect(json.typecheckReserveMb).toBe(Tsc - 147);
		expect(json.budgetMb).toBe(without.budgetMb - json.typecheckReserveMb);
	});

	it("holds a running type-check's charge less the PSS its tree already holds", () => {
		const queued = run({
			...big,
			typechecks: [{ pid: process.pid, chargeMb: Tsc }],
		}).json;
		const { json } = run({
			...big,
			typechecks: [{ pid: process.pid, chargeMb: Tsc, spawned: true }],
			pss: { ...GROWN_PSS, "9001": mbKb(600) },
			parents: { "9001": pid },
		});
		expect(json.typecheckReserveMb).toBe(queued.typecheckReserveMb - 600);
	});

	it("holds the full charge for a type-check a session started, whose PSS the session's draw already counts", () => {
		const queued = run({
			...big,
			typechecks: [{ pid: process.pid, chargeMb: Tsc }],
		}).json;
		const { json } = run({
			...big,
			typechecks: [{ pid: process.pid, chargeMb: Tsc, spawned: true }],
			pss: { ...GROWN_PSS, "9001": mbKb(600) },
			parents: { [pid]: "701", "9001": pid },
		});
		expect(json.typecheckReserveMb).toBe(queued.typecheckReserveMb);
	});

	it("charges a memory-held type-check once, by the held-run reserve", () => {
		const { json } = run({
			...big,
			typechecks: [{ pid: process.pid, chargeMb: Tsc, memoryHeld: true }],
		});
		expect(json.typecheckReserveMb).toBe(0);
		expect(json.heldRunMb).toBe(Tsc);
	});

	it("holds none for a dead type-check's marker", () => {
		expect(
			run({ ...big, typechecks: [{ pid: 2 ** 22 + 1, chargeMb: Tsc }] }).json
				.typecheckReserveMb,
		).toBe(0);
	});
});

describe("selectionAdmission, pick-next.js's readings and verdict", () => {
	afterEach(() => vi.unstubAllEnvs());

	const machine = (
		m: Machine = {},
		heldRuns: { pid: number; chargeMb: number; rungMb?: number }[] = [],
	) => {
		for (const [k, v] of Object.entries({
			...machineEnv(m),
			WFC_ORACLE_CACHE: "0",
		}))
			vi.stubEnv(k, v);
		const r = selectionAdmission({
			listed: admissionSessionIds(),
			reclaimable: { ok: true, count: 0 },
			reserves: {
				landers: readLiveLanders(),
				gates: readLiveGateSeats(),
				heldRuns,
				typechecks: readLiveTypechecks(),
				testsHeld: 0,
			},
		});
		return r;
	};
	const idleSpare =
		"111 605000 claude bg-spare --bg-spare /tmp/x/spare/abc.claim.sock";

	it("holds one held-run reserve, the largest of each run's charge and its rung less the floor and margin, never a sum (#5555)", () => {
		const without = machine({ mb: 9000 }).admission;
		const { admission } = machine({ mb: 9000 }, [
			{ pid: 1, chargeMb: 1929, rungMb: 3350 },
			{ pid: 2, chargeMb: 1200 },
		]);
		expect(Number(without.budgetMb) - Number(admission.budgetMb)).toBe(
			3350 - HELD,
		);
	});

	it("counts live sessions off the listing, never an orphaned host `ps` still shows", () => {
		const host = (id: string) =>
			`claude /home/u/.local/bin/claude bg-pty-host --session ${id}`;
		const { procs } = machine({
			sessions: [SELF, "a"],
			psLines: [host("a"), host("gone-1"), host("gone-2"), host("gone-3")],
		});
		expect(procs).toMatchObject({ ok: true, sessions: 1, processes: 4 });
	});

	it("subtracts this run's own session, so with no other session and a daemon and host running it admits one however tight the memory", () => {
		const { procs, admission } = machine({
			mb: 50,
			sessions: [SELF],
			psLines: [
				"claude claude daemon run --origin transient",
				"claude /home/lucmo/.local/bin/claude agents",
			],
		});
		expect(procs).toMatchObject({ ok: true, sessions: 0 });
		expect(admission.admit).toBe(true);
		expect(admission.reason).toMatch(/^no session is running/);
	});

	it("counts the bare-name, `claude.exe`, launcher-path and resumed versioned-binary shapes, and nothing else", () => {
		const { procs } = machine({
			psLines: [
				"claude claude",
				"claude.exe /usr/bin/claude.exe",
				"2.1.233 /home/lucmo/.local/bin/claude daemon run",
				"2.1.234 /home/lucmo/.local/share/claude/versions/2.1.234 --resume /home/lucmo/.claude/projects/p/s.jsonl",
				"2.1.234 /opt/acme/versions/2.1.234 --resume nothing-of-ours",
				"node node scripts/pick-next.js",
				"clauded clauded --not-ours",
			],
		});
		expect(procs.processes).toBe(4);
	});

	it("takes a lone listed session for this one where no session id is set, and admits one", () => {
		const { procs, admission } = machine({
			mb: 50,
			self: "",
			sessions: ["whoever"],
		});
		expect(procs).toMatchObject({ ok: true, sessions: 0 });
		expect(admission.admit).toBe(true);
		expect(admission.reason).toMatch(/^no session is running/);
	});

	it("subtracts nothing from several listed sessions where no session id is set", () => {
		const { procs } = machine({ self: "", sessions: ["a", "b", "c"] });
		expect(procs).toMatchObject({ ok: true, sessions: 3 });
	});

	it("charges a young neighbour the draw it has yet to reach (#2221)", () => {
		const { admission } = machine({
			sessions: [SELF, "a@601"],
			pss: { "601": mbKb(300) },
		});
		expect(admission.drawNeedMb).toBe(629);
	});

	it("reserves one idle spare pair and the pair a launch warms, shrinking the free slots, and says so", () => {
		const bare = machine({ mb: 4000, sessions: [SELF, "a"] });
		const { admission } = machine({
			mb: 4000,
			sessions: [SELF, "a"],
			psLines: [idleSpare],
			cwds: idleAt("111"),
		});
		expect(admission.reservedMb).toBe(1180);
		expect(admission.reservedError).toBeNull();
		expect(admission.freeSlots).toBeLessThan(Number(bare.admission.freeSlots));
		expect(admission.reason).toMatch(/reserving 1180 MB for the spare pool/);
	});

	it("reserves no claimed spare, a live session's own, falling back to the measured pair", () => {
		const { admission } = machine({
			mb: 4000,
			sessions: [SELF, "other@111"],
			psLines: [idleSpare],
		});
		expect(admission.reservedMb).toBe(2 * PAIR);
	});

	it("names the reservation in the always-admit-one reason too", () => {
		const { admission } = machine({
			mb: 4000,
			sessions: [SELF],
			psLines: [idleSpare],
			cwds: idleAt("111"),
		});
		expect(admission.freeSlots).toBe(1);
		expect(admission.reason).toMatch(
			/no session is running, so one is admitted whatever the headroom after reserving 1180 MB for the spare pool/,
		);
	});

	it("reports the reservation unreadable, never silently zero, where the overhead scan fails", () => {
		const { admission } = machine({ sessions: [SELF, "a"], psFails: true });
		expect(admission.reservedMb).toBe(0);
		expect(admission.reservedError).toEqual(expect.any(String));
	});

	it("prints an unreadable session reading in the breakdown as unknown, and the remainder with it, never 0", () => {
		const { memory } = machine({
			sessions: [SELF, "a@301"],
			states: { a: "working" },
		});
		const lines = buildMemoryBreakdownLines(memory).join("\n");
		expect(lines).toMatch(
			/^ {2}live {13}unknown \(pid 301's smaps_rollup unreadable\)/m,
		);
		expect(lines).toMatch(
			/^ {2}everything else {2}unknown \(a row above it is unknown\)/m,
		);
	});
});

describe("the session ceiling (#2141)", () => {
	const roomy = 20_000;
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

describe("the pending-spare reserve (mantahostels#2588)", () => {
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
		expect(json.reservedMb).toBe(390 + 390);
	});

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
		const grown = {
			mb: 3300 + 390 + HELD,
			sessions: [SELF, GROWN],
			...twoIdlePairs,
			pss: { ...twoIdlePairs.pss, ...GROWN_PSS },
		};
		const without = run(grown);
		const launching = run({ ...grown, args: ["--launch"] });
		expect(without.json.slots).toBe(4);
		expect(launching.json.slots).toBe(2);
	});

	it("charges each slot past the first its own pending pair (#2511)", () => {
		const { json } = run({
			mb: 3300 + 390 + HELD,
			sessions: [SELF, GROWN],
			...twoIdlePairs,
			pss: { ...twoIdlePairs.pss, ...GROWN_PSS },
			args: ["--launch"],
		});
		expect(json.budgetMb).toBe(2910);
		expect(json.nextNeedMb).toBe(2418 + 2 * 390);
		expect(json.slots).toBe(2);
		expect(json.reason).toMatch(
			/the live sessions' draw and 2 more, with 1 more spare pair\(s\) at 390 MB, need 2120 MB/,
		);
	});
});

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
		expect(m.totalMb).toBe(10_000);
		expect(m.free).toEqual({ mb: 6000, unknown: null });
		expect(m.live).toEqual({ count: 2, mb: 957, unknown: null });
		expect(m.finished).toMatchObject({ count: 1, mb: 410, reapable: 1 });
		expect(m.pool).toEqual({ mb: 400, unknown: null, drift: [] });
		expect(m.other.mb).toBe(10_000 - 6000 - 957 - 410 - 400);
		expect(m.free.mb + m.live.mb + m.finished.mb + m.pool.mb + m.other.mb).toBe(
			m.totalMb,
		);
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
			/ {2}live {13}unknown \(pid 301's smaps_rollup unreadable\)/,
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
		const s = scenarios.admit;
		const r = runScenario(
			{ ...s, pss: { ...s.pss, "201": 5_000_000 } },
			{ json: true },
		);
		const m = JSON.parse(r.stdout).memory;
		expect(m.other.mb).toBe(0);
		expect(m.other.overlapMb).toBeGreaterThan(0);
		expect(m.free.mb + m.live.mb + m.finished.mb + m.pool.mb).toBe(
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
