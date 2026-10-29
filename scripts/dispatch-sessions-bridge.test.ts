// @vitest-environment node
/*
 * Pins the dispatch's interop-bridge probe (mantahostels#3111): a wedged Windows
 * bridge refuses the set, or the rest of it, before a launch hangs on it.
 *
 * Loosen a test here and a set launches into a wedged bridge, and hangs.
 *
 * Over the run-cost budget (base §X8 (5)) by inheritance: its cases moved
 * unchanged from dispatch-sessions.test.ts, whose cost was pre-existing (#2413).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAuthStatusBranch } from "./lib/auth-status-fake";
import {
	agentsListing,
	dispatchFixture,
	writeCache,
} from "./lib/dispatch-sessions-testkit";
import { buildUsageBranch } from "./lib/usage-probe-fake";

const fx = dispatchFixture();
const { stubClaude, stubPath, launchArgv, readArgvLines, regWedged, run } = fx;

describe("the interop-bridge probe (mantahostels#3111)", () => {
	/** A reg.exe that never answers. */
	it("refuses the whole call, with the recovery text, and launches nothing", () => {
		stubClaude({});
		const r = run(["sonnet", "/implement 341", "opus", "/wayfinder 1114"], {
			CLAUDE_INTEROP_REG: regWedged(),
			CLAUDE_INTEROP_PROBE_TIMEOUT: "1",
		});
		expect(r.code).toBe(5);
		expect(r.stderr).toContain("interop bridge is wedged");
		expect(r.stderr).toContain("wsl --shutdown");
		// Not one `claude` call of any kind — the probe precedes even the
		// `/usage` read, whose own 120s ceiling would otherwise set the wait.
		expect(readArgvLines()).toEqual([]);
	});

	it("records nothing to the dispatch ledger", () => {
		stubClaude({});
		run(["sonnet", "/implement 341"], {
			CLAUDE_INTEROP_REG: regWedged(),
			CLAUDE_INTEROP_PROBE_TIMEOUT: "1",
		});
		const ledger = path.join(
			fx.dir,
			".claude",
			"tmp",
			"markers",
			".pick-next",
			"dispatched.jsonl",
		);
		expect(fs.existsSync(ledger)).toBe(false);
	});

	it("re-probes before each member, catching a bridge that wedges mid-set", () => {
		stubClaude({});
		// Healthy for the run's opening probe, wedged from the next call on.
		const at = path.join(fx.dir, "reg-wedges-later");
		const counter = path.join(fx.dir, "reg-calls");
		fs.writeFileSync(
			at,
			[
				"#!/bin/bash",
				`printf 'x' >> "${counter}"`,
				`n=$(wc -c < "${counter}")`,
				'if [ "$n" -le 1 ]; then exit 1; fi',
				"sleep 600",
			].join("\n"),
			{ mode: 0o755 },
		);
		const r = run(["sonnet", "/implement 341"], {
			CLAUDE_INTEROP_REG: at,
			CLAUDE_INTEROP_PROBE_TIMEOUT: "1",
		});
		expect(r.code).toBe(5);
		expect(r.stderr).toContain("interop bridge is wedged");
		expect(launchArgv()).toBeUndefined();
		const ledger = path.join(
			fx.dir,
			".claude",
			"tmp",
			"markers",
			".pick-next",
			"dispatched.jsonl",
		);
		expect(fs.existsSync(ledger)).toBe(false);
	});

	it("refuses inside 45s at the shipped probe budget", {
		timeout: 90_000,
	}, () => {
		stubClaude({});
		const started = Date.now();
		const r = run(["sonnet", "/implement 341"], {
			CLAUDE_INTEROP_REG: regWedged(),
		});
		expect(r.code).toBe(5);
		// §X9: a process timeout: the shipped probe budget is the guarantee, and it bounds a real hung child.
		expect(Date.now() - started).toBeLessThan(45_000);
	});

	// The fault mantahostels#3306 fixed: the bridge's vsock accept times out per call at
	// about 10s and the NEXT call answers normally.
	it("launches through a transient stall rather than calling it a wedge", () => {
		stubClaude({});
		const at = path.join(fx.dir, "reg-stalls-once");
		const counter = path.join(fx.dir, "reg-stall-calls");
		fs.writeFileSync(
			at,
			[
				"#!/bin/bash",
				`printf 'x' >> "${counter}"`,
				`n=$(wc -c < "${counter}")`,
				// Attempts 1 and 2 stall past the budget; attempt 3 answers.
				'if [ "$n" -le 2 ]; then sleep 600; fi',
				"exit 1",
			].join("\n"),
			{ mode: 0o755 },
		);
		const r = run(["sonnet", "/implement 341"], {
			CLAUDE_INTEROP_REG: at,
			CLAUDE_INTEROP_PROBE_TIMEOUT: "1",
		});
		expect(r.code).toBe(0);
		expect(r.stderr).not.toContain("interop bridge is wedged");
		expect(launchArgv()).toContain("--bg");
	});

	it("launches as before on a healthy bridge, saying nothing extra", () => {
		stubClaude({});
		// A fresh allowance cache, so the per-spawn re-read (#294) has nothing
		// to warn about here — this case pins what the interop probe adds, not
		// the allowance warning line, which has its own coverage above.
		const configDir = path.join(fx.dir, "fresh-config");
		writeCache(configDir, { session: 12, weeklyAll: 3 });
		const r = run(["sonnet", "/implement 341"], {
			CLAUDE_CONFIG_DIR: configDir,
		});
		expect(r.code).toBe(0);
		expect(launchArgv()).toContain("--bg");
		// Whole output, not a `not.toContain("interop")`: the probe must add
		// NOTHING to what this script already prints, and a new line worded
		// around the word would pass a substring check (mantahostels#3127). The cost is that
		// this pins the allowance and advisor lines, which nothing else pins
		// exactly — reword either and this case fails from over here.
		expect(r.stdout).toBe(
			"Allowance OK: week 3%, session 12%.\n" +
				"Advisor not checked: no /usage probe ran to report it.\n" +
				"sonnet  launched\n",
		);
		expect(r.stderr).toBe("OK: no issue in this set is already dispatched\n");
	});

	it("fails open where the probe cannot run at all", () => {
		stubClaude({});
		const r = run(["sonnet", "/implement 341"], {
			// No such file — a non-WSL machine.
			CLAUDE_INTEROP_REG: path.join(fx.dir, "no-such-reg"),
		});
		expect(r.code).toBe(0);
		expect(launchArgv()).toContain("--bg");
	});

	it("reads a TERM-ignoring wedge as a wedge, not as a healthy answer", () => {
		stubClaude({});
		// `timeout -k` escalates to KILL when the target ignores the TERM, and
		// that exits 137 rather than 124 — the shape a wedged bridge takes if it
		// is stuck in the kernel rather than merely slow (mantahostels#3111).
		const at = path.join(fx.dir, "reg-ignores-term");
		fs.writeFileSync(at, '#!/bin/bash\ntrap "" TERM\nsleep 600\n', {
			mode: 0o755,
		});
		const r = run(["sonnet", "/implement 341"], {
			CLAUDE_INTEROP_REG: at,
			CLAUDE_INTEROP_PROBE_TIMEOUT: "1",
		});
		expect(r.code).toBe(5);
		expect(r.stderr).toContain("interop bridge is wedged");
		expect(readArgvLines()).toEqual([]);
	});

	it("names the members already launched when the bridge wedges mid-set", () => {
		stubClaude({});
		// Healthy for the opening probe and the first member's, wedged from the
		// third call on. The first member is launched AND recorded, so telling the
		// founder nothing was recorded would walk them into the duplicate gate on
		// a re-run (mantahostels#3111).
		const at = path.join(fx.dir, "reg-wedges-after-one");
		const counter = path.join(fx.dir, "reg-calls-2");
		fs.writeFileSync(
			at,
			[
				"#!/bin/bash",
				`printf 'x' >> "${counter}"`,
				`n=$(wc -c < "${counter}")`,
				'if [ "$n" -le 2 ]; then exit 1; fi',
				"sleep 600",
			].join("\n"),
			{ mode: 0o755 },
		);
		const r = run(["sonnet", "/implement 341", "opus", "/wayfinder 1114"], {
			CLAUDE_INTEROP_REG: at,
			CLAUDE_INTEROP_PROBE_TIMEOUT: "1",
		});
		expect(r.code).toBe(5);
		expect(r.stderr).toContain("1 member(s) HAD already launched");
		expect(r.stderr).toContain("/implement 341");
		expect(r.stderr).not.toContain("Nothing was recorded as dispatched");
		const ledger = path.join(
			fx.dir,
			".claude",
			"tmp",
			"markers",
			".pick-next",
			"dispatched.jsonl",
		);
		expect(fs.readFileSync(ledger, "utf8")).toContain("/implement 341");
	});

	it("fails open where reg.exe exists but is not executable", () => {
		stubClaude({});
		const at = path.join(fx.dir, "reg-not-executable");
		fs.writeFileSync(at, "#!/bin/bash\nsleep 600\n", { mode: 0o644 });
		const r = run(["sonnet", "/implement 341"], { CLAUDE_INTEROP_REG: at });
		expect(r.code).toBe(0);
		expect(launchArgv()).toContain("--bg");
	});

	it("leaves the interactive guard a pass-through on a library that will not load", () => {
		// scripts/claude-interop-guard.sh sources the same library and defines the
		// `claude` shell function around it. A broken library must degrade it to
		// `command claude "$@"`, never to a refusal (mantahostels#3111).
		const shadow = path.join(fx.dir, "guard");
		fs.mkdirSync(path.join(shadow, "lib"), { recursive: true });
		fs.copyFileSync(
			path.resolve(__dirname, "claude-interop-guard.sh"),
			path.join(shadow, "claude-interop-guard.sh"),
		);
		fs.writeFileSync(
			path.join(shadow, "lib", "interop-probe.sh"),
			"if then fi\n",
		);
		const onPath = path.join(fx.dir, "onpath");
		fs.mkdirSync(onPath, { recursive: true });
		fs.writeFileSync(
			path.join(onPath, "claude"),
			"#!/bin/bash\nprintf 'real binary ran\\n'\n",
			{ mode: 0o755 },
		);
		const r = spawnSync(
			"bash",
			[
				"-c",
				`source "${path.join(shadow, "claude-interop-guard.sh")}"; claude --version`,
			],
			{
				encoding: "utf8",
				// claude-route-exempt: the user-shell wrapper runs PATH's `claude`
				env: { ...process.env, PATH: `${onPath}:${process.env.PATH}` },
			},
		);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("real binary ran");
	});

	it("kills and reports a launch that hangs past the ceiling", () => {
		// Answers the `/usage` probe normally and hangs only on the spawn, so the
		// case exercises the launch ceiling rather than the 120s usage timeout.
		const at = stubPath();
		fs.writeFileSync(
			at,
			[
				"#!/bin/bash",
				buildAuthStatusBranch(),
				`printf '%s\\n' "$*" >> "${path.join(fx.dir, "argv")}"`,
				'for a in "$@"; do',
				'  if [ "$a" = "--bg" ]; then sleep 600; fi',
				"done",
				'log=""',
				'prev=""',
				'for a in "$@"; do',
				'  if [ "$prev" = "--debug-file" ]; then log="$a"; fi',
				'  prev="$a"',
				"done",
				'if [ -n "$log" ]; then',
				'  printf "[DEBUG] [AdvisorTool] Advisor model: opus\\n" > "$log"',
				buildUsageBranch({ session: 12, week: 3 }),
				"  exit 0",
				"fi",
				`if [ "$1" = "agents" ]; then printf '%s\\n' '${agentsListing()}'; exit 0; fi`,
				"printf 'launched\\n'",
			].join("\n"),
			{ mode: 0o755 },
		);
		const r = run(["sonnet", "/implement 341"], {
			WFC_DISPATCH_LAUNCH_TIMEOUT: "1",
		});
		expect(r.code).toBe(5);
		expect(r.stderr).toContain("did not return within 1s");
		const ledger = path.join(
			fx.dir,
			".claude",
			"tmp",
			"markers",
			".pick-next",
			"dispatched.jsonl",
		);
		expect(fs.existsSync(ledger)).toBe(false);
	});
});
