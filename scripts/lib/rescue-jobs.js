/*
 * rescue-jobs.js — the core of `rescue-sessions.js list`, `snapshot` and
 * `stop` (#5157, mantahostels#2605): a plan's jobs, each one's transcript
 * reduced to the narration a successor resumes from, and where it got to.
 * Takeover and hand-off snapshot through it too.
 *
 * Every entry takes its parsed arguments and RescuePorts and answers
 * `{status, stdout, stderr}`, which the program's shell writes and exits on.
 * The oracle, `claude stop`, `gh`, the clock, the sleep and /proc come in as
 * ports; the filesystem and git are read in place.
 */

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

// How much of each transcript entry the narration keeps. A Bash command is the
// one that most often loses something the successor wants — a commit's pathspec
// runs past 140 — so raise BASH_CHARS before the others if a rescue reads short.
const USER_TURN_CHARS = 600;
const BASH_CHARS = 140;
const OTHER_INPUT_CHARS = 100;

/** @typedef {{ _: string[] } & Record<string, string | true | string[]>} ParsedArgs */
/** @typedef {import("./tracker-ops.js").BufferedIo} BufferedIo */
/** @typedef {import("./agent-liveness").RunOracle} RunOracle */

/**
 * What the rescue cores reach outside the filesystem and git. The shell fills
 * each with production's; a module case passes its fakes.
 * @typedef {object} RescuePorts
 * @property {NodeJS.ProcessEnv} env
 * @property {() => number} now  the clock, in epoch milliseconds
 * @property {(ms: number) => Promise<void>} sleep
 * @property {RunOracle | undefined} oracle  `claude agents --json` per config
 *   dir, lib/agent-liveness.js's runOracle where undefined
 * @property {typeof import("./child-spawn.js").spawnRaw | undefined} claude  `claude
 *   stop`'s spawn, lib/claude-stop.js's default where undefined
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
 * @property {boolean} [cwdGuessed] `cwd` is the main checkout by default,
 *   not a directory the session is known to have run in
 * @property {string} [deathPoint]
 * @property {string[]} [commitsAttempted]
 * @property {string[] | null} [commitsLanded]
 * @property {string[]} [artefactsSurvived]
 */

/**
 * A transcript content-block entry, narrow enough to read without `any`.
 *
 * @typedef {{ type: string, text?: string, file_path?: string }} ContentBlock
 */

/**
 * @typedef {import("./transcript.js").TranscriptRecord} TranscriptRecord
 * @typedef {import("./transcript.js").TranscriptBlock} TranscriptBlock
 */

/**
 * A bad invocation: `msg` on stderr, exit 2.
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
	// os.homedir() rather than $HOME, which an `env -i` invocation leaves unset.
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

/**
 * The model a session ran on, read off `--model` by name.
 *
 * Never off position: `dispatch-sessions.js` launches `--advisor <a> --model <m>`
 * as well as the bare form, so respawnFlags[1] is the advisor, not the model.
 *
 * @param {string[]} flags
 */
function modelOf(flags) {
	const i = flags.indexOf("--model");
	const model = flags[i + 1];
	return i >= 0 && model ? model : "";
}

/**
 * Every job in a config dir, newest first, with the fields a rescue needs.
 *
 * @param {string} dir
 * @returns {{ jobs: Job[], unreadable: number }} `unreadable`
 *   counts state files that would not parse — a job mid-write, or an entry
 *   that is not a directory. A directory with no state file at all is skipped,
 *   not counted: it has no state to rescue (#1146).
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

/**
 * A session's own account of itself: every real user turn, every line of
 * prose it wrote, and a one-line signature for every tool call, in order.
 *
 * @param {TranscriptRecord[]} records
 */
function extractNarration(records) {
	return records.flatMap(buildNarrationLines).join("\n");
}

/**
 * Every parseable line of a transcript.
 *
 * @param {string} transcriptPath
 * @returns {TranscriptRecord[]}
 */
function readTranscriptRecords(transcriptPath) {
	return parseJsonl(fs.readFileSync(transcriptPath, "utf8")).rows;
}

