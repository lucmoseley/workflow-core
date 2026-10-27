#!/usr/bin/env node
/**
 * Move stuck /implement sessions from one Claude config dir (one Anthropic
 * subscription) to another, when the source plan has run out of allowance.
 *
 * mantahostels#2605.
 *
 * list, snapshot and stop take `--from <config-dir>`, defaulting to $CLAUDE_CONFIG_DIR.
 * Nothing here writes to the repo outside --out, or takeover's and hand-off's
 * .claude/tmp/rescue/; only `stop`, `takeover` and `hand-off` are not
 * read-only.
 *
 *   list      [--from D] [--state S]      what is stuck, and where its transcript is
 *   snapshot  [--from D] --out DIR [--ids] copy state + transcript, extract narration
 *   stop      [--from D] --ids a,b,c       stop them (snapshot FIRST -- see below)
 *   probe     (--issue N | --session ID) [--interval S]
 *                                          is one named session frozen? (#620)
 *   takeover  (--issue N | --session ID) [--interval S] [--confirm-within S]
 *             [--despite SLOW|ASKING --reason TEXT]
 *                                          stop it and adopt its ticket (#621);
 *                                          --despite overrules that verdict (#622);
 *                                          a GHOST is stopped, not adopted (#1989)
 *   hand-off  --from D --job SHORT --issue N [--issue M]
 *                                          snapshot a stopped job, post its
 *                                          Hand-off on each issue and release
 *                                          its claim, for a fresh session (#2659)
 *
 * SNAPSHOT BEFORE YOU STOP.
 */

const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const os = require("node:os");
const path = require("node:path");
const {
	capMs,
	claudeBin,
	isTerminalAgent,
	runOracle,
} = require("./lib/agent-liveness");
const { parseOrExit } = require("./lib/cli-args");
const { requiredGroup } = require("./lib/regex-group");
const { CHILD_MAX_BUFFER } = require("./lib/child-buffer.js");
const { caught } = require("./lib/caught.js");
const { FIELD, readStatFields } = require("./lib/proc-stat.js");
const { readOwnJob, stopOn } = require("./lib/claude-stop.js");
const {
	jobStatePath,
	jobStorePath,
	readJobRecord,
	shortJobId,
} = require("./lib/job-paths.js");

const STUCK_STATES = new Set(["blocked", "running", "working", "needs_input"]);

/*
 * The probe's thresholds (#620). EACH IS A GUESS UNTIL MEASURED — no wrong
 * verdict has been traced to one yet, and the first that is should move it.
 *
 * The interval is the watch cadence docs/agents/guard-registry.md §Subagent dispatch uses. The CPU
 * floor is what a non-helper descendant must spend between samples to read as
 * working. The session's own CPU is left out: idle, it passes any floor
 * (#620). The helper
 * patterns name the children that live for the whole session and tick whether
 * or not a turn is running, matched on argv; a helper's own children are
 * excluded with it. No live session here had one to match against.
 */
const PROBE_INTERVAL_S = 120;
const PROBE_CPU_FLOOR_S = 0.5;
/* How long a stopped session may stay listed as live before takeover gives
 * up on the stop (#621). A GUESS too; `--confirm-within` overrides it. */
const STOP_CONFIRM_CEILING_S = 60;
const HELPER_ARGV = [
	/mcp-server/i,
	/@modelcontextprotocol\//,
	/language-server|tsserver/i,
];

// How much of each transcript entry the narration keeps. A Bash command is the
// one that most often loses something the successor wants — a commit's pathspec
// runs past 140 — so raise BASH_CHARS before the others if a rescue reads short.
const USER_TURN_CHARS = 600;
const BASH_CHARS = 140;
const OTHER_INPUT_CHARS = 100;

/** @typedef {{ _: string[] } & Record<string, string | true | string[]>} ParsedArgs */

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

const HOLDER_USAGE = "(--issue <n> | --session <id>) [--interval <s>]";
const HAND_OFF_USAGE =
	"usage: rescue-sessions.js hand-off --from <config-dir> --job <short id> --issue <n> [--issue <n>]…";

/** @type {Record<string, import("./lib/cli-args").CommandSpec>} */
const SUBCOMMANDS = {
	list: {
		usage: "usage: rescue-sessions.js list [--from <config-dir>] [--state S]",
		flags: { "--from": "value", "--state": "value" },
	},
	snapshot: {
		usage:
			"usage: rescue-sessions.js snapshot [--from <config-dir>] --out DIR [--ids a,b,c]",
		flags: { "--from": "value", "--out": "value", "--ids": "value" },
	},
	stop: {
		usage: "usage: rescue-sessions.js stop [--from <config-dir>] --ids a,b,c",
		flags: { "--from": "value", "--ids": "value" },
	},
	probe: {
		usage: `usage: rescue-sessions.js probe ${HOLDER_USAGE}`,
		flags: { "--issue": "value", "--session": "value", "--interval": "value" },
	},
	takeover: {
		usage: `usage: rescue-sessions.js takeover ${HOLDER_USAGE} [--confirm-within <s>] [--despite SLOW|ASKING --reason "<text>"]`,
		flags: {
			"--issue": "value",
			"--session": "value",
			"--interval": "value",
			"--confirm-within": "value",
			"--despite": "value",
			"--reason": "value",
		},
	},
	"hand-off": {
		usage: HAND_OFF_USAGE,
		flags: { "--from": "value", "--job": "value", "--issue": "list" },
	},
};

/** @type {import("./lib/cli-args").CliSpec} */
const CLI = {
	usage: Object.values(SUBCOMMANDS)
		.map((c) => c.usage)
		.join("\n"),
	commands: SUBCOMMANDS,
};

/**
 * lib/cli-args.js's parseOrExit, keyed as the subcommands read it: each flag
 * without its `--`, the subcommand alone in `_`.
 * @param {string[]} argv
 * @returns {ParsedArgs}
 */
function parseArgs(argv) {
	const { command, flags, lists } = parseOrExit(argv, CLI);
	/** @type {ParsedArgs} */
	const out = { _: command ? [command] : [] };
	for (const [flag, value] of Object.entries({ ...flags, ...lists }))
		out[flag.slice(2)] = value;
	return out;
}

/** @param {ParsedArgs} args */
function configDir(args) {
	const d = args.from || process.env.CLAUDE_CONFIG_DIR;
	if (typeof d !== "string" || !d) {
		die(
			"--from needs a config dir, e.g. --from ~/.claude3 (or set $CLAUDE_CONFIG_DIR)",
		);
	}
	// `~` only, and only leading: os.homedir() rather than $HOME, which an
	// `env -i` invocation leaves unset. `~user` is not expanded.
	const resolved = d.startsWith("~/") ? path.join(os.homedir(), d.slice(2)) : d;
	if (!fs.existsSync(jobStorePath(resolved))) {
		die(`${resolved} has no jobs/ directory — is that a Claude config dir?`);
	}
	return resolved;
}

/** @param {string} msg @returns {never} */
function die(msg) {
	writeFd(2, `rescue-sessions: ${msg}\n`);
	process.exit(2);
}

/**
 * The model a session ran on, read off `--model` by name.
 *
 * Never off position: `dispatch-sessions.sh` launches `--advisor <a> --model <m>`
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
 * @param {any[]} records
 */
function extractNarration(records) {
	return records.flatMap(buildNarrationLines).join("\n");
}

/**
 * Every parseable line of a transcript.
 *
 * @param {string} transcriptPath
 * @returns {any[]}
 */
function readTranscriptRecords(transcriptPath) {
	const records = [];
	for (const line of fs.readFileSync(transcriptPath, "utf8").split("\n")) {
		try {
			records.push(JSON.parse(line));
		} catch {
			// A blank line, or a torn last one from a session killed mid-write.
		}
	}
	return records;
}

/**
 * Every Bash command the session ran, whole.
 *
 * @param {any[]} records
 * @returns {string[]}
 */
function bashCommands(records) {
	return records.flatMap((j) =>
		j.type === "assistant" && Array.isArray(j.message?.content)
			? j.message.content
					.filter(
						(/** @type {any} */ c) =>
							c.type === "tool_use" &&
							c.name === "Bash" &&
							typeof c.input?.command === "string",
					)
					.map((/** @type {any} */ c) => c.input.command)
			: [],
	);
}

/**
 * The narration lines one transcript record gives: a real user turn, or an
 * assistant turn's prose and its tool-call signatures.
 *
 * @param {any} j one transcript line, JSON.parse's output — `any` because the
 *   record types differ per line and each field read is type-tested first
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
		!j.message.content.startsWith("<")
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
 * @param {any} c a `tool_use` block — `any`, not ContentBlock, because its
 *   `input` is the tool's own argument object, a different shape per tool
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
 * @param {string[]} commands
 * @param {string} cwd the job's directory, a relative `-F` file's base
 * @returns {CommitAttempt[]}
 */
function readCommitsAttempted(commands, cwd) {
	const { commitCalls } = require("./lib/commit-calls.js");
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
		return commitCallsUnread(caught(e).message);
	}
	return out;
}

/**
 * @param {string} why
 * @returns {CommitAttempt[]}
 */
