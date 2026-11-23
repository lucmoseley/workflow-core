#!/usr/bin/env node

const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { configDirs } = require("./lib/arbiter-store");
const { claudeBin } = require("./lib/claude-bin.js");
const { flagValue, parseOrCode } = require("./lib/cli-args");
const { forgetRoots } = require("./lib/inherited-roots.js");
const { launchAuthRefusal } = require("./lib/launch-auth.js");
const { requiredGroup } = require("./lib/regex-group");
const { readParentOf } = require("./lib/proc-stat.js");
const { procRoot } = require("./lib/proc-root.js");

const SAMPLE_MS = 250;
const STABLE_SAMPLES = 6;
const STABLE_MB = 2;
const DEFAULT_TIMEOUT_S = 900;

const SPAWN_LINE = /^\[([^\]]+)\].*bg spare spawned host pid=(\d+)/;

function daemonLogs() {
	return configDirs()
		.map((d) => path.join(d, "daemon.log"))
		.filter((f) => {
			try {
				return fs.statSync(f).isFile();
			} catch {
				return false;
			}
		});
}

/** @param {number} pid */
function readRssMb(pid) {
	try {
		const statm = fs
			.readFileSync(`${procRoot()}/${pid}/statm`, "utf8")
			.split(/\s+/);
		return Math.round((Number(statm[1]) * 4096) / (1024 * 1024));
	} catch {
		return null;
	}
}

/**
 * @param {number} pid
 * @returns {number[]}
 */
function readChildrenOf(pid) {
	/** @type {number[]} */
	const kids = [];
	let entries;
	try {
		entries = fs.readdirSync(procRoot());
	} catch {
		return kids;
	}
	for (const e of entries) {
		if (!/^\d+$/.test(e)) continue;
		if (readParentOf(e) === pid) kids.push(Number(e));
	}
	return kids;
}

/**
 * @param {number} hostPid
 * @returns {number | null}
 */
function pairRssMb(hostPid) {
	const host = readRssMb(hostPid);
	if (host === null) return null;
	let total = host;
	for (const kid of readChildrenOf(hostPid)) {
		const mb = readRssMb(kid);
		if (mb !== null) total += mb;
	}
	return total;
}

const sleep = (/** @type {number} */ ms) =>
	new Promise((r) => setTimeout(r, ms));

/** @param {number} deadline */
async function nextSpawn(deadline) {
	const offsets = readStartOffsets();
	if (offsets.size === 0) return null;
	/** @type {Tails} */
	const tails = { offsets, partial: new Map(), vanished: new Set() };
	while (Date.now() < deadline) {
		for (const [f, from] of offsets) {
			const spawned = pollLog(tails, f, from);
			if (spawned) return spawned;
		}
		await sleep(SAMPLE_MS);
	}
	return null;
}

/** @returns {Map<string, number>} */
function readStartOffsets() {
	const offsets = new Map();
	for (const f of daemonLogs()) {
		try {
			offsets.set(f, fs.statSync(f).size);
		} catch {
			offsets.set(f, 0);
		}
	}
	return offsets;
}

/** @typedef {{ offsets: Map<string, number>, partial: Map<string, string>, vanished: Set<string> }} Tails */

/**
 * @param {Tails} tails
 * @param {string} f
 * @param {number} from
 * @returns {{ pid: number, at: number, log: string } | null}
 */
function pollLog(tails, f, from) {
	const size = readCurrentSize(tails.vanished, f);
	if (size === null) return null;
	tails.vanished.delete(f);
	if (size < from) {
		tails.offsets.set(f, size);
		return null;
	}
	if (size === from) return null;
	const text = readSpan(f, from, size);
	tails.offsets.set(f, size);
	const lines = ((tails.partial.get(f) || "") + text).split("\n");
	tails.partial.set(f, lines.pop() ?? "");
	return firstSpawn(lines, f);
}

/**
 * @param {Set<string>} vanished
 * @param {string} f
 * @returns {number | null}
 */
function readCurrentSize(vanished, f) {
	try {
		return fs.statSync(f).size;
	} catch {
		if (!vanished.has(f)) {
			vanished.add(f);
			writeFd(2, `daemon log gone mid-watch, no longer read: ${f}\n`);
		}
		return null;
	}
}

/**
 * @param {string} f
 * @param {number} from
 * @param {number} size
 */
