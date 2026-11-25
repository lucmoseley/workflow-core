const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readSeatListing } = require("./agent-liveness");
const { capMs } = require("./cap-ms.js");
const { caught } = require("./caught.js");
const { stopOn } = require("./claude-stop.js");
const { expandHome } = require("./home-path.js");
const { jobStatePath, jobStorePath } = require("./job-paths.js");
const { parseJsonl } = require("./jsonl.js");
const { isPrefixedPrompt } = require("./loop-prompts.js");
const { requiredGroup } = require("./regex-group");
const { scriptPath } = require("./script-path.js");
const { bufferedIo, collectIo } = require("./tracker-ops.js");

const STUCK_STATES = new Set(["blocked", "running", "working", "needs_input"]);

// guess, lucmoseley/mantahostels#2605
const USER_TURN_CHARS = 600;
const BASH_CHARS = 140;
const OTHER_INPUT_CHARS = 100;

/** @typedef {{ _: string[] } & Record<string, string | true | string[]>} ParsedArgs */
/** @typedef {import("./tracker-ops.js").BufferedIo} BufferedIo */
/** @typedef {import("./agent-liveness").RunOracle} RunOracle */

/**
 * @typedef {object} RescuePorts
 * @property {NodeJS.ProcessEnv} env
 * @property {() => number} now
 * @property {(ms: number) => Promise<void>} sleep
 * @property {RunOracle} oracle
 * @property {typeof import("./child-spawn.js").spawnRaw} claude
 * @property {import("./gh.js").GhRun} gh
 * @property {string} procRoot
 */

/** @typedef {{status: number, stdout: string, stderr: string}} Outcome */

/**
 * @typedef {object} Job
 * @property {string} short
 * @property {string} state
 * @property {string} detail
 * @property {string} intent
 * @property {string} name
 * @property {string} sessionId
 * @property {string} transcript
 * @property {string} model
 * @property {string} updatedAt
 * @property {string} cwd
 * @property {boolean} [cwdGuessed]
 * @property {string} [deathPoint]
 * @property {string[]} [commitsAttempted]
 * @property {string[] | null} [commitsLanded]
 * @property {string[]} [artefactsSurvived]
 */

/** @typedef {{ type: string, text?: string, file_path?: string }} ContentBlock */

/**
 * @typedef {import("./transcript.js").TranscriptRecord} TranscriptRecord
 * @typedef {import("./transcript.js").TranscriptBlock} TranscriptBlock
 */

/**
 * @param {BufferedIo} io
 * @param {string} msg
 * @returns {never}
 */
function die(io, msg) {
	io.err(`rescue-sessions: ${msg}\n`);
	return io.exit(2);
}

/**
 * @param {ParsedArgs} args
 * @param {BufferedIo} io
 * @param {NodeJS.ProcessEnv} env
 */
function configDir(args, io, env) {
	const d = args.from || env.CLAUDE_CONFIG_DIR;
	if (typeof d !== "string" || !d) {
		die(
			io,
			"--from needs a config dir, e.g. --from ~/.claude3 (or set $CLAUDE_CONFIG_DIR)",
		);
	}
	const resolved = expandHome(d, os.homedir());
	if (resolved === null)
		die(io, `cannot expand ${d}: the home directory is unset or not absolute`);
	if (!fs.existsSync(jobStorePath(resolved))) {
		die(
			io,
			`${resolved} has no jobs/ directory — is that a Claude config dir?`,
		);
	}
	return resolved;
}

/** @param {string[]} flags */
function modelOf(flags) {
	const i = flags.indexOf("--model");
	const model = flags[i + 1];
	return i >= 0 && model ? model : "";
}

/**
 * @param {string} dir
 * @returns {{ jobs: Job[], unreadable: number }}
 */
