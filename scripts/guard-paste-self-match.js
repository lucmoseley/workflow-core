#!/usr/bin/env node
/*
 * guard-paste-self-match.js — Stop hook. Refuses a turn that hands the founder
 * a `!` paste whose `pkill -f` pattern matches the paste itself (workflow-core#921), or
 * under `-v` misses it (workflow-core#1814) — or whose `pkill` without `-f` selects the
 * shell's name, `bash`, the same two ways (workflow-core#1842).
 *
 * WHY. A `!` paste runs as one shell whose command line is the whole pasted
 * text, and `-f` matches full command lines — so such a pattern matches the
 * founder's own shell, which is killed before the rest of the paste runs.
 * guard-self-match.sh catches the same
 * hazard in the agent's own Bash calls; a founder paste never passes
 * `PreToolUse`, so the outgoing message at Stop is the last place to see it.
 *
 * WHAT IS READ. Every fenced block or code span in the outgoing message whose
 * text opens with `!`. The unit is the whole block, never the line: lines
 * pasted together run in one shell (workflow-core#883, finding W6). A `!` line in plain
 * prose, and any span not opening with `!`, is not read.
 *
 * THE JUDGEMENT is scripts/lib/paste-self-match.sh's, which runs each block through
 * lib/guard-parse.sh's segment split and flag reader — the ones
 * guard-self-match.sh uses — and tests each `-f` pattern, as an extended regex,
 * against the block's text, and any other against the shell's name, inverted
 * under `-v`. The split mirrors
 * guard-self-match.sh's (mantahostels#103):
 * a matching `pkill -f` is refused; a matching `pgrep -f` is warned on the
 * founder's screen (`systemMessage`, which never reaches the model), since a
 * read costs a wrong answer, not a shell. A segment naming `$$` or `$PPID`
 * passes. A pattern that will not compile, or carries an expansion, passes and
 * is logged to the fail-open record.
 *
 * IMPLICIT:  scans every outgoing message for `!` code with a pgrep or pkill
 *            in it, and runs one bash per such block.
 * JUSTIFIED: fail-safe — the miss kills the founder's shell mid-paste and can
 *            orphan whatever the paste had started.
 * DEFEAT:    MAX_BLOCKS refusals a session on its own counter; past the cap the
 *            finding goes to the founder's screen instead. Silent on every
 *            failure path.
 */

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { logError } = require("./lib/arbiter-core");
const hookBlock = require("./lib/hook-block");
const { ruleParagraph } = require("./lib/rule-text");
const stopGuard = require("./lib/stop-guard");
const { requiredGroup } = require("./lib/regex-group");

/** The paragraph of `rule:founder-handover` the refusal prints. */
const PARAGRAPH_HEAD = "A PROCESS KILL IN A `!` PASTE";

/** Cheap pre-filter, so a message with no process search spawns nothing. */
const MENTIONS = /\bp(?:kill|grep)\b/;

const SCANNER = path.join(__dirname, "lib", "paste-self-match.sh");

/* One bash and one parse of a paste take well under a second; five leaves the
 * 15 s Stop ceiling room for two slow pastes and the block write. */
const SCAN_TIMEOUT_MS = 5000;

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;

/**
 * @typedef {{text: string, opening: string}} Paste
 * @typedef {{verdict: "kill" | "read", segment: string, pattern: string,
 *   relation: "matches" | "misses", against: "paste" | "name",
 *   opening: string}} Finding
 */

/**
 * @param {string} body the code's text
 * @returns {Paste | null} the paste with its `!` removed, or null where the
 *   code is not one
 */
function asPaste(body) {
	const lead = body.match(/^\s*!/);
	if (!lead) return null;
	const text = body.slice(lead[0].length);
	return { text, opening: `!${text.trim().split("\n")[0]}` };
}

/**
 * Every `!` paste in a message: fenced blocks first, then code spans in what
 * the fences leave. Spans follow CommonMark's rule — a run of N backticks
 * closes on the next run of exactly N.
 * @param {string} message
 * @returns {Paste[]}
 */
function parsePastes(message) {
	const { pastes, prose } = fencedPastes(message);
	return [...pastes, ...spanPastes(prose)];
}

/**
 * The `!` pastes in a message's fenced blocks, and the prose the fences leave —
 * each block standing as one empty line.
 * @param {string} message
 * @returns {{pastes: Paste[], prose: string}}
 */
function fencedPastes(message) {
	/** @type {Paste[]} */
	const out = [];
	const rest = [];
	/** @type {{fence: string, body: string[]} | null} the open fenced block */
	let block = null;
	/** @param {{fence: string, body: string[]}} b */
	const shut = (b) => {
		const paste = asPaste(b.body.join("\n"));
		if (paste) out.push(paste);
		rest.push("");
	};
	for (const line of message.split("\n")) {
		if (block) {
			const close = line.match(FENCE_CLOSE);
			const fenceRun = close && requiredGroup(close, 1, FENCE_CLOSE);
			if (
				fenceRun &&
				fenceRun[0] === block.fence[0] &&
				fenceRun.length >= block.fence.length
			) {
				shut(block);
				block = null;
			} else block.body.push(line);
			continue;
		}
		const open = line.match(FENCE_OPEN);
		if (open) block = { fence: requiredGroup(open, 1, FENCE_OPEN), body: [] };
		else rest.push(line);
	}
	if (block) shut(block);
	return { pastes: out, prose: rest.join("\n") };
}

