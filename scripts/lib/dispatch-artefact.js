/*
 * dispatch-artefact.js — does an `Agent` dispatch prompt carry the structured
 * marker `docs/agents/guard-registry.md` §Subagent dispatch requires, and the
 * line to give it where it does not?
 *
 * The artefact half of `scripts/lib/dispatch-rewrite.js`, which supplies the
 * line rather than refusing the dispatch (#482).
 *
 * WHY A LITERAL AND NOT A DETECTOR. mantahostels#689 (can a PreToolUse hook enforce the
 * artefact-path clause on Agent dispatches?) measured both cheap free-text
 * detectors and rejected them, because prompts overwhelmingly cite paths to
 * READ; its figures are there. mantahostels#103's house rule is act on a
 * structured fact, only warn where the hook infers — so the only form a hook
 * can act on is a literal the prompt either has or has not. That is mantahostels#689's option (C), reopened and approved at mantahostels#766.
 *
 * WHAT IS DELIBERATELY NOT CHECKED. That the path is sane, writable, inside
 * the sanctioned `.claude/tmp/` scratch directory (mantahostels#2089), or ever actually
 * written. The marker is a promise, and nothing here verifies it is kept.
 */

const crypto = require("node:crypto");
const path = require("node:path");
const { requiredGroup } = require("./regex-group.js");

/*
 * `- `/`* ` bullet, optional `**` bold on either side of the colon, either
 * spelling, any case. The anchor is load-bearing: without `^` the marker fires
 * on prose merely containing the word.
 */
const MARKER =
	/^[ \t]*(?:[-*+][ \t]+)?(?:\*\*)?(?:artefacts?|artifacts?)(?:\*\*)?[ \t]*:(?:\*\*)?[ \t]*(.*)$/i;

/*
 * Values that satisfy the letter and not the rule — an unfilled template, or a
 * declaration that there is no artefact. Compared lowercased; any `<…>`
 * template is unfilled without an entry here (isUnfilled). `n/a` is here rather than left
 * to the path-likeness test below, which its slash would otherwise pass.
 */
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
 * Strip the wrappers a path picks up in prose, plus trailing punctuation.
 *
 * @param {string} token
 * @returns {string}
 */