function readJobs(dir) {
	const jobsDir = jobStorePath(dir);
	/** @type {Job[]} */
	const jobs = [];
	let unreadable = 0;
	for (const short of fs.readdirSync(jobsDir)) {
		const statePath = jobStatePath(dir, short);
		let j;
		try {
			j = JSON.parse(fs.readFileSync(statePath, "utf8"));
		} catch (e) {
			if (caught(e).code !== "ENOENT") unreadable++;
			continue;
		}
		jobs.push({
			short,
			state: j.state || "?",
			detail: j.detail || "",
			intent: j.intent || "",
			name: j.name || "",
			sessionId: j.sessionId || "",
			transcript: j.linkScanPath || "",
			model: modelOf(j.respawnFlags || []),
			updatedAt: j.updatedAt || "",
			cwd: j.cwd || "",
		});
	}
	jobs.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
	return { jobs, unreadable };
}

/** @param {TranscriptRecord[]} records */
function extractNarration(records) {
	return records.flatMap(buildNarrationLines).join("\n");
}

/**
 * @param {string} transcriptPath
 * @returns {TranscriptRecord[]}
 */
function readTranscriptRecords(transcriptPath) {
	return parseJsonl(fs.readFileSync(transcriptPath, "utf8")).rows;
}

/**
 * @param {TranscriptRecord[]} records
 * @returns {string[]}
 */
function bashCommands(records) {
	return records.flatMap((j) =>
		j.type === "assistant" && Array.isArray(j.message?.content)
			? j.message.content
					.filter(
						(/** @type {TranscriptBlock} */ c) =>
							c.type === "tool_use" &&
							c.name === "Bash" &&
							typeof c.input?.command === "string",
					)
					.map((/** @type {TranscriptBlock} */ c) => c.input.command)
			: [],
	);
}

/**
 * @param {TranscriptRecord} j
 * @returns {string[]}
 */
function buildNarrationLines(j) {
	/** @type {string[]} */
	const out = [];
	if (
		j.type === "user" &&
		j.message &&
		typeof j.message.content === "string" &&
		!j.message.content.startsWith("<") &&
		!isPrefixedPrompt(j.message.content)
	) {
		out.push(`USER: ${j.message.content.slice(0, USER_TURN_CHARS)}`);
	}
	if (j.type !== "assistant" || !j.message || !Array.isArray(j.message.content))
		return out;
	const text = j.message.content
		.filter((/** @type {ContentBlock} */ c) => c.type === "text")
		.map((/** @type {ContentBlock} */ c) => c.text || "")
		.join("\n")
		.trim();
	if (text) out.push(`A: ${text}`);
	for (const c of j.message.content)
		if (c.type === "tool_use") out.push(toolSignature(c));
	return out;
}

/** @param {TranscriptBlock} c */
function toolSignature(c) {
	let detail;
	if (c.name === "Bash")
		detail = (c.input.command || "").slice(0, BASH_CHARS).replace(/\n/g, " ");
	else if (c.input.file_path) detail = c.input.file_path;
	else detail = JSON.stringify(c.input).slice(0, OTHER_INPUT_CHARS);
	return `  [${c.name}] ${detail}`;
}

const WRITE_LINE = /^ {2}\[(?:Write|Edit)\] (.+)$/;

/**
 * @param {string} narration
 * @param {string} cwd
 */
function survivedArtefacts(narration, cwd) {
	/** @type {Set<string>} */
	const paths = new Set();
	for (const line of narration.split("\n")) {
		const m = line.match(WRITE_LINE);
		if (m) paths.add(requiredGroup(m, 1, WRITE_LINE));
	}
	return [...paths].filter((p) => {
		if (path.isAbsolute(p)) return fs.existsSync(p);
		if (!cwd) return false;
		return fs.existsSync(path.join(cwd, p));
	});
}

const MENTIONS_COMMIT = /commit/;

/**
 * @typedef {{ call: string, subject: string | null }} CommitAttempt
 */

/**
 * @param {BufferedIo} io
 * @param {string[]} commands
 * @param {string} cwd
 * @returns {CommitAttempt[]}
 */
function readCommitsAttempted(io, commands, cwd) {
	const { commitCalls } = require("./commit-calls.js");
	/** @type {CommitAttempt[]} */
	const out = [];
	try {
		for (const command of commands) {
			if (!command.trim() || !MENTIONS_COMMIT.test(command)) continue;
			for (const scanned of commitCalls(command))
				out.push({
					call: scanned.call,
					subject: commitSubjectOf(scanned, command, cwd),
				});
		}
	} catch (e) {
		return commitCallsUnread(io, caught(e).message);
	}
	return out;
}

