import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect } from "vitest";
import { ignoreFailure } from "./caught.js";
import { REAL_PROC } from "./proc-root.js";
import { isDead } from "./process-fixture";
import { shellQuote } from "./sh-quote.js";

const { TEST_TIMEOUT_MS } = require("./test-ceiling.js");

export const SCRIPT = join(__dirname, "..", "bg-run.sh");

export const FAST = {
	WFC_BG_HEARTBEAT_S: "1",
	WFC_BG_STALE_S: "2",
	WFC_BG_WAIT_POLL_S: "1",
	WFC_BG_MISSING_S: "1.5",
	WFC_BG_MISSING_POLL_S: "0.1",
};

// guess, #5143
export const QUICK_BEAT = { WFC_BG_HEARTBEAT_S: "0.25" };
export const QUICK_THREE_BEATS_S = 3 * Number(QUICK_BEAT.WFC_BG_HEARTBEAT_S);

export const TIGHT_MISSING = { WFC_BG_MISSING_S: "0.2" };

// guess, #2689
export const KILLED_LIFETIME_S = String(TEST_TIMEOUT_MS / 1000 + 30);

export function readProcessesUnder(dir: string) {
	const mark = `WFC_BG_ROOT=${dir}`;
	return readdirSync(REAL_PROC).filter((pid) => {
		if (!/^\d+$/.test(pid)) return false;
		try {
			return readFileSync(`${REAL_PROC}/${pid}/environ`, "utf8")
				.split("\0")
				.includes(mark);
		} catch {
			return false;
		}
	});
}

// env-write-exempt: #5540
process.env.WFC_READ_AUDIT_UNTRACED = "1";

export function env(extra: Record<string, string> = {}) {
	return {
		...process.env,
		WFC_BG_ROOT: root,
		// lucmoseley/mantahostels#2691
		WFC_BG_KILL_LOG: join(root, "kills.jsonl"),
		// lucmoseley/mantahostels#2763
		WFC_BG_LAUNCH_LOG: join(root, "launches.jsonl"),
		WFC_BG_POLL_LOG: join(root, "polls.log"),
		...FAST,
		...extra,
	};
}

// guess, #2675
export const BOUNDED = { timeout: 60_000, killSignal: "SIGKILL" } as const;

export function run(args: string[], extra: Record<string, string> = {}) {
	return spawnSync(SCRIPT, args, {
		env: env(extra),
		encoding: "utf8",
		...BOUNDED,
	});
}

export function check(name: string, extra: Record<string, string> = {}) {
	return run(["check", name], extra);
}

export function runWithout(drop: string[], args: string[]) {
	const clean: NodeJS.ProcessEnv = { ...env() };
	for (const key of drop) delete clean[key];
	return spawnSync(SCRIPT, args, { env: clean, encoding: "utf8", ...BOUNDED });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function readJsonLines(path: string) {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((l) => l.length > 0)
		.map((l) => JSON.parse(l));
}

export function readKillLines() {
	const path = join(root, "kills.jsonl");
	return existsSync(path) ? readJsonLines(path) : [];
}

export function runFile(name: string, file: string) {
	const path = join(root, name, file);
	return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
}

// guess, #2674
export const CEILING_MS = 20_000;
// guess, #5529
export const POLL_MS = 50;

export async function poll(ready: () => boolean, everyMs = POLL_MS) {
	const by = Date.now() + CEILING_MS;
	while (!ready() && Date.now() < by) await sleep(everyMs);
	return ready();
}

export async function waitFor(what: string, ready: () => boolean) {
	expect(await poll(ready), `timed out waiting for ${what}`).toBe(true);
}

export function shWaitFor(cond: string) {
	const tries = CEILING_MS / POLL_MS;
	return `i=0; until ${cond} || [ $i -ge ${tries} ]; do sleep ${POLL_MS / 1000}; i=$((i+1)); done`;
}

export const untilPublished = (name: string) =>
	waitFor(`${name}'s run to publish`, () => runFile(name, "token") !== "");

export const untilPrinted = (name: string, text: string) =>
	waitFor(`${name}'s command to print ${text}`, () =>
		runFile(name, "out").includes(text),
	);

export const republished = (name: string, oldToken: string) => () => {
	const token = runFile(name, "token");
	return token !== "" && token !== oldToken;
};

export function readWatcherPids(token: string) {
	return readdirSync(REAL_PROC).filter((pid) => {
		if (!/^\d+$/.test(pid)) return false;
		try {
			const argv = readFileSync(`${REAL_PROC}/${pid}/cmdline`, "utf8").split(
				"\0",
			);
			return argv.includes("__watch") && argv.includes(token);
		} catch {
			return false;
		}
	});
}

export function spawnDetached(args: string[], spawnEnv: NodeJS.ProcessEnv) {
	const child = spawn(SCRIPT, args, { env: spawnEnv, detached: true });
	if (child.pid === undefined) throw new Error("spawn did not return a pid");
	return { child, pid: child.pid };
}

export function pastStale() {
	const past = Math.floor(Date.now() / 1000) + Number(FAST.WFC_BG_STALE_S) + 2;
	return { WFC_BG_NOW: String(past) };
}

export async function untilVerdict(name: string) {
	const toucher = runFile(name, ".toucher");
	if (toucher !== "") {
		await waitFor(`${name}'s toucher to die`, () => isDead(Number(toucher)));
		return check(name, pastStale());
	}
	let got: ReturnType<typeof check> | undefined;
	await poll(() => {
		got = check(name);
		return got.status !== 2;
	}, 250); // guess, #5529
	return got as ReturnType<typeof check>;
}

export function expectMidCommand(name: string, pid: number | undefined) {
	expect(
		runFile(name, "status"),
		`${name}'s command had already finished before the kill`,
	).toBe("");
	expect(
		pid !== undefined && !isDead(pid),
		`${name}'s wrapper had already exited before the kill`,
	).toBe(true);
}

export const runsUntilFile = (go: string) =>
	shWaitFor(`[ -e ${shellQuote(go)} ]`);

export function parseFirstLine(stdout: string) {
	return stdout.split("\n")[0];
}

export const WIDE_MISSING = { WFC_BG_MISSING_S: "10" };

export function createDirLate(dir: string, withStatus: boolean) {
	const tmp = `${dir}.tmp`;
	const log = join(root, "polls.log");
	const cmds = [
		shWaitFor(`grep -qx missing ${shellQuote(log)} 2>/dev/null`),
		`mkdir -p ${shellQuote(tmp)}`,
		`: >${shellQuote(`${tmp}/beat`)}`,
		`: >${shellQuote(`${tmp}/out`)}`,
	];
	if (withStatus)
		cmds.push(`printf 'exit=0\\n' >${shellQuote(`${tmp}/status`)}`);
	cmds.push(`mv ${shellQuote(tmp)} ${shellQuote(dir)}`);
	spawn("sh", ["-c", cmds.join(" && ")], { stdio: "ignore" }).unref();
}

export let root: string;

export function bgRunRoot(): void {
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "bg-run-test-"));
	});

	afterEach(() => {
		for (const pid of readProcessesUnder(root)) {
			ignoreFailure(() => process.kill(Number(pid), "SIGKILL"));
		}
		rmSync(root, { recursive: true, force: true });
	});
}
