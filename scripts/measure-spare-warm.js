#!/usr/bin/env node
/*
 * measure-spare-warm.js — how long the daemon's replacement bg-spare takes to
 * become resident after a `claude --bg` launch claims one.
 *
 * WHAT IT IS FOR (mantahostels#2588). `dispatch-sessions.sh` sleeps
 * WFC_DISPATCH_STAGGER_SECONDS between launches so the NEXT member's
 * admission re-read counts the pair the previous member's launch caused. This
 * is the measurement behind that interval.
 *
 * THE EVENT IT KEYS OFF is the daemon's own log line, not a process scan:
 *   [<iso>] [bg] bg spare spawned host pid=<n>
 * written the moment a claim is served, ~15 ms after the `claimed-spare` line
 * above it. A `ps` sweep would find the same process a poll interval late and
 * could not say when it started; the log timestamp is exact.
 *
 * WHAT IT REPORTS is seconds from that line to the PAIR's RSS holding still —
 * STABLE_SAMPLES consecutive readings within STABLE_MB of each other.
 * A plateau, not a completion: a spare that is claimed mid-measurement keeps
 * growing and is reported as such rather than timed out silently.

 *
 * TWO MODES, AND ONLY ONE OF THEM IS FREE:
 *   --watch   waits for the next spawn ANY session on this machine causes and
 *             times it. Costs nothing and starts nothing.
 *   --probe   fires one `claude --bg` itself to cause the spawn. That is a real
 *             background session against a real allowance — a founder call,
 *             never something to run unasked (mantahostels#2553). Refused where
 *             its auth would not bill the subscription (lib/launch-auth.js).
 *
 * IT MEASURES, IT NEVER WRITES. Setting WFC_DISPATCH_STAGGER_SECONDS's
 * default from what this prints is a hand edit to dispatch-sessions.sh.
 *
 * Usage: `USAGE` below, which `--help` prints.
 *
 * Mutated at mantahostels#2588, four of them, each failing exactly its own test: timing the
 * logged host pid alone rather than the pair, which reports a plateau before
 * the memory lands; reading ppid off the FIRST `)` in `stat` rather than the
 * last, which a comm field containing one breaks; dropping the carried partial
 * line, so a spawn split across two reads is never seen; and returning an exit
 * code without setting `process.exitCode`, which reads as 0 through every
 * in-process caller.
 */

const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { configDirs } = require("./lib/arbiter-store");
const { claudeBin } = require("./lib/claude-bin.js");
const { flagValue, parseOrCode } = require("./lib/cli-args");
const { launchAuthRefusal } = require("./lib/launch-auth.js");
const { requiredGroup } = require("./lib/regex-group");
const { readParentOf } = require("./lib/proc-stat.js");
const { procRoot } = require("./lib/proc-root.js");

/** Sampling interval, in ms. Fast enough to resolve a one-second plateau. */
const SAMPLE_MS = 250;
/** Consecutive samples within STABLE_MB that count as a plateau: 6 x 250 ms =
 * 1.5 s of stillness, chosen so a pause between two allocation bursts is not
 * read as the end of growth. A GUESS against the shape of the curve, not a
 * measurement — the first real run is what tells whether it is long enough. */
const STABLE_SAMPLES = 6;
/** MB of drift two consecutive samples may show and still count as still. A
 * GUESS: 2 MB is ~0.4% of the ~500 MB pair this measures, small enough that
 * real growth breaks it and large enough to ride out GC noise. */
const STABLE_MB = 2;
/** Seconds a `--watch` run waits for a spawn before reporting none. 900 s is a
 * ceiling on the WAIT, not on the thing measured: the plateau itself is
 * expected in seconds. */
const DEFAULT_TIMEOUT_S = 900;

/** The line the daemon writes when it refills the pool. */
const SPAWN_LINE = /^\[([^\]]+)\].*bg spare spawned host pid=(\d+)/;

/** Every daemon.log on this machine. */
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

/**
 * A pid's RSS in MB, or null once it is gone.
 * @param {number} pid
 */
function readRssMb(pid) {
	try {
		const statm = fs
			.readFileSync(`${procRoot()}/${pid}/statm`, "utf8")
			.split(/\s+/);
		/* Field 2 is resident pages. `os.constants` carries no page size; 4096 is
		 * this machine's (mantahostels#2588). It is NOT inert if wrong: STABLE_MB is a
		 * tolerance in the MB computed here,
		 * so a 16 KiB page would make it 8 MB of real RSS and declare the
		 * plateau early. Re-check it before trusting a reading off another box. */
		return Math.round((Number(statm[1]) * 4096) / (1024 * 1024));
	} catch {
		return null;
	}
}

/**
 * Every process whose parent is `pid`, from the process tree.
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
		/* Unread where the process exited between readdir and read. */
		if (readParentOf(e) === pid) kids.push(Number(e));
	}
	return kids;
}