/**
 * The `!` pastes in the code spans of prose, by CommonMark's rule.
 * @param {string} prose
 * @returns {Paste[]}
 */
function spanPastes(prose) {
	/** @type {Paste[]} */
	const out = [];
	const run = /`+/g;
	for (let m = run.exec(prose); m; m = run.exec(prose)) {
		const ticks = m[0];
		const start = m.index + ticks.length;
		const closer = new RegExp(`(?<!\`)${ticks}(?!\`)`, "g");
		closer.lastIndex = start;
		const end = closer.exec(prose);
		if (!end) continue;
		let body = prose.slice(start, end.index).replace(/\n/g, " ");
		if (/^ .*[^ ].* $/s.test(body)) body = body.slice(1, -1);
		const paste = asPaste(body);
		if (paste) out.push(paste);
		run.lastIndex = end.index + ticks.length;
	}
	return out;
}

/**
 * The scanner's findings for one paste. Empty on any failure: the scanner logs
 * the fail-opens it reaches, and this logs the run that never finished.
 * @param {Paste} paste
 * @returns {Finding[]}
 */
function scan(paste) {
	const run = spawnSync("bash", [SCANNER], {
		input: JSON.stringify({ tool_input: { command: paste.text } }),
		encoding: "utf8",
		timeout: SCAN_TIMEOUT_MS,
	});
	if (run.status !== 0 || typeof run.stdout !== "string") {
		logError(
			"guard-paste-self-match.js",
			run.error ?? new Error(`scanner exited ${run.status ?? run.signal}`),
		);
		return [];
	}
	return run.stdout.split("\n").flatMap((line) => {
		if (line === "") return [];
		const [verdict, segment, pattern, relation, against] = line.split("\t");
		if (
			(verdict !== "kill" && verdict !== "read") ||
			(relation !== "matches" && relation !== "misses") ||
			(against !== "paste" && against !== "name") ||
			segment === undefined ||
			!pattern
		) {
			logError(
				"guard-paste-self-match.js",
				new Error(`unreadable scanner line: ${line}`),
			);
			return [];
		}
		return [
			{ verdict, segment, pattern, relation, against, opening: paste.opening },
		];
	});
}

/** @param {Finding} f */
const formatFinding = (f) =>
	`  ${f.segment}\n    pattern /${f.pattern}/ ${f.relation === "misses" ? "misses, under -v," : "matches"} ${f.against === "name" ? "the shell's name, bash, in the" : "the"} paste opening: ${f.opening}`;

/**
 * @param {Finding[]} kills
 * @param {Finding[]} reads
 * @returns {string}
 */
function refusal(kills, reads) {
	const out = [
		"THIS MESSAGE HANDS THE FOUNDER A `!` PASTE THAT KILLS THE FOUNDER'S OWN SHELL: a `!` paste runs as one shell whose command line is the whole paste, so a `pkill -f` pattern that matches the paste matches that shell (workflow-core#921), and so does a `pkill -v -f` pattern that misses it (workflow-core#1814). Without `-f` the pattern is tested against that shell's name, `bash`, the same way (workflow-core#1842).",
		"",
		...kills.map(formatFinding),
		"",
		ruleParagraph("founder-handover", PARAGRAPH_HEAD),
	];
	if (reads.length > 0)
		out.push(
			"",
			"These `pgrep` reads in the same message will also list the founder's shell:",
			"",
			...reads.map(formatFinding),
		);
	out.push("", rewriteAdvice(kills));
	return out.join("\n");
}

/**
 * The way out the refusal ends on: the bracket trick and a name the shell
 * lacks each select the shell under `-v`, so there only a pid will do.
 * @param {Finding[]} kills
 * @returns {string}
 */
function rewriteAdvice(kills) {
	const head = "Rewrite the paste before ending the turn: kill by pid";
	if (kills.some((f) => f.relation === "misses"))
		return `${head} — a \`pkill -v\` kills every process its pattern misses, the founder's shell among them.`;
	if (kills.some((f) => f.against === "name"))
		return `${head}, or give \`pkill\` a pattern the name \`bash\` does not match.`;
	return `${head}, or keep the target string out of every other part of the paste.`;
}

/**
 * @param {Finding[]} findings
 * @returns {string}
 */
function screenNote(findings) {
	return [
		"A `!` paste in this message searches processes by a pattern that selects your own shell — a `pkill` kills that shell before the rest runs, a `pgrep` lists it (workflow-core#921):",
		"",
		...findings.map(formatFinding),
	].join("\n");
}

/**
 * @param {{sessionId: string, message: string}} ctx
 */
function review({ sessionId, message }) {
	if (!MENTIONS.test(message)) return;
	const findings = parsePastes(message)
		.filter((p) => MENTIONS.test(p.text))
		.flatMap(scan);
	if (findings.length === 0) return;
	const kills = findings.filter((f) => f.verdict === "kill");
	const reads = findings.filter((f) => f.verdict === "read");
	const blocked =
		kills.length > 0 &&
		hookBlock.blockStop({
			prefix: ".paste-self-match-nagged-",
			sessionId,
			reason: refusal(kills, reads),
		});
	if (!blocked)
		process.stdout.write(
			JSON.stringify({ systemMessage: screenNote(findings) }),
		);
}

if (require.main === module) stopGuard.onMessage({ review });
