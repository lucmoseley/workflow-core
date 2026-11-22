#!/usr/bin/env node
/*
 * away-load.js — the away-only reset-precondition runner (#5472, ruled at
 * #5449): while Windows has had no keyboard or mouse input for 15 minutes it
 * holds Windows free memory at 760–890 MB with Sysinternals Testlimit64 and
 * keeps WSL's CPU at 550% or more with niced busy loops, so #5346 (whether
 * page combining off stopped the resets) gathers its precondition minutes.
 * Commands: USAGE below.
 *
 * It reads memwatch: the raw Windows reading for input and free memory, fresh
 * each minute, and the minute log for CPU and #5346's count. Any input stops
 * the load at the next reading, within about 65 s, or 75 s where a read
 * runs slow under the load; past that it stops on the stale reading. It stops for good at
 * #5346's gate either way. A reset kills it; at the next start, before the
 * refill loop's boot-resume relaunches the killed sessions, `recover` runs
 * `git fsck` in each repo (#4264).
 * It never touches `.wslconfig`.
 *
 * In no family (§N3): an install command and a unit's own processes, not a
 * checker or a guard.
 *
 * Exit codes: 0; 1 where a command fails; 2 on a command line.
 */

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
	CHUNK_MB,
	GATE_MINUTES,
	decide,
	heldMb,
	holdStep,
	isGateReset,
	isPreconditionMinute,
	minuteOf,
	newestResetOf,
	parseReading,
	workersFor,
} = require("./lib/away-load.js");
const { parseOrCode } = require("./lib/cli-args.js");
const { gitBinary, gitDirs, gitSpawnOptions } = require("./lib/git.js");
const { runCommand } = require("./lib/run-command.js");
const { scriptPath } = require("./lib/script-path.js");
const { systemctl } = require("./lib/systemd-bins.js");
const { MinuteTail } = require("./lib/minute-tail.js");
const { minuteLogPath } = require("./lib/windows-memory.js");
const { readText } = require("./lib/file-read.js");
const { writeFd } = require("./lib/write-fd.js");

const UNIT = "away-load.service";
const USAGE = `usage: node ${scriptPath("away-load.js")} run | recover | sweep | hand-start [--minutes N] | status | install`;
/* Untraced: long enough to read a settled band and CPU off three or four
 * minute lines. */
const HAND_MINUTES = 20;
/* Untraced: a poll costs a few small reads, and the reading it waits on
 * changes once a minute. */
const POLL_MS = Number(process.env.WFC_AWAY_LOAD_POLL_MS) || 5000;
/* Untraced: an fsck's output past this is the same fault repeated. */
const FSCK_OUT_CHARS = 4000;
/* Untraced: about twice the longest the 4 Nov repos would take, guessed. */
const FSCK_TIMEOUT_MS = 30 * 60 * 1000;
const WIN = "/mnt/c/Windows/System32";

/** @param {NodeJS.ProcessEnv} env */
function paths(env = process.env) {
	const state =
		env.WFC_AWAY_LOAD_STATE_DIR ||
		path.join(
			env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"),
			"away-load",
		);
	return {
		state,
		status: path.join(state, "status.json"),
		hand: path.join(state, "hand-until"),
		done: path.join(state, "done"),
		seen: path.join(state, "seen-reset"),
		log: env.WFC_AWAY_LOAD_LOG || path.join(os.homedir(), "away-load.jsonl"),
		/* memwatch's MEMWATCH_WIN_OUT, by the same default. */
		reading:
			env.MEMWATCH_WIN_OUT ||
			path.join(env.XDG_RUNTIME_DIR || "/tmp", "memwatch-win"),
		minutes: env.MEMWATCH_MINUTE_LOG || minuteLogPath(),
		testlimit: env.WFC_TESTLIMIT || "/mnt/c/diag/testlimit/Testlimit64.exe",
		taskkill: env.WFC_TASKKILL || `${WIN}/taskkill.exe`,
		tasklist: env.WFC_TASKLIST || `${WIN}/tasklist.exe`,
		wevtutil: env.WFC_WEVTUTIL || `${WIN}/wevtutil.exe`,
		worker: env.WFC_AWAY_LOAD_WORKER || "while :; do :; done",
		repos: env.WFC_AWAY_LOAD_REPOS_ROOT || os.homedir(),
	};
}

