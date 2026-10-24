/*
 * dispatch-rewrite.js — every change this repo makes to an `Agent` call, and
 * every note it hands the session there, composed into one hook envelope for
 * `scripts/guard-dispatch-rewrite.sh` (workflow-core#515, workflow-core#2013).
 *
 * ONE ENVELOPE, NOT ONE PER CHANGE. Two hooks each returning `updatedInput` on
 * one call race, the last to finish winning and the other's change lost
 * (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/hook-ordering-plugin-vs-native.md,
 * anthropics/claude-code#83353). So each change is a pure transform — call in,
 * call and a note out, or null — and this applies them in turn to one input.
 *
 * Built here rather than through lib/guard-parse.sh's helpers because none of
 * them carries `updatedInput`. It rides on an `allow` so the rewrite runs
 * unprompted; the limits of that `allow` are in the hook's header.
 */

const fs = require("node:fs");
const path = require("node:path");
const {
	artefactFile,
	injectArtefact,
	watchNote,
} = require("./dispatch-artefact.js");
const { tierDeparture, untrackedSearch } = require("./dispatch-rules.js");
const { writeFd } = require("./write-fd.js");

/**
 * A path quoted for a shell only where it needs it.
 * @param {string} p
 * @returns {string}
 */
function shellQuote(p) {
	return /^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

// Resolved from this file, so an adopter is handed the plugin's copy (workflow-core#541).
const WATCHER = path.resolve(__dirname, "..", "watch-artefact.js");

/**
 * The watch docs/agents/guard-registry.md §Subagent dispatch prescribes, for one artefact. 120 s
 * is a judgement, never measured against a band's timings.
 * @param {string} file
 * @returns {string}
 */
function watchCommand(file) {
	return `node ${shellQuote(WATCHER)} ${shellQuote(file)} 120`;
}

/** Told where no artefact is watched: an exempt or remote agent. */
const END_TURN =
	"While this agent runs, end the turn: its completion notification wakes this session, so a poll learns nothing.";

/**
 * The envelope for one `Agent` call, and the ids of the rules it tripped
 * (workflow-core#2013), whose fragments the hook splices in once a session.
 *
 * @param {unknown} input the tool_input object
 * @param {{file: string, burn: boolean}} opts the artefact path to supply
 *   where one is needed, and whether burn mode is on
 * @returns {null | {artefact: string | null, rules: string[], envelope: {hookSpecificOutput: Record<string, unknown>}}}
 */
function rewrite(input, { file, burn }) {
	if (input === null || typeof input !== "object") return null;
	const asked = /** @type {Record<string, unknown>} */ (input);
	let call = asked;
	/** @type {string[]} */
	const notes = [];
	/** @type {string[]} */
	const rules = [];
	let artefact = null;

	const artefacted = injectArtefact(call, file, watchCommand);
	if (artefacted) {
		call = artefacted.input;
		notes.push(artefacted.note);
		artefact = file;
	} else {
		notes.push(watchNote(call, watchCommand) ?? END_TURN);
	}
	// Loaded only while burn mode is on, so a broken table costs the remap and
	// never the artefact line.
	const remapped = burn ? require("./burn-mode.js").remapModel(call) : null;
	if (remapped) {
		call = remapped.input;
		notes.push(remapped.note);
	}

	const tier = tierDeparture(asked, burn);
	if (tier) {
		notes.push(tier);
		rules.push("dispatch-tier");
	}
	const search = untrackedSearch(asked);
	if (search) {
		notes.push(search);
		rules.push("dispatch-search-tracker");
	}

	/** @type {Record<string, unknown>} */
	const out = { hookEventName: "PreToolUse" };
	if (call !== asked) {
		out.permissionDecision = "allow";
		out.updatedInput = call;
	}
	out.additionalContext = notes.join("\n\n");
	return { artefact, rules, envelope: { hookSpecificOutput: out } };
}

module.exports = { rewrite, shellQuote };

/*
 * CLI mode, for the hook: tool_input JSON on stdin.
 *
 *   node dispatch-rewrite.js <project root> <on|off>
 *
 * stdout is one JSON line, `{"envelope": …, "rules": [<id>…]}`.
 *
 *   0  printed it
 *   4  printed it, but could not make the artefact's directory
 *   3  nothing to say
 *   any other  could not decide — the hook leaves the dispatch as written
 *
 * The artefact's directory is made here, so a subagent appending through a
 * shell redirect finds it. A failure to make it still prints the line, since
 * the Write tool makes its own parents: exit 4, which the hook logs.
 */
if (require.main === module) {
	const [root, burn] = process.argv.slice(2);
	try {
		if (!root || !path.isAbsolute(root)) process.exit(2);
		const input = JSON.parse(fs.readFileSync(0, "utf8"));
		const description =
			input && typeof input === "object" ? input.description : undefined;
		const out = rewrite(input, {
			file: artefactFile(root, description),
			burn: burn === "on",
		});
		if (!out) process.exit(3);
		let status = 0;
		if (out.artefact)
			try {
				fs.mkdirSync(path.dirname(out.artefact), { recursive: true });
			} catch {
				status = 4;
			}
		writeFd(
			1,
			`${JSON.stringify({ envelope: out.envelope, rules: out.rules })}\n`,
		);
		process.exit(status);
	} catch {
		process.exit(2);
	}
}