function readSpan(f, from, size) {
	const fd = fs.openSync(f, "r");
	try {
		const buf = Buffer.alloc(size - from);
		const got = fs.readSync(fd, buf, 0, size - from, from);
		return buf.subarray(0, got).toString("utf8");
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * @param {string[]} lines
 * @param {string} f
 */
function firstSpawn(lines, f) {
	for (const line of lines) {
		const m = line.match(SPAWN_LINE);
		if (!m) continue;
		const at = Date.parse(requiredGroup(m, 1, SPAWN_LINE));
		if (Number.isNaN(at)) continue;
		return { pid: Number(m[2]), at, log: f };
	}
	return null;
}

/**
 * @param {number} pid
 * @param {number} spawnedAt
 * @param {number} deadline
 */
async function timeToPlateau(pid, spawnedAt, deadline) {
	/** @type {{t: number, mb: number}[]} */
	const samples = [];
	let steady = 0;
	while (Date.now() < deadline) {
		const mb = pairRssMb(pid);
		if (mb === null)
			return { verdict: "gone", samples, seconds: null, plateauMb: null };
		samples.push({ t: Date.now(), mb });
		const prev = samples.at(-2);
		steady = prev && Math.abs(mb - prev.mb) <= STABLE_MB ? steady + 1 : 0;
		if (steady >= STABLE_SAMPLES) {
			const first = samples.at(-1 - steady);
			if (first === undefined)
				throw new Error(
					`${steady} steady samples counted from only ${samples.length}`,
				);
			return {
				verdict: "plateau",
				samples,
				seconds: (first.t - spawnedAt) / 1000,
				plateauMb: mb,
			};
		}
		await sleep(SAMPLE_MS);
	}
	const last = samples.at(-1);
	return {
		verdict: "timeout",
		samples,
		seconds: null,
		plateauMb: last === undefined ? null : last.mb,
	};
}

const PROBE_PROMPT = "Reply with the single word ok. Do nothing else.";

function launchProbe(/** @type {string} */ prompt) {
	const bin = claudeBin();
	const env = { ...process.env };
	forgetRoots(env);
	const child = spawn(bin, ["--bg", prompt], { stdio: "ignore", env });
	child.unref();
	return bin;
}

const USAGE =
	"usage: node scripts/measure-spare-warm.js (--watch | --probe) [--timeout-seconds <n>] [--prompt <text>] [--json]";

async function main() {
	const code = await runMain();
	process.exitCode = code;
	return code;
}

/** @returns {number | { json: boolean, probe: boolean, timeoutS: number, prompt: string }} */
function readOptions() {
	const parsed = parseOrCode(process.argv.slice(2), {
		usage: USAGE,
		flags: {
			"--watch": "boolean",
			"--probe": "boolean",
			"--json": "boolean",
			"--timeout-seconds": "value",
			"--prompt": "value",
		},
	});
	if (typeof parsed === "number") return parsed;
	const { flags } = parsed;
	const json = flags["--json"] === true;
	const probe = flags["--probe"] === true;
	const watch = flags["--watch"] === true;
	if (probe === watch) {
		writeFd(2, `${USAGE}\n`);
		return 2;
	}
	const timeoutS = Number(
		flagValue(flags, "--timeout-seconds") ?? String(DEFAULT_TIMEOUT_S),
	);
	if (!Number.isFinite(timeoutS) || timeoutS <= 0) {
		writeFd(2, "--timeout-seconds must be a positive number.\n");
		return 2;
	}
	const prompt = flagValue(flags, "--prompt") ?? PROBE_PROMPT;
	return { json, probe, timeoutS, prompt };
}

async function runMain() {
	const opts = readOptions();
	if (typeof opts === "number") return opts;
	const { json, probe, timeoutS, prompt } = opts;
	const logs = daemonLogs();
	if (logs.length === 0) {
		writeFd(
			2,
			"no daemon.log under any config dir, so no spare spawn can be seen here.\n",
		);
		return 2;
	}
	if (probe) {
		const refusal = launchAuthRefusal({
			bin: claudeBin(),
			env: process.env,
			cwd: process.cwd(),
			bg: true,
		});
		if (refusal) {
			writeFd(2, `REFUSED: ${refusal}\n`);
			return 2;
		}
	}
	const deadline = Date.now() + timeoutS * 1000;

	const pending = nextSpawn(deadline);
	let probeBin = null;
	if (probe) probeBin = launchProbe(prompt);

	const spawned = await pending;
	if (!spawned) {
		const line = `no spare was spawned within ${timeoutS}s${
			probe ? " — the probe launch caused none, so it may not have started" : ""
		}.\n`;
		writeFd(2, line);
		return 1;
	}
	const result = await timeToPlateau(spawned.pid, spawned.at, deadline);
	const out = {
		pid: spawned.pid,
		log: spawned.log,
		spawnedAt: new Date(spawned.at).toISOString(),
		mode: probe ? "probe" : "watch",
		probeBin,
		verdict: result.verdict,
		secondsToPlateau: result.seconds,
		plateauMb: result.plateauMb,
		samples: result.samples.map((s) => ({
			atSeconds: (s.t - spawned.at) / 1000,
			mb: s.mb,
		})),
	};
	if (json) {
		writeFd(1, `${JSON.stringify(out, null, 2)}\n`);
	} else {
		writeText(out);
	}
	return result.verdict === "plateau" ? 0 : 1;
}

/**
 * @param {{ pid: number, log: string, spawnedAt: string, verdict: string, secondsToPlateau: number | null, plateauMb: number | null }} out
 */
function writeText(out) {
	const lines = [
		`pty-host pid       ${out.pid} (${path.basename(path.dirname(out.log))}) — timed with its bg-spare child`,
		`spawned            ${out.spawnedAt}`,
		`verdict            ${out.verdict}`,
		`seconds to plateau ${out.secondsToPlateau ?? "—"}`,
		`plateau RSS        ${out.plateauMb ?? "—"} MB (the pair)`,
		out.verdict === "plateau"
			? `  Set WFC_DISPATCH_STAGGER_SECONDS's default in scripts/lib/dispatch-sessions.js\n  from this, over several readings — one is a sample, not a figure.`
			: "  No plateau, so nothing here sets a default.",
	];
	writeFd(1, `${lines.join("\n")}\n`);
}

if (require.main === module)
	main().then(
		(code) => process.exit(code),
		(e) => {
			writeFd(2, `${e?.stack ? e.stack : String(e)}\n`);
			process.exit(2);
		},
	);

module.exports = { main };