/**
 * Every Bash command the session ran, whole.
 *
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
 * The narration lines one transcript record gives: a real user turn, or an
 * assistant turn's prose and its tool-call signatures.
 *
 * @param {TranscriptRecord} j
 * @returns {string[]}
 */
function buildNarrationLines(j) {
	/** @type {string[]} */
	const out = [];
	// A real user turn, not an injected system-reminder or hook payload.
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

/**
 * @param {TranscriptBlock} c a `tool_use` block
 */
function toolSignature(c) {
	let detail;
	if (c.name === "Bash")
		detail = (c.input.command || "").slice(0, BASH_CHARS).replace(/\n/g, " ");
	else if (c.input.file_path) detail = c.input.file_path;
	else detail = JSON.stringify(c.input).slice(0, OTHER_INPUT_CHARS);
	return `  [${c.name}] ${detail}`;
}

/** A narration line `extractNarration` writes for a Write or Edit call. */
const WRITE_LINE = /^ {2}\[(?:Write|Edit)\] (.+)$/;

/**
 * Every file the session wrote or edited, filtered to what still exists on
 * disk — the "which artefacts survived" half of the brief step, read off the
 * narration `extractNarration` already built rather than re-scanning the
 * transcript.
 *
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
		// No cwd to resolve a relative path against — checking it against THIS
		// process's own cwd would answer plausibly and wrongly, since a rescue
		// script usually runs from the very repo a relative path names.
		if (!cwd) return false;
		return fs.existsSync(path.join(cwd, p));
	});
}

/* Only a command naming a commit is walked. */
const MENTIONS_COMMIT = /commit/;

/**
 * @typedef {{ call: string, subject: string | null }} CommitAttempt
 */

/**
 * This session's own commit calls, each with the subject git would record for
 * it. Read by lib/commit-calls.js, which walks each command as the guards do
 * (#2383). Read off the whole Bash commands, not the narration: BASH_CHARS
 * cuts a plugin-cache path or a long message before it shows (#1714). Empty
 * where the walk throws, with a warning saying so.
 *
 * @param {BufferedIo} io
 * @param {string[]} commands
 * @param {string} cwd the job's directory, a relative `-F` file's base
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

/* How far before a job's last update to look for its own commits. `updatedAt`
 * is when the job DIED, which is after it committed, not before — an
 * unbounded `--since` would miss nothing, but scanning the whole repo
 * history on every snapshot is wasteful, so this bounds it generously
 * against a long-running session instead of trying to date the job's start
 * (readJobs does not carry one). */
const COMMIT_LOOKBACK_MS = 6 * 60 * 60 * 1000;

/**
 * A commit call's subject as git records it, best-effort, from what the
 * scanner found: an `m` word as written, a `"$(cat <<'EOF'` heredoc among
 * them, or an `F` file read relative to `cwd` while it still exists. `null`
 * where none can be read.
 *
 * @param {{ call: string, flag: string, word: string }} scanned one call as
 *   lib/commit-calls.js read it: `flag` is `m`, `F` or `-`
 * @param {string} command the whole Bash command the call stands in
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
	// A lone `"$` is such a heredoc, cut short by the scanner's split.
	const body = /^"\$(?:\(cat\s|$)/.test(word) ? heredocOf(command, call) : null;
	return subjectOf(body ?? shellWord(word, 0)) || null;
}

/**
 * The body of the `-m "$(cat <<'EOF'` heredoc at or after `call` in
 * `command`. `null` where none opens there.
 *
 * @param {string} command
 * @param {string} call
 */
function heredocOf(command, call) {
	const heredoc = command.slice(Math.max(command.indexOf(call), 0)).match(
		// eslint-disable-next-line regexp/no-super-linear-backtracking -- input is a Bash command a session sends; a crafted one slows the hook, nothing worse (#4642)
		/-m\s+"\$\(cat\s+<<(-?)\s*['"]?(\w+)['"]?(?:[^\S\n]*\n)+([\s\S]*?)(?:^[\t ]*\2(?=\s*\)|[\t ]*$)|$(?![\s\S]))/m,
	);
	if (!heredoc) return null;
	const raw = heredoc[3] ?? "";
	return heredoc[1] ? raw.replace(/^\t+/gm, "") : raw;
}

/**
 * The bash word starting at `from`, with its quotes and escapes resolved as
 * bash would: adjacent quoted pieces joined (`'it'\''s'`), and `\"`, `\\`,
 * `\$` and `` \` `` undone inside double quotes.
 *
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

/**
 * git's `%s` for a message: its first paragraph, lines joined by a space.
 *
 * @param {string} text
 */
function subjectOf(text) {
	const lines = text.split("\n").map((l) => l.trimEnd());
	const start = lines.findIndex((l) => l !== "");
	if (start === -1) return "";
	const end = lines.indexOf("", start);
	return lines.slice(start, end === -1 ? undefined : end).join(" ");
}

/**
 * Which of THIS job's own commit attempts actually landed on `cwd`'s
 * branch — a subject equal to one of the job's own commit messages (#2373)
 * rather than a bare time window, so a neighbour's concurrent commit is
 * never misattributed to this job (several sessions commit to `main`
 * concurrently in this repo).
 * `null` where git could not be asked at all — `cwd` gone, not a repo, the
 * call itself failing — as against `[]`, which means git answered and
 * nothing attempted landed.
 * Residual: a neighbour's commit whose subject is identical, such as a bare
 * `wip`, is still credited.
 *
 * @param {string} cwd
 * @param {string} updatedAt
 * @param {(string | null)[]} subjects the job's attempts' subjects
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
			// A guess, never measured: a wedged git, not a slow one.
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

/* The message a session blocked at its seat's limit carries, in its job
 * record's `detail` and as the transcript's last assistant line: the 5-hour
 * bar's "session limit", the weekly one (#2128), or a model's own, "reached
 * your Fable limit" (#2380). A word run, not a list of names, so a new model's
 * limit needs no edit. Residual: a question that opens on that wording reads as
 * a limit; the anchor spares only one quoting it mid-sentence (#2158). */
const LIMIT_MESSAGE = /^You've (hit|reached) your [\w .]+ limit/;

/**
 * The last three things a session said; three is a guess, never measured.
 *
 * @param {string} narration
 */
function deathPoint(narration) {
	return narration
		.split("\n")
		.filter((l) => l.startsWith("A: ") && !LIMIT_MESSAGE.test(l.slice(3)))
		.slice(-3)
		.join("\n");
}

/**
 * Which of a plan's sessions the daemon still lists as live.
 *
 * `claude agents --json` is scoped to one config dir, so this is asked of the
 * SOURCE plan with that plan's own dir — the one case where a session missing
 * from the listing really does read dead. So it reads `readSeatListing`, not
 * `listedAgents`, which unions every plan's listing (#3512). Degrades to
 * `null`, never to "all dead".
 *
 * @param {string} dir
 * @param {RunOracle | undefined} oracle
 * @returns {Set<string> | null}
 */
function liveSessions(dir, oracle) {
	try {
		const listing = readSeatListing(
			dir,
			// A guess, never measured: a wedged daemon, not a slow one.
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
 * `--ids`' value, split and validated. Dies on any id shaped like a flag:
 * parseArgs takes an undeclared next token as the value, so `--ids --force`
 * and `--ids=--force` both arrive here as the string `"--force"`.
 *
 * @param {ParsedArgs} args
 * @param {BufferedIo} io
 * @returns {string[] | null} null where --ids was not given at all
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
 * Copy one job's state and transcript into `out`, write its narration, and
 * work out the fields a successor resumes from.
 * @param {BufferedIo} io
 * @param {string} dir
 * @param {string} out
 * @param {Job} j
 * @returns {{ job: Job, narrationBytes: number }} the job with those fields
 *   filled, and the narration's size in bytes
 */
function snapshotJob(io, dir, out, j) {
	const state = jobStatePath(dir, j.short);
	// A session run with no job record — interactive, or one whose record is
	// gone — has only its transcript to copy.
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
 * One snapshotted job's block of snapshot's "where each one died" report.
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
 * One subcommand's entry: `body` on a fresh buffered io, as its outcome.
 * @param {(io: BufferedIo, args: ParsedArgs, ports: RescuePorts) => Promise<number | void> | number | void} body
 * @param {string} [name]  the prefix of its `warn` and `fail` lines
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
