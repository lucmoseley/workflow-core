#!/usr/bin/env node

const hookBlock = require("./lib/hook-block");
const { readRuleParagraph } = require("./lib/rule-text");
const stopGuard = require("./lib/stop-guard");
const { requiredGroup } = require("./lib/regex-group");

const PARAGRAPH_HEAD = "A PROCESS KILL IN A `!` PASTE";

const MENTIONS = /\bp(?:kill|grep)\b/;

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;

/**
 * @typedef {{text: string, opening: string}} Paste
 * @typedef {{verdict: "kill" | "read", segment: string, pattern: string,
 *   relation: "matches" | "misses", against: "paste" | "name",
 *   opening: string}} Finding
 */

/**
 * @param {string} body
 * @returns {Paste | null}
 */
function asPaste(body) {
	const lead = body.match(/^\s*!/);
	if (!lead) return null;
	const text = body.slice(lead[0].length);
	return { text, opening: `!${text.trim().split("\n")[0]}` };
}

/**
 * @param {string} message
 * @returns {Paste[]}
 */
function parsePastes(message) {
	const { pastes, prose } = fencedPastes(message);
	return [...pastes, ...spanPastes(prose)];
}

/**
 * @param {string} message
 * @returns {{pastes: Paste[], prose: string}}
 */
function fencedPastes(message) {
	/** @type {Paste[]} */
	const out = [];
	const rest = [];
	/** @type {{fence: string, body: string[]} | null} */
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
		if (/^ +[^ ].* $/s.test(body)) body = body.slice(1, -1);
		const paste = asPaste(body);
		if (paste) out.push(paste);
		run.lastIndex = end.index + ticks.length;
	}
	return out;
}

/**
 * @param {Paste} paste
 * @returns {Finding[]}
 */
function scan(paste) {
	// workflow-core#2790
	const { scanPaste } = require("./lib/paste-self-match");
	const { logger } = require("./lib/entry-input.js");
	const log = logger("guard-paste-self-match.js");
	try {
		return scanPaste(paste.text, log).map((f) => ({
			...f,
			opening: paste.opening,
		}));
	} catch (error) {
		log(`paste unscanned: ${error instanceof Error ? error.message : error}`);
		return [];
	}
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
		readRuleParagraph("founder-handover", PARAGRAPH_HEAD),
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
function buildScreenNote(findings) {
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
			JSON.stringify({ systemMessage: buildScreenNote(findings) }),
		);
}

if (require.main === module) stopGuard.onMessage({ review });