/**
 * A state or reading file's text, null where it is absent; one that will not
 * read is said on stderr, the journal, and read as absent, so a run stops.
 * @param {string} file
 */
function textOf(file) {
	const r = readText(file);
	if (r.state === "read") return r.data;
	if (r.state === "unreadable") writeFd(2, `${file}: ${r.message}\n`);
	return null;
}

/** @param {ReturnType<typeof paths>} p */
const doneOf = (p) => textOf(p.done)?.trim() || null;

/**
 * @param {string} file
 * @param {string} text
 */
function writeAtomic(file, text) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(`${file}.tmp`, text);
	fs.renameSync(`${file}.tmp`, file);
}

/**
 * @param {ReturnType<typeof paths>} p
 * @param {string} event
 * @param {Record<string, unknown>} fields
 */
function logEvent(p, event, fields = {}) {
	const line = JSON.stringify({
		ts: new Date().toISOString(),
		event,
		...fields,
	});
	fs.appendFileSync(p.log, `${line}\n`);
	writeFd(1, `${line}\n`);
}

/** @param {ReturnType<typeof paths>} p */
function sweep(p) {
	const r = runCommand(p.taskkill, ["/IM", path.basename(p.testlimit), "/F"]);
	return r.error === null || /not found/i.test(r.error) ? null : r.error;
}

/**
 * How many Testlimit processes Windows runs, null where tasklist fails.
 * @param {ReturnType<typeof paths>} p
 */
function windowsHolders(p) {
	const name = path.basename(p.testlimit);
	const r = runCommand(p.tasklist, [
		"/FI",
		`IMAGENAME eq ${name}`,
		"/FO",
		"CSV",
		"/NH",
	]);
	if (r.error !== null) return null;
	return r.out.split("\n").filter((l) => l.startsWith(`"${name}"`)).length;
}

/**
 * #5472 #5497
 * @typedef {{ mb: number, child: import("node:child_process").ChildProcess }} LiveHolder
 */

/**
 * @param {ReturnType<typeof paths>} p
 * @param {number} mb
 * @param {(h: LiveHolder, code: number|null) => void} onExit
 * @returns {LiveHolder}
 */
function startHolder(p, mb, onExit) {
	const child = spawn(
		p.testlimit,
		["-accepteula", "-d", String(CHUNK_MB), "-c", String(mb / CHUNK_MB)],
		{ stdio: "ignore" },
	);
	/** @type {LiveHolder} */
	const holder = { mb, child };
	child.on("exit", (code) => onExit(holder, code));
	child.on("error", () => onExit(holder, null));
	return holder;
}

/** @param {LiveHolder} h */
const stopHolder = (h) => h.child.kill("SIGKILL");

class Runner {
	/** @param {ReturnType<typeof paths>} p */
	constructor(p) {
		this.p = p;
		this.tail = new MinuteTail(p.minutes, isPreconditionMinute);
		this.running = false;
		/** @type {string|null} */
		this.startedAt = null;
		/** @type {LiveHolder[]} */
		this.holders = [];
		/** @type {import("node:child_process").ChildProcess[]} */
		this.workers = [];
		this.lastReadingAt = 0;
		/** @type {Record<string, unknown>} the readings each log line carries */
		this.readout = {};
	}

	/** @param {string|null} done */
	writeStatus(done) {
		writeAtomic(
			this.p.status,
			`${JSON.stringify({
				updatedAt: new Date().toISOString(),
				pid: process.pid,
				running: this.running,
				startedAt: this.startedAt,
				heldMb: heldMb(this.holders),
				holderMb: this.holders.map((h) => h.mb),
				workers: this.workers.length,
				gateCount: this.tail.count,
				gateMinutes: GATE_MINUTES,
				done,
			})}\n`,
		);
	}