/**
 * THE PAIR'S RSS, not the logged process's (mantahostels#2588). `bg spare spawned host
 * pid=` names the `bg-pty-host`, which settles near-instantly at ~70-110 MB;
 * the `bg-spare` forked beneath it is the 150-520 MB half, and it is the pair
 * that admission prices and the stagger must wait for. Timing the host alone
 * would report a plateau seconds before the memory actually lands.
 *
 * The child set is re-read every sample: at the first sample the fork may not
 * have happened yet, and a pair whose child appears late must not be timed as
 * if it never will.
 * @param {number} hostPid
 * @returns {number | null} null once the host itself is gone
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

/**
 * The next `spare spawned` line written to any daemon log after this call, as
 * `{pid, at, log}` — or null on timeout. Polls the logs' tails rather than
 * watching them: a rotated or truncated log would break a watcher, and a poll
 * at this cadence costs a stat and a short read.
 * @param {number} deadline epoch ms to give up at
 */
async function nextSpawn(deadline) {
	const offsets = readStartOffsets();
	if (offsets.size === 0) return null;
	/* The tail of the last read, per log, carried forward: a read ends wherever
	 * the daemon happened to be writing, so a spawn line can be split across two
	 * of them and would otherwise be dropped as two non-matches. */
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

/**
 * Every daemon log's current size, the offset its first read starts from —
 * 0 where it will not stat.
 * @returns {Map<string, number>}
 */
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

/**
 * Per log: the offset read up to, the carried partial line, and whether it
 * has already been reported gone.
 * @typedef {{ offsets: Map<string, number>, partial: Map<string, string>, vanished: Set<string> }} Tails
 */

/**
 * Read one log from `from` on, and return the first spawn line in what it
 * added, or null.
 * @param {Tails} tails accumulator: the watch's tail state, advanced past what was read
 * @param {string} f
 * @param {number} from
 * @returns {{ pid: number, at: number, log: string } | null}
 */
function pollLog(tails, f, from) {
	const size = readCurrentSize(tails.vanished, f);
	if (size === null) return null;
	/* Back after a rotation: read it from the start, and let it say so
	 * again if it goes a second time. */
	tails.vanished.delete(f);
	/* A shrunken file was rotated or truncated: re-baseline rather than
	 * read a negative length, which would throw and lose the whole run. */
	if (size < from) {
		tails.offsets.set(f, size);
		return null;
	}
	if (size === from) return null;
	const text = readSpan(f, from, size);
	tails.offsets.set(f, size);
	const lines = ((tails.partial.get(f) || "") + text).split("\n");
	/* The last element is whatever followed the final newline — empty on a
	 * clean boundary, a half-written line otherwise. Either way it is not a
	 * complete line yet, so it waits for the next read. */
	tails.partial.set(f, lines.pop() ?? "");
	return firstSpawn(lines, f);
}

/**
 * @param {Set<string>} vanished accumulator: a log found gone is added, and said once
 * @param {string} f
 * @returns {number | null}
 */
function readCurrentSize(vanished, f) {
	try {
		return fs.statSync(f).size;
	} catch {
		/* Rotated away, or the config dir went. Said once rather than
		 * skipped in silence: a run whose ONLY log vanished spins to the
		 * deadline and reports "no spare was spawned". */
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
 * The first complete spawn line with a parseable timestamp, or null.
 * @param {string[]} lines
 * @param {string} f the log they came from
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
 * Sample `pid` until its RSS holds still, and report the wait from `spawnedAt`.
 * `verdict` is `plateau`, `gone` (the process exited before settling — a spare
 * claimed or reaped mid-measurement) or `timeout`.
 * @param {number} pid
 * @param {number} spawnedAt epoch ms the daemon logged the spawn at
 * @param {number} deadline epoch ms to give up at
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
			/* The plateau began at the FIRST of the steady samples, not the last:
			 * the run after it is what proved the plateau, not what reached it. */
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

/** The one-turn throwaway session `--probe` spends. */
const PROBE_PROMPT = "Reply with the single word ok. Do nothing else.";

function launchProbe(/** @type {string} */ prompt) {
	const bin = claudeBin();
	const child = spawn(bin, ["--bg", prompt], { stdio: "ignore" });
	child.unref();
	return bin;
}

const USAGE =
	"usage: node scripts/measure-spare-warm.js (--watch | --probe) [--timeout-seconds <n>] [--prompt <text>] [--json]";

/* The exit code is SET as well as returned. `runInProcessAsync` reads it off
 * `process.exitCode` and never off what main returned, so a script that only
 * returns one is untestable through that seam — it reads 0 on every path. */
async function main() {
	const code = await runMain();
	process.exitCode = code;
	return code;
}

/**
 * The options, or the exit code a bad command line ends on.
 * @returns {number | { json: boolean, probe: boolean, timeoutS: number, prompt: string }}
 */
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
		});
		if (refusal) {
			writeFd(2, `REFUSED: ${refusal}\n`);
			return 2;
		}
	}
	const deadline = Date.now() + timeoutS * 1000;

	/* The watcher is armed BEFORE the probe launches, so the spawn the probe
	 * causes cannot land in the window between the two. */
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
			? `  Set WFC_DISPATCH_STAGGER_SECONDS's default in scripts/dispatch-sessions.sh\n  from this, over several readings — one is a sample, not a figure.`
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