function commitCallsUnread(why) {
	writeFd(
		2,
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
	const heredoc = command
		.slice(Math.max(command.indexOf(call), 0))
		.match(
			/-m\s+"\$\(cat\s+<<(-?)\s*['"]?(\w+)['"]?\s*\n([\s\S]*?)(?:^[\t ]*\2(?=\s*\)|[\t ]*$)|$(?![\s\S]))/m,
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
		const { execGit } = require("./lib/git.js");
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
 * from the listing really does read dead. So it calls the oracle itself, not
 * `listedAgents`, whose cache is keyed by this process's own config dir and
 * would hand back this plan's listing. Degrades to `null`, never to "all dead".
 *
 * @param {string} dir
 * @returns {Set<string> | null}
 */
function liveSessions(dir) {
	try {
		const raw = runOracle(
			claudeBin(),
			// A guess, never measured: a wedged daemon, not a slow one.
			capMs("WFC_RESCUE_ORACLE_TIMEOUT_MS", 45_000),
			{ ...process.env, CLAUDE_CONFIG_DIR: dir },
		);
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return null;
		return new Set(parsed.map((a) => String(a.id || "").slice(0, 8)));
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
 * @returns {string[] | null} null where --ids was not given at all
 */
function readIds(args) {
	if (args.ids === undefined) return null;
	const ids = String(args.ids)
		.split(",")
		.map((s) => s.trim());
	const bad = ids.find((id) => !id || id.startsWith("-"));
	if (bad !== undefined) die(`--ids takes job ids, not a flag — got "${bad}"`);
	return ids;
}

/** @param {ParsedArgs} args */
function cmdList(args) {
	const dir = configDir(args);
	const want = args.state
		? new Set(String(args.state).split(","))
		: STUCK_STATES;
	const { jobs: all, unreadable } = readJobs(dir);
	const jobs = all.filter((j) => want.has(j.state));
	const live = liveSessions(dir);
	if (jobs.length === 0) {
		process.stdout.write(
			`No jobs in ${dir} matching ${[...want].join("/")}.\n`,
		);
		return;
	}
	process.stdout.write(`${jobs.length} job(s) in ${dir}:\n\n`);
	for (const j of jobs) {
		process.stdout.write(
			`  ${j.short}  ${j.state.padEnd(8)}  ${j.intent || "(no intent)"}\n`,
		);
		process.stdout.write(`      ${j.name.slice(0, 76)}\n`);
		if (j.detail)
			process.stdout.write(`      detail: ${j.detail.slice(0, 90)}\n`);
		/** @type {string} */
		let liveness;
		if (live === null) liveness = "liveness unreadable";
		else if (live.has(j.short)) liveness = "process LIVE";
		else liveness = "process GONE — claims stranded, successor retakes them";
		process.stdout.write(
			`      updated ${j.updatedAt}  model ${j.model || "?"}  ${liveness}\n`,
		);
		process.stdout.write(
			`      transcript: ${j.transcript || "(none recorded)"}\n\n`,
		);
	}
	if (unreadable) {
		process.stdout.write(
			`${unreadable} state file(s) would not parse and are NOT listed above — re-run before deciding the set is complete.\n\n`,
		);
	}
	process.stdout.write("Snapshot them before stopping any:\n");
	process.stdout.write(
		`  node scripts/rescue-sessions.js snapshot --from ${dir} --out .claude/tmp/rescue\n`,
	);
}

/**
 * Copy one job's state and transcript into `out`, write its narration, and
 * work out the fields a successor resumes from.
 * @param {string} dir
 * @param {string} out
 * @param {Job} j
 * @returns {{ job: Job, narrationBytes: number }} the job with those fields
 *   filled, and the narration's size in bytes
 */
function snapshotJob(dir, out, j) {
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
	const attempted = readCommitsAttempted(bashCommands(records), j.cwd);
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

/** @param {ParsedArgs} args */
function cmdSnapshot(args) {
	const dir = configDir(args);
	const out = args.out;
	if (typeof out !== "string" || !out) die("snapshot needs --out <dir>");
	fs.mkdirSync(out, { recursive: true });

	const ids = readIds(args);
	const only = ids ? new Set(ids) : null;
	const { jobs: all, unreadable } = readJobs(dir);
	const jobs = all.filter((j) =>
		only ? only.has(j.short) : STUCK_STATES.has(j.state),
	);
	if (unreadable) {
		process.stdout.write(
			`warning: ${unreadable} state file(s) would not parse and are not in this snapshot.\n`,
		);
	}
	if (jobs.length === 0) die("nothing to snapshot — check `list` first");

	/** @type {Job[]} */
	const index = [];
	for (const j of jobs) {
		const { job, narrationBytes } = snapshotJob(dir, out, j);
		index.push(job);
		process.stdout.write(
			`  ${job.short}  ${job.intent || job.name.slice(0, 40)}  narration ${narrationBytes}B\n`,
		);
	}
	fs.writeFileSync(
		path.join(out, "index.json"),
		`${JSON.stringify(index, null, 2)}\n`,
	);

	process.stdout.write(`\nSnapshot in ${out}. Where each one died:\n\n`);
	for (const j of index) writeDeathReport(j);
	process.stdout.write(
		"Now: write a brief per ticket (the commits-landed and artefacts-survived " +
			"lines above are already in index.json), then stop the source sessions.\n",
	);
}

/**
 * One snapshotted job's block of snapshot's "where each one died" report.
 * @param {Job} j
 */
function writeDeathReport(j) {
	process.stdout.write(
		`═══ ${j.short} — ${j.intent || "?"}\n${j.deathPoint || "(no transcript)"}\n`,
	);
	if (j.commitsLanded === null)
		process.stdout.write("  commits landed: unreadable (git would not run)\n");
	else if (j.commitsLanded && j.commitsLanded.length > 0)
		process.stdout.write(
			`  commits landed (matched against its own commit attempts): ${j.commitsLanded.join("; ")}\n`,
		);
	if (j.artefactsSurvived && j.artefactsSurvived.length > 0)
		process.stdout.write(
			`  artefacts survived: ${j.artefactsSurvived.join(", ")}\n`,
		);
	process.stdout.write("\n");
}

/** @param {ParsedArgs} args */
function cmdStop(args) {
	const dir = configDir(args);
	const ids = readIds(args);
	if (!ids) die("stop needs --ids <a,b,c> — it will not guess");
	for (const id of ids) {
		const r = stopOn(dir, id);
		process.stdout.write(`  ${id} -> ${r.ok ? r.said : `FAILED: ${r.why}`}\n`);
	}
}

/*
 * ── probe: is one named session frozen? (#620, spec #617) ──────────────────
 *
 * Read-only. Two samples PROBE_INTERVAL_S apart, then one verdict, first
 * match winning — except GHOST, read off the first sample alone (#1989):
 *
 *   GHOST    9  its job record reads "working", no plan lists a process for
 *               it, and it never wrote a transcript, past the grace window —
 *               lib/hung-jobs.js's GHOST-JOB test
 *   UNKNOWN  3  the oracle, the transcript or /proc would not read at either
 *               sample — doubt never reads as frozen
 *   ENDED    4  listed by no plan, or listed in a terminal state
 *   LIMITED 10  oracle state blocked, its job record's detail a session,
 *               weekly or model limit message — stuck until a typed message
 *               after the reset (#2158, #2380)
 *   ASKING   5  oracle state needs_input/blocked, or the turn ended on
 *               `needs input:`
 *   DONE     6  the turn ended on `result:` with nothing in flight
 *   SLOW     7  a transcript changed size, `inFlight` shows work, or a
 *               non-helper descendant spent PROBE_CPU_FLOOR_S of CPU
 *   FROZEN   8  none of the above — a turn ended on `waiting:` with nothing
 *               left running lands here, the lost wake
 *   (bad invocation or nothing to probe: 2, on stderr)
 *
 * SIZE, NOT MTIME, as watch-artefact.js: a touch without an append is not
 * progress, and a size that falls is a rewrite, which is.
 */

const PROBE_EXIT = {
	UNKNOWN: 3,
	ENDED: 4,
	ASKING: 5,
	DONE: 6,
	SLOW: 7,
	FROZEN: 8,
	GHOST: 9,
	LIMITED: 10,
};

/* The unit of /proc/<pid>/stat's CPU fields: USER_HZ, which Linux fixes at
 * 100 whatever the kernel's own tick rate (`getconf CLK_TCK`). */
const CLK_TCK = 100;

/* How much of a transcript's tail is read for its last turn. A guess: room
 * for one long final message and the tool results before it. */
const TAIL_BYTES = 512 * 1024;

const procRoot = () => process.env.WFC_PROC || "/proc";

/**
 * @typedef {import("./lib/agent-liveness").AgentRecord} AgentRecord
 * @typedef {{dir: string, agents?: AgentRecord[], why?: string}} PlanListing
 * @typedef {{pid: number, ppid: number, start: string, ticks: number, argv: string}} ProcRow
 * @typedef {{
 *   holder: {dir: string, row: AgentRecord} | null,
 *   unread: string[],
 *   transcript: string | null,
 *   size: number | null,
 *   subs: Map<string, number>,
 *   inFlight: {tasks: number, queued: number} | null,
 *   limit: string | null,
 *   tree: {self: number, kids: Map<string, ProcRow>, helpers: number} | null | undefined,
 *   marker: string,
 * }} ProbeSample
 */

/**
 * Every existing plan's own `claude agents --json`, read in parallel, each
 * through agent-liveness.js in a child so its timeout, single-flight and
 * degrade-to-doubt rules come with it. The self-test is waived: this session
 * is listed by one plan at most, so the others would all refuse.
 *
 * @param {string[]} dirs
 * @returns {Promise<PlanListing[]>}
 */
function readPlanListings(dirs) {
	const { execFile } = require("node:child_process");
	const lib = path.join(__dirname, "lib", "agent-liveness.js");
	const snippet = `process.stdout.write(JSON.stringify(require(${JSON.stringify(lib)}).listedAgents({ requireSelf: false })))`;
	return Promise.all(
		dirs
			.filter((d) => fs.existsSync(d))
			.map(
				(dir) =>
					/** @type {Promise<PlanListing>} */ (
						new Promise((resolve) => {
							execFile(
								process.execPath,
								["-e", snippet],
								{
									env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
									encoding: "utf8",
									// Above the reader's own worst case, its 10 s cap, 20 s
									// retry and follower wait; this bounds only a wedge.
									timeout: 90_000,
									maxBuffer: CHILD_MAX_BUFFER,
								},
								(err, stdout) => {
									if (err)
										return resolve({
											dir,
											why: `reader failed (${err.code ?? err.message})`,
										});
									try {
										resolve({ dir, ...JSON.parse(stdout) });
									} catch {
										resolve({ dir, why: "reader did not return JSON" });
									}
								},
							);
						})
					),
			),
	);
}

/**
 * Whether `sessionId` names `id` — the full id, or its 8-character short form.
 * @param {string} sessionId
 * @param {string} id
 */
const idMatches = (sessionId, id) =>
	sessionId === id || (id.length === 8 && sessionId.startsWith(id));

/**
 * The holder's row and plan, or null with the plans that would not read. A
 * plan that would not read is doubt only where no other plan lists the holder.
 *
 * @param {PlanListing[]} listings
 * @param {string} sessionId
 */
function findHolder(listings, sessionId) {
	for (const listing of listings) {
		const row = listing.agents?.find((a) => a.sessionId === sessionId);
		if (row) return { holder: { dir: listing.dir, row }, unread: [] };
	}
	const unread = listings
		.filter((listing) => listing.why)
		.map((listing) => `${listing.dir}: ${listing.why}`);
	if (listings.length === 0) unread.push("no plan's config dir exists");
	return { holder: null, unread };
}

/**
 * The main transcript's path: the job's `linkScanPath` where its state reads
 * and names this session, else `<dir>/projects/<any>/<sessionId>.jsonl`. Null
 * where neither exists.
 * @param {string} dir
 * @param {string} sessionId
 */
function readTranscriptOf(dir, sessionId) {
	const linked = readOwnJob(sessionId, { seats: [dir] })?.job.linkScanPath;
	if (typeof linked === "string" && fs.existsSync(linked)) return linked;
	let projects;
	try {
		projects = fs.readdirSync(path.join(dir, "projects"));
	} catch {
		return null;
	}
	for (const p of projects) {
		const f = path.join(dir, "projects", p, `${sessionId}.jsonl`);
		if (fs.existsSync(f)) return f;
	}
	return null;
}

/**
 * Every subagent transcript's size, from the `.jsonl` files under the
 * session's own `<sessionId>/` directory beside its main transcript.
 * @param {string} mainTranscript
 * @param {string} sessionId
 */
function subagentSizes(mainTranscript, sessionId) {
	/** @type {Map<string, number>} */
	const out = new Map();
	/** @param {string} d */
	const walk = (d) => {
		let entries;
		try {
			entries = fs.readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.name.endsWith(".jsonl")) {
				try {
					out.set(p, fs.statSync(p).size);
				} catch {
					// Deleted since the listing: absent from this sample, as it now is.
				}
			}
		}
	};
	walk(path.join(path.dirname(mainTranscript), sessionId));
	return out;
}

/**
 * The status marker the session's last turn ended on — `needs input:`,
 * `result:`, `waiting:` — or where the turn has not ended, "tool call", its last
 * assistant entry being one, or "prompt", a user prompt after it going
 * unanswered. "" where it ended on no marker.
 * @param {string} transcript
 */
function readLastTurnMarker(transcript) {
	const { governingMarker } = require("./lib/status-marker");
	let text;
	try {
		const fd = fs.openSync(transcript, "r");
		try {
			const size = fs.fstatSync(fd).size;
			const len = Math.min(size, TAIL_BYTES);
			const buf = Buffer.alloc(len);
			fs.readSync(fd, buf, 0, len, size - len);
			text = buf.toString("utf8");
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		// takeSample has already stat'd it, so an unreadable transcript is UNKNOWN there.
		return "";
	}
	for (const line of text.split("\n").reverse()) {
		let j;
		try {
			j = JSON.parse(line);
		} catch {
			continue;
		}
		if (isUserPrompt(j)) return "prompt";
		if (j.type !== "assistant" || !Array.isArray(j.message?.content)) continue;
		/** @type {ContentBlock[]} */
		const content = j.message.content;
		if (content.some((c) => c.type === "tool_use")) return "tool call";
		const said = content
			.filter((c) => c.type === "text")
			.map((c) => c.text || "")
			.join("\n");
		return governingMarker(said).name;
	}
	return "";
}

/**
 * A transcript entry that is a person's prompt — not a tool result, and not an
 * injected `<system-reminder>` or hook payload, which open with a tag.
 * @param {any} j
 */
function isUserPrompt(j) {
	if (j.type !== "user") return false;
	const c = j.message?.content;
	if (typeof c === "string") return !c.startsWith("<");
	return (
		Array.isArray(c) &&
		c.some((b) => b.type === "text" && !String(b.text ?? "").startsWith("<"))
	);
}

/**
 * `/proc/<pid>/stat`'s parent, CPU ticks and start time.
 * @param {string[] | null} f the line's fields
 */
function parseProcStat(f) {
	if (!f) return null;
	const ppid = Number(f[FIELD.ppid]);
	const ticks = Number(f[FIELD.utime]) + Number(f[FIELD.stime]);
	if (!Number.isFinite(ppid) || !Number.isFinite(ticks)) return null;
	return { ppid, ticks, start: f[FIELD.start] ?? "" };
}

/**
 * The CPU ticks of `pid` and of each of its descendants, keyed `pid:start` so
 * a reused pid is a new process — a HELPER_ARGV match and its whole subtree
 * left out and only counted. Null where /proc or `pid` itself will not read.
 * @param {number} pid
 */
function readProcTree(pid) {
	const root = procRoot();
	let entries;
	try {
		entries = fs.readdirSync(root).filter((e) => /^\d+$/.test(e));
	} catch {
		return null;
	}
	/** @type {Map<number, ProcRow[]>} */
	const children = new Map();
	/** @type {ProcRow | null} */
	let self = null;
	for (const e of entries) {
		const row = readProcRow(root, e);
		if (!row) continue;
		if (row.pid === pid) self = row;
		const siblings = children.get(row.ppid) ?? [];
		siblings.push(row);
		children.set(row.ppid, siblings);
	}
	if (!self) return null;
	const { kids, helpers } = descendantsOf(children, pid);
	return { self: self.ticks, kids, helpers };
}

/**
 * One /proc entry as a row, or null where it exited between the listing and
 * the read or its stat will not parse.
 * @param {string} root
 * @param {string} e
 * @returns {ProcRow | null}
 */
function readProcRow(root, e) {
	/* Unread where it exited between the listing and the read. */
	const parsed = parseProcStat(readStatFields(e, root));
	if (!parsed) return null;
	return { pid: Number(e), argv: readProcArgv(root, e), ...parsed };
}

/**
 * @param {string} root
 * @param {string} e
 */
function readProcArgv(root, e) {
	try {
		return fs
			.readFileSync(path.join(root, e, "cmdline"), "utf8")
			.replace(/\0+$/, "")
			.split("\0")
			.join(" ");
	} catch {
		// Exited after its stat read: an empty argv matches no helper, so its CPU counts.
		return "";
	}
}

/**
 * @param {Map<number, ProcRow[]>} children
 * @param {number} pid
 */
function descendantsOf(children, pid) {
	/** @type {Map<string, ProcRow>} */
	const kids = new Map();
	let helpers = 0;
	const stack = [pid];
	while (stack.length > 0) {
		const parent = /** @type {number} */ (stack.pop());
		for (const k of children.get(parent) ?? []) {
			if (k.pid === pid || kids.has(`${k.pid}:${k.start}`)) continue;
			if (HELPER_ARGV.some((re) => re.test(k.argv))) {
				helpers++;
				continue;
			}
			kids.set(`${k.pid}:${k.start}`, k);
			stack.push(k.pid);
		}
	}
	return { kids, helpers };
}

/**
 * A live holder's process tree, or null where its row records no pid.
 * @param {AgentRecord} row
 */
function readLiveProcTree(row) {
	return row.pid ? readProcTree(row.pid) : null;
}

/**
 * One sample of everything the verdict reads, off a listing already taken.
 * /proc is read only for a holder that is listed and not terminal: an ended
 * session's pid proves nothing either way.
 *
 * @param {PlanListing[]} listings
 * @param {string} sessionId
 * @returns {ProbeSample}
 */
function takeSample(listings, sessionId) {
	const { holder: listed, unread } = findHolder(listings, sessionId);
	const records = readSessionRecords(listings, listed, sessionId);
	const holder = listed && { dir: records?.dir ?? listed.dir, row: listed.row };
	const transcript = records?.transcript ?? null;
	const live = holder && !isTerminalAgent(holder.row) ? holder.row : null;
	return {
		holder,
		unread,
		transcript,
		size: readTranscriptSize(transcript),
		subs: transcript ? subagentSizes(transcript, sessionId) : new Map(),
		inFlight: inFlightOf(records?.state),
		limit: limitOf(records?.state),
		tree: live ? readLiveProcTree(live) : undefined,
		marker: transcript ? readLastTurnMarker(transcript) : "",
	};
}

/**
 * The plan holding the session's transcript, with its job record where that
 * record names the session.
 *
 * A union oracle (WFC_CLAUDE_BIN=claude-agents-union) lists every session on
 * every plan, so the listing plan need not be the session's own: the plan
 * holding its transcript is, and where two do, the one whose job record
 * names it — a record under the same short id may be another session's
 * (#1146). The listing plan is tried first, so a plain oracle's answer holds.
 *
 * @param {PlanListing[]} listings
 * @param {{dir: string} | null | undefined} listed
 * @param {string} sessionId
 */
function readSessionRecords(listings, listed, sessionId) {
	const dirs = new Set(listed ? [listed.dir] : []);
	for (const l of listings) dirs.add(l.dir);
	/** @type {{dir: string, transcript: string, state: any} | null} */
	let records = null;
	for (const d of dirs) {
		const transcript = readTranscriptOf(d, sessionId);
		if (!transcript) continue;
		const state = readOwnJob(sessionId, { seats: [d] })?.job ?? null;
		if (state || !records) records = { dir: d, transcript, state };
		if (state) break;
	}
	return records;
}

/**
 * The transcript's size, or null where there is none or it will not stat —
 * which probeVerdict reads as UNKNOWN.
 * @param {string | null} transcript
 */
function readTranscriptSize(transcript) {
	if (!transcript) return null;
	try {
		return fs.statSync(transcript).size;
	} catch {
		return null;
	}
}

/**
 * The job record's in-flight counts, or null where it carries none.
 * @param {any} state the job record's `state`, read off disk unvalidated —
 *   `any` as the probe's record type gives it; every field is coerced here
 */
function inFlightOf(state) {
	const f = state?.inFlight;
	return f && typeof f === "object"
		? { tasks: Number(f.tasks) || 0, queued: Number(f.queued) || 0 }
		: null;
}

/**
 * The job record's limit message, or null where its detail is anything else.
 * @param {any} state the job record's `state`, as inFlightOf's
 */
function limitOf(state) {
	const detail = typeof state?.detail === "string" ? state.detail : "";
	return LIMIT_MESSAGE.test(detail) ? detail : null;
}

/** @typedef {Exclude<keyof typeof PROBE_EXIT, "GHOST">} SampledVerdict */

/**
 * The verdict two samples make, with the evidence lines behind it. First
 * match wins, in the order of the table above.
 *
 * @param {ProbeSample} before
 * @param {ProbeSample} after
 * @returns {{verdict: SampledVerdict, why: string, evidence: string[]}}
 */
function probeVerdict(before, after) {
	const measured = probeEvidence(before, after);
	const { evidence } = measured;
	const row = after.holder?.row;

	/** @param {SampledVerdict} verdict @param {string} why */
	const say = (verdict, why) => ({ verdict, why, evidence });

	const unreadable = [before, after].flatMap((s, i) =>
		unreadableInputs(s, i ? "second sample" : "first sample"),
	);
	if (unreadable.length > 0) return say("UNKNOWN", unreadable.join("; "));

	if (!row) return say("ENDED", "listed by no plan");
	if (isTerminalAgent(row))
		return say("ENDED", `oracle lists it terminal (${row.state})`);

	if (row.state === "blocked" && after.limit)
		return say("LIMITED", `oracle state blocked on its limit: ${after.limit}`);
	if (row.state === "needs_input" || row.state === "blocked")
		return say("ASKING", `oracle state ${row.state}`);
	if (after.marker === "needs input:")
		return say("ASKING", "its last turn ended on needs input:");

	const inFlight = Boolean(
		after.inFlight && (after.inFlight.tasks || after.inFlight.queued),
	);
	if (after.marker === "result:" && !inFlight)
		return say("DONE", "its last turn ended on result:, nothing in flight");

	const slow = slowWhy(before, after, measured, inFlight);
	if (slow) return say("SLOW", slow);

	return say(
		"FROZEN",
		after.marker === "waiting:"
			? "turn ended on waiting: with nothing left running (lost wake)"
			: "nothing grew, nothing in flight, no descendant CPU",
	);
}

/**
 * Why a listed, live session that is neither asking nor done reads SLOW, or
 * null where nothing moved between the samples.
 *
 * @param {ProbeSample} before
 * @param {ProbeSample} after
 * @param {{grownSubs: Array<[string, number]>, busy: number}} measured
 * @param {boolean} inFlight
 */
function slowWhy(before, after, { grownSubs, busy }, inFlight) {
	if (before.size !== after.size) return "the main transcript changed size";
	const newSubs = [...after.subs.keys()].filter((p) => !before.subs.has(p));
	if (grownSubs.length > 0 || newSubs.length > 0)
		return "a subagent transcript changed size";
	if (inFlight) return "state.json shows work in flight";
	if (busy / CLK_TCK >= PROBE_CPU_FLOOR_S)
		return "a descendant process spent CPU";
	return null;
}

/**
 * The inputs one sample could not read, each as an evidence clause.
 * @param {ProbeSample} s
 * @param {string} at
 */
function unreadableInputs(s, at) {
	const out = [];
	if (!s.holder && s.unread.length > 0)
		out.push(`${at}: holder in no plan that read, and ${s.unread.join("; ")}`);
	if (s.size === null) out.push(`${at}: transcript would not read`);
	if (s.tree === null)
		out.push(`${at}: /proc would not read for the session's process`);
	return out;
}

/**
 * The evidence lines two samples give, with the subagent transcripts that
 * grew and the descendants' CPU ticks the verdict reads.
 *
 * @param {ProbeSample} before
 * @param {ProbeSample} after
 */
function probeEvidence(before, after) {
	/** @type {string[]} */
	const evidence = [];
	const row = after.holder?.row;
	evidence.push(
		row
			? `oracle: state ${row.state ?? "?"}, kind ${row.kind ?? "?"}, pid ${row.pid ?? "?"}, on plan ${after.holder?.dir}`
			: "oracle: listed by no plan that read",
	);
	evidence.push(
		after.transcript
			? `transcript: ${after.transcript} ${before.size ?? "?"}B -> ${after.size ?? "?"}B`
			: "transcript: none found",
	);
	const grownSubs = [...after.subs].filter(
		([p, n]) => before.subs.get(p) !== n,
	);
	evidence.push(
		`subagents: ${after.subs.size} transcript(s), ${grownSubs.length} changed size`,
	);
	evidence.push(
		after.inFlight
			? `in flight: ${after.inFlight.tasks} task(s), ${after.inFlight.queued} queued (state.json)`
			: "in flight: state.json unread",
	);
	let busy = 0;
	if (before.tree && after.tree) {
		for (const [key, k] of after.tree.kids)
			busy += k.ticks - (before.tree.kids.get(key)?.ticks ?? 0);
		evidence.push(
			`cpu: session +${((after.tree.self - before.tree.self) / CLK_TCK).toFixed(2)}s, descendants +${(busy / CLK_TCK).toFixed(2)}s (${after.tree.helpers} helper(s) excluded, floor ${PROBE_CPU_FLOOR_S}s)`,
		);
	}
	const turn = {
		"tool call": "still open on a tool call",
		prompt: "a user prompt after it is unanswered",
		"": "ended on no marker",
	}[after.marker];
	evidence.push(`last turn: ${turn ?? `ended on ${after.marker}`}`);
	return { evidence, grownSubs, busy };
}

/**
 * The session `--issue`/`--session` names, as its full id — or a refusal.
 *
 * @param {ParsedArgs} args
 * @param {string[]} dirs
 * @param {PlanListing[]} listings
 * @param {string} cmd  the verb a refusal names: "probe" or "take over"
 * @returns {{sessionId: string, issue: number | null} | {refuse: string}}
 */
function resolveHolder(args, dirs, listings, cmd) {
	const me = process.env.CLAUDE_CODE_SESSION_ID || "";
	const issue = args.issue === undefined ? null : Number(args.issue);
	if (issue !== null && !(Number.isInteger(issue) && issue > 0))
		return { refuse: "--issue takes an issue number" };

	if (typeof args.session !== "string" || !args.session)
		return holderOfIssue(issue, me, cmd, dirs);

	const id = args.session;
	const { full, held } = readSessionsMatching(id, dirs, listings);
	const [sessionId, ...others] = full;
	if (sessionId === undefined)
		return {
			refuse: `no plan, job record, transcript or claim knows a session ${id} — check the id, or ask the founder which session they meant`,
		};
	if (others.length > 0)
		return {
			refuse: `${id} matches ${full.size} sessions — give the full id: ${[...full].join(", ")}`,
		};
	if (sessionId === me)
		return { refuse: `${id} is this session — check the id you were given` };
	if (issue !== null && !held.has(issue))
		return {
			refuse: `${id} holds no claim on #${issue} — check the number, or drop --issue to take the ticket it does hold`,
		};
	if (issue === null && held.size > 1)
		return onlyOpenClaim(id, sessionId, held, cmd);
	const [heldIssue] = held;
	return { sessionId, issue: issue ?? heldIssue ?? null };
}

/**
 * The one other session holding a claim on `issue` — or, where none does, the
 * one other job whose intent names it (#1989). Else a refusal.
 * @param {number | null} issue
 * @param {string} me
 * @param {string} cmd
 * @param {string[]} dirs
 * @returns {{sessionId: string, issue: number} | {refuse: string}}
 */
function holderOfIssue(issue, me, cmd, dirs) {
	const claims = require("./lib/arbiter-issue-claims");
	if (issue === null)
		return { refuse: `${cmd} needs --issue <n> or --session <id>` };
	const claimed = claims
		.readIssueClaims(issue)
		.map((e) => e.record?.sessionId ?? "")
		.filter((s) => s && s !== me);
	const holders = claimed.length > 0 ? claimed : jobsNaming(issue, me, dirs);
	const [holder, ...others] = holders;
	if (holder === undefined)
		return {
			refuse: `nothing to ${cmd}: no other session holds a claim on #${issue}, and no ${[...STUCK_STATES].join("/")} job's intent names it — name the session with --session, or claim the ticket with claim-issue.js`,
		};
	if (others.length > 0)
		return {
			refuse: `#${issue} has ${holders.length} holders — name one with --session: ${holders.join(", ")}`,
		};
	return { sessionId: holder, issue };
}

/* A launch intent's command and the issue list straight after it, so
 * `/implement 1878 — RESUMED from session 3` names 1878 and not 3. */
const INTENT_ISSUES = /^\/[\w:-]+\s+([#\d\s,]+)/;

/**
 * The session ids of every job on `dirs`, other than this one, still in a
 * STUCK_STATES state and whose intent names `issue`.
 * @param {number} issue
 * @param {string} me
 * @param {string[]} dirs
 */
function jobsNaming(issue, me, dirs) {
	const { issuesIn } = require("./lib/dispatch-ledger");
	/** @type {Set<string>} */
	const out = new Set();
	for (const j of dirs.flatMap(readJobsOn)) {
		if (!STUCK_STATES.has(j.state) || !j.sessionId || j.sessionId === me)
			continue;
		const named = j.intent.match(INTENT_ISSUES)?.[1] ?? "";
		if (issuesIn(named).includes(issue)) out.add(j.sessionId);
	}
	return [...out];
}

/**
 * Every job on plan `dir`: none where it has no jobs/ (#1989). Any other
 * failure to read is doubt, and throws.
 * @param {string} dir
 * @returns {Job[]}
 */
function readJobsOn(dir) {
	try {
		return readJobs(dir).jobs;
	} catch (e) {
		if (caught(e).code === "ENOENT") return [];
		throw e;
	}
}

/**
 * Every full session id `id` widens to — off the issue-claim store, each
 * plan's job records and transcripts, and the listings, in that order — with
 * the issues the matching claims hold.
 * @param {string} id
 * @param {string[]} dirs
 * @param {PlanListing[]} listings
 */
function readSessionsMatching(id, dirs, listings) {
	const claims = require("./lib/arbiter-issue-claims");
	/** @type {Set<string>} */
	const full = new Set();
	const listed = claims.listIssueClaims();
	/** @type {Set<number>} */
	const held = new Set();
	for (const c of listed?.claims ?? []) {
		if (!c.sessionId || !idMatches(c.sessionId, id)) continue;
		full.add(c.sessionId);
		held.add(c.issue);
	}
	for (const d of dirs) {
		const s = readJobRecord(d, shortJobId(id))?.sessionId;
		if (typeof s === "string" && idMatches(s, id)) full.add(s);
		if (id.length !== 8 && readTranscriptOf(d, id)) full.add(id);
	}
	addListedMatches(full, id, listings);
	return { full, held };
}

/**
 * @param {Set<string>} full accumulator: each listed session id matching `id` is added
 * @param {string} id
 * @param {PlanListing[]} listings
 */
function addListedMatches(full, id, listings) {
	for (const listing of listings)
		for (const agent of listing.agents ?? [])
			if (idMatches(agent.sessionId, id)) full.add(agent.sessionId);
}

/**
 * The one open ticket among the several `sessionId` holds claims on — or a
 * refusal naming them.
 * @param {string} id  the id as given
 * @param {string} sessionId
 * @param {Set<number>} held
 * @param {string} cmd
 * @returns {{sessionId: string, issue: number} | {refuse: string}}
 */
function onlyOpenClaim(id, sessionId, held, cmd) {
	const tickets = [...held].map((n) => `#${n}`).join(", ");
	const read = openIssues([...held]);
	if ("why" in read)
		return {
			refuse: `${id} holds claims on ${tickets} (the tracker would not read to rule out closed ones: ${read.why}) — name one with --issue`,
		};
	const [onlyOpen, ...moreOpen] = read.open;
	if (onlyOpen === undefined)
		return {
			refuse: `${id} holds claims only on closed tickets (${tickets}) — nothing to ${cmd}. Check the ticket number with the founder; a stale claim on a closed ticket blocks no open work.`,
		};
	if (moreOpen.length === 0) return { sessionId, issue: onlyOpen };
	const closed = [...held].filter((n) => !read.open.includes(n));
	const note =
		closed.length > 0
			? ` (${closed.map((n) => `#${n}`).join(", ")} closed)`
			: "";
	return {
		refuse: `${id} holds claims on ${tickets}${note} — name one with --issue`,
	};
}

/**
 * Which of `issues` the tracker reads as open (#648): a closed ticket's claim
 * is stale, and never the one a takeover adopts. Where any read fails, why —
 * doubt never picks a ticket.
 * @param {number[]} issues
 * @returns {{open: number[]} | {why: string}}
 */
function openIssues(issues) {
	const { requireKey } = require("./lib/workflow-core-config.js");
	const { readIssue } = require("./lib/tracker-ops.js");
	const { parseErrLine } = require("./lib/gh.js");
	try {
		const repo = requireKey("tracker");
		return {
			open: issues.filter((n) => readIssue(repo, n).state === "open"),
		};
	} catch (e) {
		return { why: parseErrLine(e) };
	}
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @typedef {{dir: string, rec: any, row: AgentRecord | undefined}} GhostJob
 *   the ghost's plan, its job record — `any`, as `readOwnJob` parses it off disk,
 *   printed as found — and its oracle row where one lists it
 */

/**
 * The GHOST verdict off one sample, or null where the session is not one:
 * lib/hung-jobs.js's GHOST-JOB test, plus no transcript — a session that wrote
 * one took a turn, so the two samples judge it. A plan that would not read,
 * where no plan lists the session, is doubt, not absence.
 * @param {PlanListing[]} listings
 * @param {string} sessionId
 * @param {ProbeSample} sample
 * @returns {{verdict: "GHOST", why: string, evidence: string[], ghost: GhostJob} | null}
 */
function ghostVerdict(listings, sessionId, sample) {
	const { ghostTest, livenessOf } = require("./lib/hung-jobs");
	if (sample.transcript || (!sample.holder && sample.unread.length > 0))
		return null;
	if (sample.holder && isTerminalAgent(sample.holder.row)) return null;
	const own = readOwnJob(sessionId, { seats: listings.map((l) => l.dir) });
	if (own?.job.state !== "working") return null;
	const found = { dir: own.seat, rec: own.job };
	const listed = livenessOf(listings.flatMap((l) => l.agents ?? []));
	if (!listed.ids) return null;
	const ghost = ghostTest(found.rec, listed);
	if (typeof ghost === "string") return null;
	const age =
		ghost.age === null ? "an unreadable time" : `${Math.floor(ghost.age)}m`;
	return {
		verdict: "GHOST",
		why: `${ghost.reason}, no transcript, record "working" for ${age}`,
		evidence: [
			sample.holder
				? `oracle: listed ${sample.holder.row.state ?? "?"} with no pid, on plan ${sample.holder.dir}`
				: "oracle: listed by no plan",
			"transcript: none found",
			`job record: ${found.dir}, state working, detail "${found.rec.detail ?? ""}", updated ${found.rec.updatedAt ?? "?"}`,
		],
		ghost: { ...found, row: sample.holder?.row },
	};
}

/**
 * Resolve the named holder and take the two samples. Dies on a bad invocation
 * or a refusal from resolveHolder, before anything is sampled.
 * @param {ParsedArgs} args
 * @param {string} cmd
 */
async function sampleHolder(args, cmd) {
	const { sessionDirs } = require("./lib/arbiter-core");
	const interval =
		args.interval === undefined ? PROBE_INTERVAL_S : Number(args.interval);
	if (!(Number.isFinite(interval) && interval > 0))
		die("--interval takes a positive number of seconds");
	const dirs = sessionDirs();

	const first = await readPlanListings(dirs);
	const who = resolveHolder(args, dirs, first, cmd);
	if ("refuse" in who) die(who.refuse);
	const before = takeSample(first, who.sessionId);
	const ghost = ghostVerdict(first, who.sessionId, before);
	if (ghost) return { who, dirs, after: before, ...ghost };
	await sleep(interval * 1000);
	const after = takeSample(await readPlanListings(dirs), who.sessionId);
	return { who, dirs, after, ...probeVerdict(before, after), ghost: null };
}

/**
 * The verdict line and its evidence, as probe prints them.
 * @param {{verdict: string, why: string, evidence: string[],
 *   who: {sessionId: string, issue: number | null}}} v
 */
const buildVerdictText = (v) =>
	`${v.verdict}  ${v.who.sessionId.slice(0, 8)}${v.who.issue ? ` (#${v.who.issue})` : ""}  ${v.why}\n${v.evidence.map((e) => `  ${e}\n`).join("")}`;

/** @param {ParsedArgs} args */
async function cmdProbe(args) {
	const v = await sampleHolder(args, "probe");
	// writeFd: run through Bash, stdout is a pipe that process.exit truncates.
	writeFd(1, buildVerdictText(v));
	process.exit(PROBE_EXIT[v.verdict]);
}

/*
 * ── takeover: stop a frozen session and adopt its ticket (#621, spec #617) ──
 *
 * The probe, then on FROZEN, LIMITED (#2158) or ENDED — or the SLOW or ASKING verdict
 * `--despite` names, once the founder has ruled it stuck (#622): snapshot ->
 * stop (all but an unlisted ENDED) -> confirm the stop off the holder's own
 * plan -> claim -> assign -> comment. Every refusal comes before the snapshot,
 * the first write.
 *
 * ON GHOST (#1989): keep its job record -> stop -> confirm -> print the
 * re-dispatch command. Nothing is claimed, commented or adopted.
 *
 * A LISTED ENDED HOLDER IS STOPPED TOO (#623). Its host runs on until stopped,
 * and the file-claim guard judges a holder by its process alone, so every file
 * it claimed would refuse the successor. Its failure only warns: the ticket
 * claim already reads a terminal holder as ended (#619).
 *
 *   0     taken over
 *   1     re-run or act on the message: the ticket would not read, or a step
 *         failed part-way — the stop, its confirmation, the claim (a third
 *         session's included), the assignment or the comment. An ENDED
 *         holder's stop is the exception: it only warns, exiting 0
 *   2     refused before any write: bad invocation, no holder, self, several
 *         holders or tickets, a closed ticket
 *   3-8   refused on the probe's verdict, with the probe's exit code
 */

/** What to do next, per verdict the takeover refuses on, for `ticket`. */
const VERDICT_REFUSAL = {
	UNKNOWN: () =>
		"Nothing stopped — doubt never stops a session. Re-run takeover; if it stays UNKNOWN, ask the founder, naming the unreadable input above.",
	ASKING: () =>
		'Nothing stopped — it is waiting on an answer. Answer its question, or put it to the founder; if they rule it stuck, re-run with --despite ASKING --reason "<their ruling>".',
	SLOW: () =>
		'Nothing stopped — it is still working. Wait and re-run takeover later, or put the verdict to the founder; if they rule it stuck, re-run with --despite SLOW --reason "<their ruling>".',
	DONE: (/** @type {string} */ ticket) =>
		`Nothing stopped or adopted — its work finished. Release its claim or close ${ticket} instead.`,
};

/**
 * Re-read `dir`'s oracle until `sessionId` is terminal or unlisted, or
 * `ceilingS` passes. A listing that will not read is not yet a confirmation.
 * `requireGone` accepts only unlisted, with `hostPid`, where known, exited.
 * @param {string} dir
 * @param {string} sessionId
 * @param {number} ceilingS
 * @param {{requireGone?: boolean, hostPid?: number | null}} [opts]
 * @returns {Promise<string | null>} how the stop was confirmed, or null
 */
async function confirmStopped(
	dir,
	sessionId,
	ceilingS,
	{ requireGone = false, hostPid = null } = {},
) {
	const hostRuns = () =>
		hostPid !== null && fs.existsSync(path.join(procRoot(), String(hostPid)));
	const deadline = Date.now() + ceilingS * 1000;
	const poll = Math.min(1000, (ceilingS * 1000) / 5);
	for (;;) {
		const [listing] = await readPlanListings([dir]);
		const how = stopConfirmation(listing, sessionId, requireGone, hostRuns);
		if (how) return how;
		if (Date.now() >= deadline) return null;
		await sleep(poll);
	}
}

/**
 * How one listing confirms the stop, or null where it does not yet.
 * @param {PlanListing | undefined} listing
 * @param {string} sessionId
 * @param {boolean} requireGone
 * @param {() => boolean} hostRuns
 */
function stopConfirmation(listing, sessionId, requireGone, hostRuns) {
	if (!listing?.agents) return null;
	const row = listing.agents.find((a) => a.sessionId === sessionId);
	if (!row && !(requireGone && hostRuns()))
		return requireGone ? "unlisted, its host exited" : "no longer listed";
	if (row && !requireGone && isTerminalAgent(row)) return `listed ${row.state}`;
	return null;
}

/**
 * The dead session's file claims, each marked dirty or clean in the tree.
 * @param {string} sessionId
 */
function readFileClaimLines(sessionId) {
	const store = require("./lib/arbiter-store");
	const held = store.readHeldBy(sessionId);
	if (held === null) return ["  (the file-claim store would not read)"];
	if (held.length === 0) return ["  (none)"];
	return held.map((p) => {
		const d = store.subjectDirty(p);
		if (d === null) return `  ${p} — unknown`;
		return `  ${p} — ${d ? "dirty" : "clean"}`;
	});
}

/** @typedef {import("./lib/tracker-ops.js").ScriptIo} ScriptIo */
/**
 * @typedef {{dir: string, jobId: string, sessionId: string, ceiling: number,
 *   short: string, kept: string, row: AgentRecord | undefined}} StopTarget
 */

/** @param {ParsedArgs} args */
async function cmdTakeover(args) {
	const tracker = require("./lib/tracker-ops.js");
	/** @type {ScriptIo} */
	const io = tracker.scriptIo("rescue-sessions takeover");

	const { me, ceiling } = takeoverOptions(args, io);
	const { despite, reason } = args;
	const repo = io.trackerOrFail();

	const v = await sampleHolder(args, "take over");
	const { who, after } = v;
	writeFd(1, buildVerdictText(v));
	if (v.verdict === "GHOST") return stopGhost(io, who, v.ghost, ceiling);
	/* Out of scope (#2570), and `claude stop` cannot reach one (#2608). */
	if (after.holder?.row.kind === "headless")
		io.fail(
			`${who.sessionId} is a headless overflow run, which takeover does not handle. Stop it with node scripts/lib/headless-sessions.js stop ${after.holder.row.id}. Nothing written.`,
			2,
		);
	const n = who.issue;
	if (n === null)
		io.fail(
			`${who.sessionId} holds no ticket claim — name the ticket with --issue. Nothing written.`,
			2,
		);
	const overruled = v.verdict === despite;
	if (
		v.verdict !== "FROZEN" &&
		v.verdict !== "LIMITED" &&
		v.verdict !== "ENDED" &&
		!overruled
	)
		io.fail(
			`not taking over: ${v.verdict}. ${VERDICT_REFUSAL[v.verdict](`#${n}`)}`,
			PROBE_EXIT[v.verdict],
		);
	const issue = readOpenIssue(io, repo, n);

	// The plan whose records hold the session, or, for one no plan lists, the
	// plan whose transcript the probe read.
	const dir =
		after.holder?.dir ??
		v.dirs.find((d) => readTranscriptOf(d, who.sessionId) === after.transcript);
	if (!dir || !after.transcript)
		io.fail(
			"no plan holds the session's transcript, so there is nothing to resume from — ask the founder. Nothing written.",
			2,
		);
	const short = shortJobId(who.sessionId);
	const row = after.holder?.row;

	const out = rescueDir(n, short);
	const { job } = snapshotJob(
		dir,
		out,
		readTakeoverJob(dir, who.sessionId, after.transcript, row),
	);
	fs.writeFileSync(
		path.join(out, "index.json"),
		`${JSON.stringify([job], null, 2)}\n`,
	);
	io.out(`snapshot: ${out}\n`);
	const kept = `No claim taken; the snapshot is still on disk at ${out}.`;

	/** @type {StopTarget} */
	const target = {
		dir,
		jobId: jobIdOf(row, who.sessionId),
		sessionId: who.sessionId,
		ceiling,
		short,
		kept,
		row,
	};
	const claimsStuck = await stopHolder(io, v, target);

	adoptClaim(io, n, me, target);

	let failed = false;
	const assignError = tracker.assignSelf(repo, n);
	if (assignError) {
		failed = true;
		io.warn(
			`assigning #${n} failed (${assignError}) — gh issue edit ${n} --add-assignee @me`,
		);
	}
	const comment = buildTakeoverComment({
		me,
		sessionId: who.sessionId,
		name: job.name,
		dir,
		verdict: v.verdict,
		why: v.why,
		evidence: v.evidence,
		overruled,
		reason,
		out,
		claimsStuck,
	});
	if (!postComment(io, { repo, n, out }, comment)) failed = true;

	const resume = buildResumptionText(job, {
		n,
		title: issue.title,
		out,
		short,
		sessionId: who.sessionId,
		claimsStuck,
	});
	fs.writeFileSync(path.join(out, "RESUMPTION.md"), `${resume}\n`);
	io.out(`\n${resume}\n`);
	process.exit(failed ? 1 : 0);
}

/**
 * The takeover's own flags, refused before anything is read: this session's
 * id, the stop-confirmation ceiling, and any --despite with its reason.
 * @param {ParsedArgs} args
 * @param {ScriptIo} io
 */
function takeoverOptions(args, io) {
	const me = process.env.CLAUDE_CODE_SESSION_ID;
	if (!me)
		io.fail(
			"CLAUDE_CODE_SESSION_ID is unset — a takeover adopts the ticket for this session, and there is none. Run it from inside a Claude session. Nothing written.",
			2,
		);
	const ceiling =
		args["confirm-within"] === undefined
			? STOP_CONFIRM_CEILING_S
			: Number(args["confirm-within"]);
	if (!(Number.isFinite(ceiling) && ceiling > 0))
		io.fail("--confirm-within takes a positive number of seconds", 2);
	checkDespite(args, io);
	return { me, ceiling };
}

/**
 * Refuse a --despite that names no verdict a founder can overrule, or comes
 * without the --reason that records the ruling — and a --reason without it.
 * @param {ParsedArgs} args
 * @param {ScriptIo} io
 */
function checkDespite(args, io) {
	const { despite, reason } = args;
	if (despite === undefined) {
		if (reason !== undefined)
			io.fail("--reason goes with --despite SLOW|ASKING. Nothing written.", 2);
	} else if (despite !== "SLOW" && despite !== "ASKING")
		io.fail(
			`--despite takes SLOW or ASKING, not ${despite}. ${despite === "UNKNOWN" || despite === "DONE" ? VERDICT_REFUSAL[despite](args.issue ? `#${args.issue}` : "its ticket") : "Nothing written."}`,
			2,
		);
	else if (!(typeof reason === "string" && reason.trim()))
		io.fail(
			`--despite needs --reason "<the founder's ruling that it is stuck>". Nothing written.`,
			2,
		);
}

/**
 * Ticket `n`, read and open — or the takeover fails, nothing written.
 * @param {ScriptIo} io
 * @param {string} repo
 * @param {number} n
 */
function readOpenIssue(io, repo, n) {
	const tracker = require("./lib/tracker-ops.js");
	const { parseErrLine } = require("./lib/gh.js");
	let issue;
	try {
		issue = tracker.readIssue(repo, n);
	} catch (e) {
		io.fail(
			`could not read #${n} from ${repo} (${parseErrLine(e)}). Nothing written — re-run.`,
			1,
		);
	}
	if (issue.state !== "open")
		io.fail(
			`#${n} is ${issue.state} — nothing to adopt. Ask the founder whether it should be reopened. Nothing written.`,
			2,
		);
	return issue;
}

/**
 * The session's job record off `dir`, or one built from the probe where the
 * plan keeps none — its transcript the probe's where the record's is gone.
 * @param {string} dir
 * @param {string} sessionId
 * @param {string} transcript
 * @param {AgentRecord | undefined} row
 * @returns {Job}
 */
function readTakeoverJob(dir, sessionId, transcript, row) {
	const core = require("./lib/arbiter-core");
	const short = shortJobId(sessionId);
	/** @type {Job} */
	const job = readJobs(dir).jobs.find((j) => j.short === short) ?? {
		short,
		state: row?.state ?? "unlisted",
		detail: "",
		intent: "",
		name: row?.name ?? "",
		sessionId,
		transcript,
		model: "",
		updatedAt: fs.statSync(transcript).mtime.toISOString(),
		cwd: row?.cwd ?? core.repoRoot(),
	};
	if (!job.transcript || !fs.existsSync(job.transcript))
		job.transcript = transcript;
	return job;
}

/**
 * Stop a GHOST, keeping its job record first, and print the command that re-dispatches its intent.
 * Exits 0 once stopped, 1 where the stop or its confirmation fails.
 * @param {ScriptIo} io
 * @param {{sessionId: string, issue: number | null}} who
 * @param {GhostJob} ghost
 * @param {number} ceiling
 * @returns {Promise<never>}
 */
async function stopGhost(io, who, { dir, rec, row }, ceiling) {
	const short = shortJobId(who.sessionId);
	const kept = path.join(
		rescueDir(who.issue ?? "ghost", short),
		`${short}.state.json`,
	);
	fs.writeFileSync(kept, `${JSON.stringify(rec, null, 2)}\n`);
	io.out(`kept: ${kept}\n`);
	await stopLiveHolder(io, {
		dir,
		jobId: jobIdOf(row, who.sessionId),
		sessionId: who.sessionId,
		ceiling,
		short,
		kept: `Its job record is kept at ${kept}.`,
		row,
	});
	io.out(
		`\nNothing ran, so nothing is adopted. ${buildRedispatchText(rec, kept)}\n`,
	);
	process.exit(0);
}

/**
 * The command that re-launches a ghost's intent as it was launched: its model,
 * and `--no-advisor` where it ran with none. `--force` where its own launch is
 * still inside the dispatch ledger's window, which would otherwise refuse it.
 * @param {any} rec  the ghost's job record, as `GhostJob` carries it
 * @param {string} kept  where that record was copied
 */
function buildRedispatchText(rec, kept) {
	const { shellQuote } = require("./lib/dispatch-rewrite");
	const {
		DEFAULT_WINDOW_HOURS,
		commandOf,
		entryHolds,
		issuesIn,
		readRecentEntries,
	} = require("./lib/dispatch-ledger");
	const flags = Array.isArray(rec.respawnFlags) ? rec.respawnFlags : [];
	const model = modelOf(flags);
	const intent = typeof rec.intent === "string" ? rec.intent : "";
	if (!intent || !model)
		return `Its record names ${intent ? "no model" : "no intent"} — re-dispatch it by hand from ${kept}.`;
	const issues = issuesIn(intent.match(INTENT_ISSUES)?.[1] ?? "");
	const held = readRecentEntries(undefined, DEFAULT_WINDOW_HOURS).entries.some(
		(e) =>
			e.issues.some((n) => issues.includes(n)) &&
			entryHolds(e, commandOf(intent)),
	);
	const opts = [
		...(held ? ["--force"] : []),
		...(flags.includes("--advisor") ? [] : ["--no-advisor"]),
	];
	const command = [
		"scripts/dispatch-sessions.sh",
		...opts,
		model,
		shellQuote(intent),
	];
	return `Re-dispatch it:\n  ${command.join(" ")}${held ? "\n--force because its own launch is still inside the dispatch ledger's window; it skips the allowance gate too, so read the allowance first (rescue-sessions skill)." : ""}`;
}

/**
 * `.claude/tmp/rescue/<label>-<short>/`, made.
 * @param {number | string} label  the ticket, or "ghost" where none is known
 * @param {string} short
 */
function rescueDir(label, short) {
	const core = require("./lib/arbiter-core");
	const out = path.join(
		core.repoRoot(),
		".claude",
		"tmp",
		"rescue",
		`${label}-${short}`,
	);
	fs.mkdirSync(out, { recursive: true });
	return out;
}

/**
 * The id `claude stop` takes: the 8-character form `stop --ids` is given, off
 * the oracle row's own id where it carries one, else the session id's.
 * @param {AgentRecord | undefined} row
 * @param {string} sessionId
 */
const jobIdOf = (row, sessionId) => shortJobId(row?.id || sessionId);

/**
 * Stop the holder: a live one stops or the takeover fails; a listed ENDED one
 * only warns where it will not; an unlisted ENDED one is left alone.
 * @param {ScriptIo} io
 * @param {{verdict: string, why: string}} v
 * @param {StopTarget} s
 * @returns {Promise<boolean>} whether its file claims stay held
 */
async function stopHolder(io, v, s) {
	if (v.verdict === "ENDED" && s.row) return stopEndedHolder(io, s, s.row);
	if (v.verdict === "ENDED") {
		io.out(`no stop: ${v.why}\n`);
		return false;
	}
	await stopLiveHolder(io, s);
	return false;
}

/**
 * Stop a listed ENDED holder, warning where it will not stop or confirm gone.
 * @param {ScriptIo} io
 * @param {StopTarget} s
 * @param {AgentRecord} row
 * @returns {Promise<boolean>} whether its file claims stay held
 */
async function stopEndedHolder(io, s, row) {
	const stopped = stopOn(s.dir, s.jobId);
	const how =
		stopped.ok &&
		(await confirmStopped(s.dir, s.sessionId, s.ceiling, {
			requireGone: true,
			hostPid: row.pid ?? null,
		}));
	if (how) {
		io.out(`stopped: ${s.short} on ${s.dir}, ${how}\n`);
		return false;
	}
	const why = stopped.ok
		? `stop sent, but not confirmed gone ${s.ceiling}s after it`
		: `not stopped: ${stopped.why}`;
	io.warn(
		`${why}. Its file claims stay held while its host runs; free each with node scripts/session-arbiter.js release --force <path>`,
	);
	return true;
}

/**
 * @param {ScriptIo} io
 * @param {StopTarget} s
 */
async function stopLiveHolder(io, s) {
	const stopped = stopOn(s.dir, s.jobId);
	if (!stopped.ok)
		io.fail(
			`claude stop failed on ${s.dir}: ${stopped.why}. ${s.kept} Re-run takeover, or ask the founder to stop it.`,
			1,
		);
	io.out(`stopped: ${s.short} on ${s.dir} (${stopped.said})\n`);
	const how = await confirmStopped(s.dir, s.sessionId, s.ceiling);
	if (!how)
		io.fail(
			`${s.dir}'s oracle still lists ${s.short} as live ${s.ceiling}s after the stop. ${s.kept} Re-run takeover once it reads stopped.`,
			1,
		);
	io.out(`confirmed: ${how}\n`);
}

/**
 * Claim ticket `n` for this session — or fail the takeover, naming why.
 * @param {ScriptIo} io
 * @param {number} n
 * @param {string} me
 * @param {StopTarget} s  the stopped session
 */
function adoptClaim(io, n, me, { sessionId, kept }) {
	const tracker = require("./lib/tracker-ops.js");
	const r = tracker.claimIfFree(n, me);
	if (r.status === "held") {
		const other = String(r.holder.sessionId);
		const name = r.names?.get(other);
		const again = other === sessionId;
		io.fail(
			`#${n} is held by live session ${other}${name ? ` (${name})` : ""}, claimed ${r.holder.claimedAt}. ${again ? "The stopped session still reads live — re-run takeover." : "A third session took it meanwhile — leave it to them."} ${kept}`,
			1,
		);
	}
	if (r.status === "busy")
		io.fail(
			`another claim on #${n} held the arbiter's lock past its wait. ${kept} Re-run takeover.`,
			1,
		);
	if (r.status === "unreadable")
		io.fail(`${r.why}. ${kept} Re-run takeover.`, 1);
	if (r.status !== "claimed" && r.status !== "reclaimed")
		io.fail(`the arbiter would not record #${n} (${r.status}). ${kept}`, 1);
	io.out(`claimed: #${n} for ${me}\n`);
}

/**
 * @param {{me: string, sessionId: string, name: string, dir: string,
 *   verdict: string, why: string, evidence: string[], overruled: boolean,
 *   reason: ParsedArgs[string] | undefined, out: string,
 *   claimsStuck: boolean}} t
 */
function buildTakeoverComment(t) {
	const core = require("./lib/arbiter-core");
	return [
		`**Taken over** by session ${t.me}, through \`rescue-sessions.js takeover\`.`,
		"",
		`- ${t.claimsStuck ? "Ended session, not stopped — its file claims stay held" : "Stopped session"}: ${t.sessionId}${t.name ? ` (${t.name})` : ""}`,
		`- Plan: ${t.dir}`,
		`- Verdict: ${t.verdict} — ${t.why}${t.overruled ? " — overruled with --despite" : ""}`,
		...t.evidence.map((e) => `  - ${e}`),
		...(t.overruled ? [`- Reason for overruling: ${t.reason}`] : []),
		`- Snapshot: ${path.relative(core.repoRoot(), t.out)}`,
	].join("\n");
}

/**
 * Post `comment` on ticket `n`; where that fails, leave it in `out` to post by
 * hand and say so.
 * @param {ScriptIo} io
 * @param {{repo: string, n: number, out: string}} ticket
 * @param {string} comment
 * @returns {boolean} whether it posted
 */
function postComment(io, { repo, n, out }, comment) {
	const { parseErrLine, gh } = require("./lib/gh.js");
	try {
		gh(["issue", "comment", String(n), "--repo", repo, "--body-file", "-"], {
			input: comment,
			stdio: ["pipe", "pipe", "pipe"],
		});
		io.out(`commented: #${n}\n`);
		return true;
	} catch (e) {
		fs.writeFileSync(path.join(out, "COMMENT.md"), `${comment}\n`);
		io.warn(
			`commenting on #${n} failed (${parseErrLine(e)}) — post ${path.join(out, "COMMENT.md")} by hand.`,
		);
		return false;
	}
}

/**
 * RESUMPTION.md: what the adopting session reads to continue the work.
 * @param {Job} job
 * @param {{n: number, title: string, out: string, short: string,
 *   sessionId: string, claimsStuck: boolean}} t
 */
function buildResumptionText(job, t) {
	return [
		`Adopted #${t.n} ${t.title}`,
		`Intent: ${job.intent || "(no job record — read the narration's first USER line)"}`,
		`Narration: ${path.join(t.out, `${t.short}.narration.txt`)}`,
		`Death point:\n${job.deathPoint || "(none)"}`,
		`Commits landed: ${buildLandedLine(job)}`,
		`Artefacts survived: ${job.artefactsSurvived && job.artefactsSurvived.length > 0 ? job.artefactsSurvived.join(", ") : "none"}`,
		t.claimsStuck
			? "Its file claims, held while its host runs — free each with node scripts/session-arbiter.js release --force <path>:"
			: "Its file claims, listed and not moved — your next write takes each:",
		...readFileClaimLines(t.sessionId),
		"",
		"Read the narration yourself, then continue its intent in this session.",
	].join("\n");
}

/**
 * The commits-landed clause of RESUMPTION.md.
 * @param {Job} job
 */
function buildLandedLine(job) {
	if (job.commitsLanded === null) return "unreadable (git would not run)";
	if (job.commitsLanded && job.commitsLanded.length > 0)
		return job.commitsLanded.join("; ");
	return "none matched";
}

/*
 * ── hand-off: the refill loop's takeover of a session it stopped (#2659) ──
 *
 * The loop stops a resumed-idle session that took no turn after its resume,
 * then runs this from the session's checkout. It snapshots the job, posts a
 * `**Hand-off:**` comment on each issue (lib/hand-off.js's buildHandOffComment:
 * the narration's newest lines, the commits landed, the session's own
 * uncommitted diff) and releases the session's arbiter claim on each, for
 * read-hand-off.js. It stops nothing and leaves the tree as it is.
 */

/** @param {ParsedArgs} args */
function cmdHandOff(args) {
	const tracker = require("./lib/tracker-ops.js");
	const store = require("./lib/arbiter-store");
	/** @type {ScriptIo} */
	const io = tracker.scriptIo("rescue-sessions hand-off");
	const dir = configDir(args);
	const short = typeof args.job === "string" ? args.job : "";
	const issues = (Array.isArray(args.issue) ? args.issue : []).map(Number);
	const [first] = issues;
	if (!short || first === undefined || !issues.every((n) => n > 0))
		die(HAND_OFF_USAGE);
	const repo = io.trackerOrFail();
	const found = readJobs(dir).jobs.find((j) => j.short === short);
	if (!found) io.fail(`no job ${short} on ${dir}. Nothing written.`, 2);
	const out = rescueDir(first, short);
	const { job } = snapshotJob(dir, out, found);
	fs.writeFileSync(
		path.join(out, "index.json"),
		`${JSON.stringify([job], null, 2)}\n`,
	);
	io.out(`snapshot: ${out}\n`);
	const comment = writeHandOffBody(io, job, out);
	let failed = false;
	for (const n of issues) {
		if (!postComment(io, { repo, n, out }, comment)) failed = true;
		const r = store.releaseIssue(n, { sessionId: job.sessionId });
		if (r.status === "released") io.out(`released: its claim on #${n}\n`);
		else if (r.status === "none")
			io.out(`released: it held no claim on #${n}\n`);
		else {
			failed = true;
			io.warn(`releasing its claim on #${n} failed (${r.status})`);
		}
	}
	process.exit(failed ? 1 : 0);
}

/**
 * The hand-off comment for a snapshotted job: its block where the session's
 * uncommitted diff fits in a comment, else a note naming the diff's file in
 * `out`. Exits 1 where git cannot read HEAD, the block's Base.
 * @param {ScriptIo} io
 * @param {Job} job  snapshotJob's
 * @param {string} out
 */
function writeHandOffBody(io, job, out) {
	const core = require("./lib/arbiter-core");
	const { gitOrNull } = require("./lib/git.js");
	const { buildHandOffComment } = require("./lib/hand-off.js");
	const { readStrandedFiles } = require("./lib/neighbour-dirt");
	const root = core.repoRoot();
	const base = gitOrNull(["rev-parse", "HEAD"], { cwd: root })?.trim();
	if (!base) io.fail(`git would not read HEAD in ${root}. Nothing posted.`, 1);
	const files = readStrandedFiles(job.sessionId, root);
	const diff = files.map((f) => readUncommittedDiff(io, root, f)).join("");
	const narrationFile = path.join(out, `${job.short}.narration.txt`);
	const head = [
		`**Refill loop: handed off.** Session ${job.sessionId}${job.name ? ` (${job.name})` : ""} was resumed by its host and took no turn, nor after the loop's resume (#2659). The loop stopped it and released its claim; its next tick launches a fresh session, which picks up from the block below.`,
		`Its files stay uncommitted where it left them. Snapshot: ${path.relative(root, out)}.`,
	].join(" ");
	const body = buildHandOffComment({
		head,
		narration: fs.existsSync(narrationFile)
			? fs.readFileSync(narrationFile, "utf8")
			: "",
		base,
		done: job.commitsLanded?.join("; ") || "none",
		left: `continue ${job.intent || "the ticket"} from the narration's newest lines above`,
		blockedOn: "nothing: its host restarted it and it never took another turn",
		files,
		diff,
	});
	if (body !== null) return body;
	const diffFile = path.join(out, "uncommitted.diff");
	fs.writeFileSync(diffFile, diff);
	return `${head}\n\nIts uncommitted diff runs past GitHub's comment limit, so no hand-off block is posted: the diff is at ${path.relative(root, diffFile)}, and the files are ${files.map((f) => `\`${f}\``).join(", ")}.`;
}

/**
 * `file`'s `git diff HEAD`, or for a file git does not track, its diff from
 * nothing, which `git apply` reads alike without the index being touched.
 * Exits 1 where git gives neither.
 * @param {ScriptIo} io
 * @param {string} root
 * @param {string} file
 */
function readUncommittedDiff(io, root, file) {
	const { spawnGitSync } = require("./lib/git.js");
	const opts = { cwd: root, encoding: /** @type {const} */ ("utf8") };
	const diff =
		spawnGitSync(["diff", "HEAD", "--", file], opts).stdout ||
		spawnGitSync(["diff", "--no-index", "--", "/dev/null", file], opts).stdout;
	if (!diff)
		io.fail(`git would not diff ${file} in ${root}. Nothing posted.`, 1);
	return diff;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const cmd = args._[0];
	if (cmd === "list") cmdList(args);
	else if (cmd === "snapshot") cmdSnapshot(args);
	else if (cmd === "stop") cmdStop(args);
	else if (cmd === "probe")
		cmdProbe(args).catch((e) => {
			// A throw is doubt, never a bad invocation.
			writeFd(2, `UNKNOWN  probe failed: ${e?.message ?? e}\n`);
			process.exit(PROBE_EXIT.UNKNOWN);
		});
	else if (cmd === "takeover")
		cmdTakeover(args).catch((e) => {
			writeFd(2, `rescue-sessions takeover: failed: ${e?.stack ?? e}\n`);
			process.exit(1);
		});
	else if (cmd === "hand-off") cmdHandOff(args);
}

if (require.main === module) main();
