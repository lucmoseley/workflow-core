const crypto = require("node:crypto");
const path = require("node:path");
const { expandHome } = require("./home-path.js");
const { requiredGroup } = require("./regex-group.js");
const { trimEndRun, trimRun } = require("./trim-run.js");

const MARKER =
	/^[ \t]*(?:[-*+][ \t]+)?(?:\*\*)?(?:artefacts?|artifacts?)(?:\*\*)?[ \t]*:(?:\*\*)?[ \t]*((?:(?![ \t]).*)?)$/i;

const PLACEHOLDERS = new Set([
	"path",
	"artefact",
	"artifact",
	"filename",
	"file",
	"tbd",
	"todo",
	"none",
	"n/a",
	"na",
	"null",
	"nothing",
]);

/**
 * @param {string} token
 * @returns {string}
 */
function clean(token) {
	return trimEndRun(
		trimEndRun(token.replace(/^[`'"([]+/, ""), "`'\")]"),
		".,;:",
	);
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function pathLike(value) {
	return value.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(value);
}

/**
 * @param {string} rest
 * @returns {string}
 */
function firstToken(rest) {
	const value = rest.trim();
	const template = /^<[^<>]*>/.exec(value);
	if (template) return template[0];
	return value.split(/[\s,]/)[0] ?? "";
}

/**
 * @param {string} token
 * @returns {boolean}
 */
function isUnfilled(token) {
	const value = clean(token);
	return (
		!value || /^<[^<>]*>$/.test(value) || PLACEHOLDERS.has(value.toLowerCase())
	);
}

/**
 * @param {unknown} prompt
 * @returns {string|null}
 */
function artefactPath(prompt) {
	if (typeof prompt !== "string") return null;
	for (const line of prompt.split(/\r?\n/)) {
		const m = MARKER.exec(line);
		if (!m) continue;
		const token = firstToken(requiredGroup(m, 1, MARKER));
		if (isUnfilled(token)) continue;
		const value = clean(token);
		if (!pathLike(value)) continue;
		return value;
	}
	return null;
}

// #565, #5496
const EXEMPT_AGENT_TYPES = new Set([
	"statusline-setup",
	"web-fetch",
	"Explore",
	"Plan",
]);

const AGENTS_DIR = path.join(".claude", "tmp", "agents");

const ARTEFACT_INSTRUCTIONS = [
	"Append your findings to that file as each one lands; never hold them back for the final report.",
	"Save a long fetched or local source to disk and search it, rather than reading it whole into your context.",
].join("\n");

/**
 * @param {string} root
 * @param {unknown} description
 * @param {string} [id]
 * @returns {string}
 */
function artefactFile(
	root,
	description,
	id = crypto.randomBytes(4).toString("hex"),
) {
	const slug =
		trimRun(
			(typeof description === "string" ? description : "")
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.slice(0, 48),
			"-",
		) || "agent";
	return path.join(root, AGENTS_DIR, `${slug}-${id}.md`);
}

/**
 * @param {string} prompt
 * @param {string} file
 * @returns {string|null}
 */
function withArtefact(prompt, file) {
	if (artefactPath(prompt) !== null) return null;
	const lines = prompt.split("\n");
	for (const [i, raw] of lines.entries()) {
		const line = raw.replace(/\r$/, "");
		const m = MARKER.exec(line);
		if (!m) continue;
		const value = requiredGroup(m, 1, MARKER);
		const token = firstToken(value);
		if (!token || !isUnfilled(token)) continue;
		const head = line.slice(0, line.length - value.length);
		lines.splice(
			i,
			1,
			`${head}${value.replace(token, () => file)}`,
			ARTEFACT_INSTRUCTIONS,
		);
		return lines.join("\n");
	}
	return `${prompt.trimEnd()}\n\nArtefact: ${file}\n${ARTEFACT_INSTRUCTIONS}\n`;
}

/**
 * @param {Record<string, unknown>} call
 * @returns {call is Record<string, unknown> & {prompt: string}}
 */
function isWatchable(call) {
	if (typeof call.prompt !== "string" || !call.prompt.trim()) return false;
	return !EXEMPT_AGENT_TYPES.has(agentTypeOf(call));
}

/**
 * @param {Record<string, unknown>} call
 * @returns {string}
 */
function agentTypeOf(call) {
	return typeof call.subagent_type === "string"
		? call.subagent_type.trim()
		: "";
}

const JOB_WAIT =
	"While work remains that does not wait on this agent, run it with `run_in_background` and keep working; only once nothing else is left, run it in the foreground, as `rule:job-holds-turn` says.";

const VERDICTS =
	"A `DONE` means the agent has stopped: read its report, or take over from its artefact where it sent none. A `STALLED` or `MISSING` means abandon the agent.";

/**
 * @param {string} file
 * @param {(file: string, job?: boolean) => string} watch
 * @param {boolean} job
 * @returns {string}
 */
function buildWatchSentence(file, watch, job) {
	if (job)
		return `This session is a background job: hold the turn on \`${watch(file, true)}\`, its \`<output_file>\` the one the launch result names. ${JOB_WAIT} ${VERDICTS}`;
	return `Watch it with one backgrounded \`${watch(file)}\`, its \`<output_file>\` the one the launch result names, then end the turn. When the agent's completion notification arrives, \`TaskStop\` the watcher first. ${VERDICTS}`;
}

/**
 * @param {Record<string, unknown>} call
 * @param {string} file
 * @param {(file: string, job?: boolean) => string} watch
 * @param {boolean} [job]
 * @returns {null | {input: Record<string, unknown>, note: string}}
 */
function injectArtefact(call, file, watch, job = false) {
	if (!isWatchable(call)) return null;
	const prompt = withArtefact(call.prompt, file);
	if (prompt === null) return null;
	return {
		input: { ...call, prompt },
		note: `This dispatch's prompt named no usable artefact, so the dispatch hook gave it one: ${file}. ${buildWatchSentence(file, watch, job)}`,
	};
}

/**
 * @param {Record<string, unknown>} call
 * @param {(file: string, job?: boolean) => string} watch
 * @param {string} [home]
 * @param {boolean} [job]
 * @returns {string|null}
 */
function buildWatchNote(call, watch, home, job = false) {
	if (!isWatchable(call)) return null;
	const named = artefactPath(call.prompt);
	if (named === null) return null;
	const file = expandHome(named, home) ?? named;
	return `This dispatch names its artefact: ${file}. ${buildWatchSentence(file, watch, job)}`;
}

module.exports = {
	agentTypeOf,
	artefactFile,
	injectArtefact,
	buildWatchNote,
	JOB_WAIT,
};