function clean(token) {
	return token
		.replace(/^[`'"([]+/, "")
		.replace(/[`'")\]]+$/, "")
		.replace(/[.,;:]+$/, "");
}

/**
 * Path-like enough to be a path and not a description: a separator, or a
 * filename carrying an extension.
 *
 * @param {string} value
 * @returns {boolean}
 */
function pathLike(value) {
	return value.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(value);
}

/**
 * The first token after a marker, as written. It is the value, not the rest of
 * the line: trailing prose ("…/a.md, appended as you go") is the common shape,
 * and a path containing a space is not. An angle-bracket template is one token
 * to its closing bracket, so `<path to file>` is read whole.
 *
 * @param {string} rest the text after the marker's colon
 * @returns {string}
 */
function firstToken(rest) {
	const value = rest.trim();
	const template = /^<[^<>]*>/.exec(value);
	if (template) return template[0];
	return value.split(/[\s,]/)[0] ?? "";
}

/**
 * @param {string} token a marker's first token, as written
 * @returns {boolean} true where it is empty, an angle-bracket template, or a
 *   known placeholder
 */
function isUnfilled(token) {
	const value = clean(token);
	return (
		!value || /^<[^<>]*>$/.test(value) || PLACEHOLDERS.has(value.toLowerCase())
	);
}

/**
 * The artefact path a prompt names, or null where it names none.
 *
 * @param {unknown} prompt the dispatch prompt, as free text
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

/**
 * Agent types that will not create a file, so an artefact line would be a
 * promise they do not keep and the watch would read MISSING on a healthy agent.
 * statusline-setup has no tool that can; Explore and Plan have Bash but are
 * read-only by their own instructions (#565), so a stall in one gives no
 * artefact signal. A named list, not an inference from their tools: an agent
 * definition is not something this hook reads, so a renamed type loses its
 * exemption silently.
 */
const EXEMPT_AGENT_TYPES = new Set(["statusline-setup", "Explore", "Plan"]);

/** Where every supplied artefact lives, under the sanctioned scratch directory. */
const AGENTS_DIR = path.join(".claude", "tmp", "agents");

/**
 * Told to the agent beneath its supplied line. Residual: a prompt that already
 * names a usable artefact is left as written, so it never gets the second,
 * reading line.
 */
const ARTEFACT_INSTRUCTIONS = [
	"Append your findings to that file as each one lands; never hold them back for the final report.",
	"Save a long fetched or local source to disk and search it, rather than reading it whole into your context.",
].join("\n");

/**
 * An absolute artefact path for one dispatch:
 * `<root>/.claude/tmp/agents/<slug>-<short-id>.md`. The slug is the call's
 * `description`, so a listing of the directory says whose file is whose; the
 * id is 32 random bits, so parallel sessions naming the same task never
 * collide. The slug stops at 48 characters, a choice rather than a measure, to
 * keep a listing's names on one line.
 *
 * @param {string} root the session's project root, absolute
 * @param {unknown} description the call's `description`
 * @param {string} [id] fixed only by tests
 * @returns {string}
 */
function artefactFile(
	root,
	description,
	id = crypto.randomBytes(4).toString("hex"),
) {
	const slug =
		(typeof description === "string" ? description : "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.slice(0, 48)
			.replace(/^-+|-+$/g, "") || "agent";
	return path.join(root, AGENTS_DIR, `${slug}-${id}.md`);
}

/**
 * The prompt given an artefact line, or null where it needs none.
 *
 * A placeholder — `Artefact:
 * TBD`, `Artefact: <path to file>`, `Artefact: none` — is replaced in place,
 * bullet, bold and trailing prose kept, so the prompt does not carry two.
 * Otherwise the lines are appended: a marker with no value, or prose for one,
 * may be a heading over something else, and is left alone.
 *
 * @param {string} prompt
 * @param {string} file the path to supply
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
	return `${prompt.replace(/\s+$/, "")}\n\nArtefact: ${file}\n${ARTEFACT_INSTRUCTIONS}\n`;
}

/**
 * Whether a call is one an artefact line is given to and watched on: not an
 * exempt agent type, not a remote agent (whose cloud environment cannot write
 * a local path, so a watch on it would abandon a healthy agent), and carrying
 * a prompt. A fork is not exempt: it writes files like any other agent.
 *
 * @param {Record<string, unknown>} call the tool_input object
 * @returns {call is Record<string, unknown> & {prompt: string}}
 */
function isWatchable(call) {
	if (typeof call.prompt !== "string" || !call.prompt.trim()) return false;
	return (
		!EXEMPT_AGENT_TYPES.has(agentTypeOf(call)) && call.isolation !== "remote"
	);
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

/**
 * @param {string} file
 * @param {(file: string) => string} watch the watch command for a path
 * @returns {string}
 */
function buildWatchSentence(file, watch) {
	return `Watch it with one backgrounded \`${watch(file)}\`, then end the turn. When the agent's completion notification arrives, \`TaskStop\` the watcher first. A \`STALLED\` or \`MISSING\` before it means abandon the agent.`;
}

/**
 * The artefact transform over one `Agent` call's input: the call with its
 * prompt given a line, and what the session is told, or null where the call
 * needs nothing — a usable marker already, or a call isWatchable() refuses.
 *
 * @param {Record<string, unknown>} call the tool_input object
 * @param {string} file the path to supply
 * @param {(file: string) => string} watch the watch command for a path
 * @returns {null | {input: Record<string, unknown>, note: string}}
 */
function injectArtefact(call, file, watch) {
	if (!isWatchable(call)) return null;
	const prompt = withArtefact(call.prompt, file);
	if (prompt === null) return null;
	return {
		input: { ...call, prompt },
		note: `This dispatch's prompt named no usable artefact, so the dispatch hook gave it one: ${file}. ${buildWatchSentence(file, watch)}`,
	};
}

/**
 * What the session is told about a call whose prompt names its own usable
 * artefact, or null (#2013).
 *
 * @param {Record<string, unknown>} call the tool_input object
 * @param {(file: string) => string} watch the watch command for a path
 * @returns {string|null}
 */
function buildWatchNote(call, watch) {
	if (!isWatchable(call)) return null;
	const file = artefactPath(call.prompt);
	if (file === null) return null;
	return `This dispatch names its artefact: ${file}. ${buildWatchSentence(file, watch)}`;
}

module.exports = {
	agentTypeOf,
	artefactFile,
	injectArtefact,
	buildWatchNote,
};