	stopAll() {
		for (const w of this.workers) w.kill("SIGKILL");
		this.workers = [];
		this.dropAllHolders();
	}

	/* The sweep ends any Testlimit its proxy's end left running. */
	dropAllHolders() {
		const was = this.holders;
		this.holders = [];
		for (const h of was) stopHolder(h);
		const error = sweep(this.p);
		if (error) logEvent(this.p, "sweep-failed", { error });
	}

	/**
	 * A holder that ends unasked has freed its memory: the next reading tops
	 * up. Its exit code says whether Testlimit holds at all.
	 * @param {LiveHolder} h
	 * @param {number|null} code
	 */
	onHolderExit(h, code) {
		if (!this.holders.includes(h)) return;
		this.holders = this.holders.filter((x) => x !== h);
		logEvent(this.p, "holder-exited", { mb: h.mb, code });
	}

	tick() {
		const p = this.p;
		const reading = parseReading(textOf(p.reading) ?? "");
		const newMinute = this.tail.advance();
		const verdict = decide({
			now: Math.floor(Date.now() / 1000),
			running: this.running,
			reading,
			handUntil: Number(textOf(p.hand)) || null,
			gateCount: this.tail.count,
			done: doneOf(p),
		});
		this.readout = {
			idleS: reading?.idleS ?? null,
			winAvailMb: reading?.availMb ?? null,
			busyPct: this.tail.last ? minuteOf(this.tail.last)?.busyPct : null,
			gateCount: this.tail.count,
		};
		this.act(verdict);
		if (this.running && reading) this.steerHold(reading);
		if (this.running && newMinute) this.steerWorkers();
		this.writeStatus(doneOf(p));
	}

	/** @param {import("./lib/away-load.js").Verdict} verdict */
	act(verdict) {
		if (verdict.kind === "start") {
			this.running = true;
			this.startedAt = new Date().toISOString();
			this.lastReadingAt = 0;
			logEvent(this.p, "start", { why: verdict.why, ...this.readout });
			return;
		}
		if (verdict.kind === "none") return;
		if (verdict.kind === "finish") writeAtomic(this.p.done, `${verdict.why}\n`);
		if (this.running || verdict.kind === "finish")
			logEvent(this.p, verdict.kind, {
				why: verdict.why,
				heldMb: heldMb(this.holders),
				workers: this.workers.length,
				...this.readout,
			});
		this.running = false;
		this.startedAt = null;
		this.stopAll();
	}

	/** @param {import("./lib/away-load.js").Reading} reading */
	steerHold(reading) {
		if (reading.at <= this.lastReadingAt) return;
		this.lastReadingAt = reading.at;
		const onWindows = windowsHolders(this.p);
		if (onWindows !== null && onWindows > this.holders.length) {
			logEvent(this.p, "strays", {
				onWindows,
				holders: this.holders.length,
				...this.readout,
			});
			this.dropAllHolders();
			return;
		}
		const step = holdStep(reading, this.holders);
		if (!step) return;
		if ("add" in step) {
			for (const mb of step.add)
				this.holders.push(
					startHolder(this.p, mb, (gone, code) =>
						this.onHolderExit(gone, code),
					),
				);
			logEvent(this.p, "hold", {
				addMb: step.add.reduce((a, b) => a + b, 0),
				heldMb: heldMb(this.holders),
				...this.readout,
			});
			return;
		}
		this.holders = this.holders.filter((x) => !step.drop.includes(x));
		for (const h of step.drop) stopHolder(h);
		logEvent(this.p, "release", {
			dropMb: heldMb(step.drop),
			heldMb: heldMb(this.holders),
			...this.readout,
		});
	}