/**
 * @param {BufferedIo} io
 * @param {string} why
 * @returns {CommitAttempt[]}
 */
function commitCallsUnread(io, why) {
	io.err(
		`warning: commit calls unread, so none is listed or matched — ${why}\n`,
	);
	return [];
}

// guess, lucmoseley/mantahostels#2628
const COMMIT_LOOKBACK_MS = 6 * 60 * 60 * 1000;

/**
 * @param {{ call: string, flag: string, word: string }} scanned
 * @param {string} command
 * @param {string} cwd
 * @returns {string | null}
 */
function commitSubjectOf({ call, flag, word }, command, cwd) {
	if (flag === "F") {
		try {
			return (
				subjectOf(fs.readFileSync(path.resolve(cwd, word), "utf8")) || null
			);
		} catch {
			return null;
		}
	}
	if (flag !== "m") return null;
	const body = /^"\$(?:\(cat\s|$)/.test(word) ? heredocOf(command, call) : null;
	return subjectOf(body ?? shellWord(word, 0)) || null;
}

/**
 * @param {string} command
 * @param {string} call
 */
function heredocOf(command, call) {
	const heredoc = command
		.slice(Math.max(command.indexOf(call), 0))
		.match(
			/-m\s+"\$\(cat\s+<<(-?)\s*['"]?(\w+)['"]?(?:[^\S\n]*\n)+(?![^\S\n]*\n)([\s\S]*?)(?:^[\t ]*\2(?=\s*\)|[\t ]*$)|$(?![\s\S]))/m,
		);
	if (!heredoc) return null;
	const raw = heredoc[3] ?? "";
	return heredoc[1] ? raw.replace(/^\t+/gm, "") : raw;
}

/**
 * @param {string} text
 * @param {number} from
 */
