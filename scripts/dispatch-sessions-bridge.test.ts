// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAuthStatusBranch } from "./lib/auth-status-fake";
import { buildRecordedAnswer } from "./lib/bg-launch-fake";
import {
	agentsListing,
	dispatchFixture,
	writeCache,
} from "./lib/dispatch-sessions-testkit";
import { shellQuote } from "./lib/sh-quote.js";
import { buildUsageBranch } from "./lib/usage-probe-fake";

const JOB = "0b5e55ed";

const fx = dispatchFixture();
const {
	stubClaude,
	stubPath,
	launchArgv,
	readArgvLines,
	regWedged,
	run,
	runCore,
} = fx;

const ONE_SHORT_ATTEMPT = {
	CLAUDE_INTEROP_PROBE_TIMEOUT: "1",
	CLAUDE_INTEROP_PROBE_ATTEMPTS: "1",
};

describe("the interop-bridge probe (mantahostels#3111)", () => {
	it("refuses the whole call, with the recovery text, and launches nothing", async () => {
		stubClaude({});
		const r = await runCore(
			["sonnet", "/implement 341", "opus", "/wayfinder 1114"],
			{
				CLAUDE_INTEROP_REG: regWedged(),
				...ONE_SHORT_ATTEMPT,
			},
		);
		expect(r.code).toBe(5);
		expect(r.stderr).toContain("interop bridge is wedged");
		expect(r.stderr).toContain("wsl --shutdown");
		expect(readArgvLines()).toEqual([]);
	});

	it("records nothing to the dispatch ledger", async () => {
		stubClaude({});
		await runCore(["sonnet", "/implement 341"], {
			CLAUDE_INTEROP_REG: regWedged(),
			...ONE_SHORT_ATTEMPT,
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

	it("re-probes before each member, catching a bridge that wedges mid-set", async () => {
		stubClaude({});
		const at = path.join(fx.dir, "reg-wedges-later");
		const counter = path.join(fx.dir, "reg-calls");
		fs.writeFileSync(
			at,
			[
				"#!/bin/bash",
				`printf 'x' >> ${shellQuote(counter)}`,
				`n=$(wc -c < ${shellQuote(counter)})`,
				'if [ "$n" -le 1 ]; then exit 1; fi',
				"sleep 600",
			].join("\n"),
			{ mode: 0o755 },
		);
		const r = await runCore(["sonnet", "/implement 341"], {
			CLAUDE_INTEROP_REG: at,
			...ONE_SHORT_ATTEMPT,
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

	it("launches through a transient stall rather than calling it a wedge", async () => {
		stubClaude({});
		const at = path.join(fx.dir, "reg-stalls-once");
		const counter = path.join(fx.dir, "reg-stall-calls");
		fs.writeFileSync(
			at,
			[
				"#!/bin/bash",
				`printf 'x' >> ${shellQuote(counter)}`,
				`n=$(wc -c < ${shellQuote(counter)})`,
				'if [ "$n" -le 2 ]; then sleep 600; fi',
				"exit 1",
			].join("\n"),
			{ mode: 0o755 },
		);
		const r = await runCore(["sonnet", "/implement 341"], {
			CLAUDE_INTEROP_REG: at,
			CLAUDE_INTEROP_PROBE_TIMEOUT: "1",
		});
		expect(r.code).toBe(0);
		expect(r.stderr).not.toContain("interop bridge is wedged");
		expect(launchArgv()).toContain("--bg");
	});

	it("launches as before on a healthy bridge, saying nothing extra", async () => {
		stubClaude({ jobId: JOB });
		const configDir = path.join(fx.dir, "fresh-config");
		writeCache(configDir, { session: 12, weeklyAll: 3 });
		const r = await runCore(["haiku", "/implement 341"], {
			CLAUDE_CONFIG_DIR: configDir,
		});
		expect(r.code).toBe(0);
		expect(launchArgv()).toContain("--bg");
		expect(r.stdout).toBe(
			"Allowance OK: week 3%, session 12%.\n" +
				"Advisor not checked: no /usage probe ran to report it.\n" +
				`haiku  ${buildRecordedAnswer(JOB, "positional").stdout.split("\n")[0]}\n`,
		);
		expect(r.stderr).toBe("OK: no issue in this set is already dispatched\n");
	});

	it("fails open where the probe cannot run at all", async () => {
		stubClaude({});
		const r = await runCore(["sonnet", "/implement 341"], {
			CLAUDE_INTEROP_REG: path.join(fx.dir, "no-such-reg"),
		});
		expect(r.code).toBe(0);
		expect(launchArgv()).toContain("--bg");
	});

	it("reads a TERM-ignoring wedge as a wedge, not as a healthy answer", async () => {
		stubClaude({});
		const at = path.join(fx.dir, "reg-ignores-term");
		fs.writeFileSync(at, '#!/bin/bash\ntrap "" TERM\nsleep 600\n', {
			mode: 0o755,
		});
		const r = await runCore(["sonnet", "/implement 341"], {
			CLAUDE_INTEROP_REG: at,
			...ONE_SHORT_ATTEMPT,
		});
		expect(r.code).toBe(5);
		expect(r.stderr).toContain("interop bridge is wedged");
		expect(readArgvLines()).toEqual([]);
	});

	it("names the members already launched when the bridge wedges mid-set", async () => {
		stubClaude({});
		const at = path.join(fx.dir, "reg-wedges-after-one");
		const counter = path.join(fx.dir, "reg-calls-2");
		fs.writeFileSync(
			at,
			[
				"#!/bin/bash",
				`printf 'x' >> ${shellQuote(counter)}`,
				`n=$(wc -c < ${shellQuote(counter)})`,
				'if [ "$n" -le 2 ]; then exit 1; fi',
				"sleep 600",
			].join("\n"),
			{ mode: 0o755 },
		);
		const r = await runCore(
			["sonnet", "/implement 341", "opus", "/wayfinder 1114"],
			{
				CLAUDE_INTEROP_REG: at,
				...ONE_SHORT_ATTEMPT,
			},
		);
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

	it("fails open where reg.exe exists but is not executable", async () => {
		stubClaude({});
		const at = path.join(fx.dir, "reg-not-executable");
		fs.writeFileSync(at, "#!/bin/bash\nsleep 600\n", { mode: 0o644 });
		const r = await runCore(["sonnet", "/implement 341"], {
			CLAUDE_INTEROP_REG: at,
		});
		expect(r.code).toBe(0);
		expect(launchArgv()).toContain("--bg");
	});

	it("leaves the interactive guard a pass-through on a library that will not load", () => {
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
				`source ${shellQuote(path.join(shadow, "claude-interop-guard.sh"))}; claude --version`,
			],
			{
				encoding: "utf8",
				// claude-route-exempt: #3559
				env: { ...process.env, PATH: `${onPath}:${process.env.PATH}` },
			},
		);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("real binary ran");
	});

	it("kills and reports a launch that hangs past the ceiling", () => {
		const at = stubPath();
		fs.writeFileSync(
			at,
			[
				"#!/bin/bash",
				buildAuthStatusBranch(),
				`printf '%s\\n' "$*" >> ${shellQuote(path.join(fx.dir, "argv"))}`,
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
				`if [ "$1" = "agents" ]; then printf '%s\\n' ${shellQuote(agentsListing())}; exit 0; fi`,
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