	steerWorkers() {
		const minute = this.tail.last && minuteOf(this.tail.last);
		if (!minute) return;
		const want = workersFor(minute, this.workers.length);
		if (want === this.workers.length) return;
		while (this.workers.length < want)
			this.workers.push(
				spawn("nice", ["-n", "19", "sh", "-c", this.p.worker], {
					stdio: "ignore",
				}),
			);
		while (this.workers.length > want) this.workers.pop()?.kill("SIGKILL");
		logEvent(this.p, "workers", { workers: want, ...this.readout });
	}

	quit() {
		if (this.running) logEvent(this.p, "stop", { why: "the unit stopped" });
		this.running = false;
		this.stopAll();
		this.writeStatus(doneOf(this.p));
	}
}

async function run() {
	const p = paths();
	const orphan = sweep(p);
	if (orphan) logEvent(p, "sweep-failed", { error: orphan });
	const runner = new Runner(p);
	runner.tail.advance();
	const quit = () => {
		runner.quit();
		process.exit(0);
	};
	process.on("SIGTERM", quit);
	process.on("SIGINT", quit);
	for (;;) {
		runner.tick();
		await new Promise((r) => setTimeout(r, POLL_MS));
	}
}

/**
 * The git repositories directly under `root`; a linked worktree's `.git` is a
 * file, and its repository is checked from its main checkout.
 * @param {ReturnType<typeof paths>} p
 * @param {string} root
 */
function reposUnder(p, root) {
	let names;
	try {
		names = fs.readdirSync(root);
	} catch (err) {
		logEvent(p, "repos-unread", { root, error: String(err) });
		return [];
	}
	return names
		.map((n) => path.join(root, n))
		.filter((dir) => {
			try {
				return fs.statSync(path.join(dir, ".git")).isDirectory();
			} catch {
				return false;
			}
		})
		.sort();
}

/** @param {ReturnType<typeof paths>} p @param {string} repo */
function fsck(p, repo) {
	const r = spawnSync(
		"nice",
		[
			"-n",
			"19",
			gitBinary(),
			"-C",
			repo,
			"fsck",
			"--no-progress",
			"--no-dangling",
		],
		gitSpawnOptions({ encoding: "utf8", timeout: FSCK_TIMEOUT_MS }),
	);
	const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
	logEvent(p, "fsck", {
		repo,
		ok: r.status === 0,
		status: r.status,
		out: out.slice(0, FSCK_OUT_CHARS),
	});
}

/**
 * After a Kernel-Power 41 newer than the last one seen: the runner's end where
 * it meets #5346's gate, then `git fsck` in each repo, then the reset marked
 * seen, so a start cut off part-way does all of it again. The first start
 * only records the newest, so a reset before the install checks nothing.
 */
function recover() {
	const p = paths();
	const read = runCommand(p.wevtutil, [
		"qe",
		"System",
		"/q:*[System[(EventID=41)]]",
		"/c:1",
		"/rd:true",
		"/f:text",
	]);
	const reset = newestResetOf(read.out.replace(/\r/g, ""));
	if (read.error !== null) {
		/* The unit's start fails and systemd retries it: a run started now
		 * could load past a reset it cannot see. */
		logEvent(p, "recover-unread", { error: read.error });
		return 1;
	}
	if (reset === null) return 0;
	const lastSeen = textOf(p.seen)?.trim() || null;
	const isNew = lastSeen === null || reset > lastSeen;
	if (isNew && isGateReset(reset))
		writeAtomic(
			p.done,
			`Kernel-Power 41 at ${reset}: the page-combining gate met (reset) (#5346)\n`,
		);
	if (lastSeen !== null && isNew) {
		logEvent(p, "reset", { at: reset });
		for (const repo of reposUnder(p, p.repos)) fsck(p, repo);
	}
	writeAtomic(p.seen, `${reset}\n`);
	return 0;
}