function shellWord(text, from) {
	const piece = /'([^']*)'?|"((?:\\[\s\S]|[^"\\])*)"?|\\([\s\S])|([^\s'"\\]+)/y;
	piece.lastIndex = from;
	let word = "";
	for (let m = piece.exec(text); m?.[0]; m = piece.exec(text))
		word += m[1] ?? m[3] ?? m[4] ?? (m[2] ?? "").replace(/\\(["\\$`])/g, "$1");
	return word;
}

/** @param {string} text */
function subjectOf(text) {
	const lines = text.split("\n").map((l) => l.trimEnd());
	const start = lines.findIndex((l) => l !== "");
	if (start === -1) return "";
	const end = lines.indexOf("", start);
	return lines.slice(start, end === -1 ? undefined : end).join(" ");
}

/**
 * @param {string} cwd
 * @param {string} updatedAt
 * @param {(string | null)[]} subjects
 * @returns {string[] | null}
 */
function readCommitsLanded(cwd, updatedAt, subjects) {
	if (!fs.existsSync(cwd)) return null;
	const attemptedSubjects = new Set(
		subjects.filter(
			/** @param {string | null} m @returns {m is string} */ (m) => m !== null,
		),
	);
	if (attemptedSubjects.size === 0) return [];
	try {
		const { execGit } = require("./git.js");
		const args = ["log", "--format=%h %s"];
		if (updatedAt) {
			const since = new Date(
				new Date(updatedAt).getTime() - COMMIT_LOOKBACK_MS,
			).toISOString();
			if (!Number.isNaN(Date.parse(since))) args.push(`--since=${since}`);
		}
		const log = execGit(args, {
			cwd,
			encoding: "utf8",
			// guess, lucmoseley/mantahostels#2628
			timeout: 15_000,
		}).trim();
		const logLines = log ? log.split("\n") : [];
		return logLines.filter((l) =>
			attemptedSubjects.has(l.slice(l.indexOf(" ") + 1)),
		);
	} catch {
		return null;
	}
}

const LIMIT_MESSAGE = /^You've (hit|reached) your [\w .]+ limit/;

/** @param {string} narration */
function deathPoint(narration) {
	return (
		narration
			.split("\n")
			.filter((l) => l.startsWith("A: ") && !LIMIT_MESSAGE.test(l.slice(3)))
			// guess, lucmoseley/mantahostels#2605
			.slice(-3)
			.join("\n")
	);
}

/**
 * @param {string} dir
 * @param {RunOracle} oracle
 * @returns {Set<string> | null}
 */
function liveSessions(dir, oracle) {
	try {
		const listing = readSeatListing(
			dir,
			// guess, lucmoseley/mantahostels#2605
			capMs("WFC_RESCUE_ORACLE_TIMEOUT_MS", 45_000),
			oracle,
		);
		if ("why" in listing) return null;
		return new Set(listing.agents.map((a) => String(a.id || "").slice(0, 8)));
	} catch {
		return null;
	}
}

/**
 * @param {ParsedArgs} args
 * @param {BufferedIo} io
 * @returns {string[] | null}
 */
function readIds(args, io) {
	if (args.ids === undefined) return null;
	const ids = String(args.ids)
		.split(",")
		.map((s) => s.trim());
	const bad = ids.find((id) => !id || id.startsWith("-"));
	if (bad !== undefined)
		die(io, `--ids takes job ids, not a flag — got "${bad}"`);
	return ids;
}

/**
 * @param {BufferedIo} io
 * @param {ParsedArgs} args
 * @param {RescuePorts} ports
 */
function listJobs(io, args, ports) {
	const dir = configDir(args, io, ports.env);
	const want = args.state
		? new Set(String(args.state).split(","))
		: STUCK_STATES;
	const { jobs: all, unreadable } = readJobs(dir);
	const jobs = all.filter((j) => want.has(j.state));
	const live = liveSessions(dir, ports.oracle);
	if (jobs.length === 0) {
		io.out(`No jobs in ${dir} matching ${[...want].join("/")}.\n`);
		return;
	}
	io.out(`${jobs.length} job(s) in ${dir}:\n\n`);
	for (const j of jobs) {
		io.out(
			`  ${j.short}  ${j.state.padEnd(8)}  ${j.intent || "(no intent)"}\n`,
		);
		io.out(`      ${j.name.slice(0, 76)}\n`);
		if (j.detail) io.out(`      detail: ${j.detail.slice(0, 90)}\n`);
		/** @type {string} */
		let liveness;
		if (live === null) liveness = "liveness unreadable";
		else if (live.has(j.short)) liveness = "process LIVE";
		else liveness = "process GONE — claims stranded, successor retakes them";
		io.out(
			`      updated ${j.updatedAt}  model ${j.model || "?"}  ${liveness}\n`,
		);
		io.out(`      transcript: ${j.transcript || "(none recorded)"}\n\n`);
	}
	if (unreadable) {
		io.out(
			`${unreadable} state file(s) would not parse and are NOT listed above — re-run before deciding the set is complete.\n\n`,
		);
	}
	io.out("Snapshot them before stopping any:\n");
	io.out(
		`  node ${scriptPath("rescue-sessions.js")} snapshot --from ${dir} --out .claude/tmp/rescue\n`,
	);
}

/**
 * @param {BufferedIo} io
 * @param {string} dir
 * @param {string} out
 * @param {Job} j
 * @returns {{ job: Job, narrationBytes: number }}
 */
function snapshotJob(io, dir, out, j) {
	const state = jobStatePath(dir, j.short);
	if (fs.existsSync(state))
		fs.copyFileSync(state, path.join(out, `${j.short}.state.json`));
	if (!j.transcript || !fs.existsSync(j.transcript))
		return { job: j, narrationBytes: 0 };
	fs.copyFileSync(j.transcript, path.join(out, `${j.short}.transcript.jsonl`));
	const records = readTranscriptRecords(j.transcript);
	const narration = extractNarration(records);
	fs.writeFileSync(path.join(out, `${j.short}.narration.txt`), narration);
	const attempted = readCommitsAttempted(io, bashCommands(records), j.cwd);
	return {
		job: {
			...j,
			deathPoint: deathPoint(narration),
			artefactsSurvived: survivedArtefacts(narration, j.cwd),
			commitsAttempted: attempted.map((a) => a.call),
			commitsLanded: readCommitsLanded(
				j.cwd,
				j.updatedAt,
				attempted.map((a) => a.subject),
			),
		},
		narrationBytes: Buffer.byteLength(narration),
	};
}

/**
 * @param {BufferedIo} io
 * @param {ParsedArgs} args
 * @param {RescuePorts} ports
 */
function snapshotJobs(io, args, ports) {
	const dir = configDir(args, io, ports.env);
	const out = args.out;
	if (typeof out !== "string" || !out) die(io, "snapshot needs --out <dir>");
	fs.mkdirSync(out, { recursive: true });

	const ids = readIds(args, io);
	const only = ids ? new Set(ids) : null;
	const { jobs: all, unreadable } = readJobs(dir);
	const jobs = all.filter((j) =>
		only ? only.has(j.short) : STUCK_STATES.has(j.state),
	);
	if (unreadable) {
		io.out(
			`warning: ${unreadable} state file(s) would not parse and are not in this snapshot.\n`,
		);
	}
	if (jobs.length === 0) die(io, "nothing to snapshot — check `list` first");

	/** @type {Job[]} */
	const index = [];
	for (const j of jobs) {
		const { job, narrationBytes } = snapshotJob(io, dir, out, j);
		index.push(job);
		io.out(
			`  ${job.short}  ${job.intent || job.name.slice(0, 40)}  narration ${narrationBytes}B\n`,
		);
	}
	fs.writeFileSync(
		path.join(out, "index.json"),
		`${JSON.stringify(index, null, 2)}\n`,
	);

	io.out(`\nSnapshot in ${out}. Where each one died:\n\n`);
	for (const j of index) writeDeathReport(io, j);
	io.out(
		"Now: write a brief per ticket (the commits-landed and artefacts-survived " +
			"lines above are already in index.json), then stop the source sessions.\n",
	);
}

/**
 * @param {BufferedIo} io
 * @param {Job} j
 */
function writeDeathReport(io, j) {
	io.out(
		`═══ ${j.short} — ${j.intent || "?"}\n${j.deathPoint || "(no transcript)"}\n`,
	);
	if (j.commitsLanded === null)
		io.out("  commits landed: unreadable (git would not run)\n");
	else if (j.commitsLanded && j.commitsLanded.length > 0)
		io.out(
			`  commits landed (matched against its own commit attempts): ${j.commitsLanded.join("; ")}\n`,
		);
	if (j.artefactsSurvived && j.artefactsSurvived.length > 0)
		io.out(`  artefacts survived: ${j.artefactsSurvived.join(", ")}\n`);
	io.out("\n");
}

/**
 * @param {BufferedIo} io
 * @param {ParsedArgs} args
 * @param {RescuePorts} ports
 */
function stopJobs(io, args, ports) {
	const dir = configDir(args, io, ports.env);
	const ids = readIds(args, io);
	if (!ids) die(io, "stop needs --ids <a,b,c> — it will not guess");
	for (const id of ids) {
		const r = stopOn(dir, id, undefined, { spawn: ports.claude });
		io.out(`  ${id} -> ${r.ok ? r.said : `FAILED: ${r.why}`}\n`);
	}
}

/**
 * @param {(io: BufferedIo, args: ParsedArgs, ports: RescuePorts) => Promise<number | void> | number | void} body
 * @param {string} [name]
 * @returns {(args: ParsedArgs, ports: RescuePorts) => Promise<Outcome>}
 */
const entry =
	(body, name = "rescue-sessions") =>
	(args, ports) => {
		const io = bufferedIo(name);
		return collectIo(io, () => body(io, args, ports));
	};

module.exports = {
	LIMIT_MESSAGE,
	STUCK_STATES,
	configDir,
	die,
	entry,
	list: entry(listJobs),
	modelOf,
	readJobs,
	readTranscriptRecords,
	snapshot: entry(snapshotJobs),
	snapshotJob,
	stop: entry(stopJobs),
};