/** @param {number} minutes */
function handStart(minutes) {
	const p = paths();
	const until = Math.floor(Date.now() / 1000) + minutes * 60;
	writeAtomic(p.hand, `${until}\n`);
	writeFd(
		1,
		`hand start: runs until ${new Date(until * 1000).toISOString()} whatever the input\n`,
	);
	return 0;
}

function status() {
	const p = paths();
	const active = runCommand(systemctl(), ["--user", "is-active", UNIT]);
	const lines = [
		`unit: ${active.out || active.error}`,
		`status: ${textOf(p.status)?.trim() ?? "none written"}`,
		`done: ${textOf(p.done)?.trim() ?? "no"}`,
		`newest Kernel-Power 41 seen: ${textOf(p.seen)?.trim() ?? "none read"}`,
		`log: ${p.log}`,
	];
	writeFd(1, `${lines.join("\n")}\n`);
	return 0;
}

/* Refused rather than quoted: these sit inside a command string that systemd
 * unquotes first. */
const PLAIN_PATH = /^[\w./@+-]+$/;

function install() {
	const shell = process.env.SHELL || "/bin/bash";
	/* This copy, from the main checkout alone: a session's linked worktree is
	 * removed when it ends. The run reads its code at each unit start. */
	const script = __filename;
	const dirs = gitDirs(__dirname);
	if (dirs === null || dirs.gitDir !== dirs.common) {
		writeFd(2, `install from the main checkout, not ${__dirname}\n`);
		return 1;
	}
	for (const word of [shell, script])
		if (!PLAIN_PATH.test(word)) {
			writeFd(2, `the unit cannot quote this path: ${word}\n`);
			return 1;
		}
	const text = fs
		.readFileSync(path.join(__dirname, `${UNIT}.template`), "utf8")
		.replaceAll("@SHELL@", () => shell)
		.replaceAll("@SCRIPT@", () => script);
	const dir = path.join(
		process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
		"systemd",
		"user",
	);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, UNIT), text);
	const steps = [
		runCommand(systemctl(), ["--user", "daemon-reload"]),
		runCommand(systemctl(), ["--user", "enable", "--now", UNIT]),
	];
	const active = runCommand(systemctl(), ["--user", "is-active", UNIT]);
	writeFd(1, `${path.join(dir, UNIT)}\nis-active: ${active.out}\n`);
	const errors = [...steps, active].flatMap((r) => r.error ?? []);
	for (const error of errors) writeFd(2, `${error}\n`);
	return errors.length === 0 && active.out === "active" ? 0 : 1;
}

async function main(argv = process.argv.slice(2)) {
	const parsed = parseOrCode(argv, {
		usage: USAGE,
		commands: {
			run: { usage: USAGE },
			recover: { usage: USAGE },
			sweep: { usage: USAGE },
			"hand-start": { usage: USAGE, flags: { "--minutes": "value" } },
			status: { usage: USAGE },
			install: { usage: USAGE },
		},
	});
	if (typeof parsed === "number") return parsed;
	switch (parsed.command) {
		case "run":
			await run();
			return 0;
		case "recover":
			return recover();
		case "sweep": {
			const error = sweep(paths());
			if (error) writeFd(2, `${error}\n`);
			return error ? 1 : 0;
		}
		case "hand-start": {
			const given = parsed.flags["--minutes"];
			const minutes = given === undefined ? HAND_MINUTES : Number(given);
			if (!Number.isInteger(minutes) || minutes <= 0) {
				writeFd(2, `--minutes takes a whole number over 0\n${USAGE}\n`);
				return 2;
			}
			return handStart(minutes);
		}
		case "status":
			return status();
		case "install":
			return install();
		default:
			writeFd(2, `${USAGE}\n`);
			return 2;
	}
}

module.exports = { main };

if (require.main === module)
	main().then(
		(code) => {
			process.exitCode = code;
		},
		(e) => {
			writeFd(2, `away-load: ${e.stack || e}\n`);
			process.exitCode = 1;
		},
	);
