/*
 * injector-margin.js — each tracker command's payload length, composed from
 * the copy of lib/tracker-inject-text.js at a root through its own composers,
 * for scripts/check-injector-margin.js (mantahostels#1915).
 *
 * Lengths are in UTF-16 units: the harness slices with String.prototype.length.
 *
 * The copy is evaluated, never required (lib/load-text-module.js), so a staged
 * blob is measured without running anything else of the index. The host's own
 * values are read off the same root, as the hook reads them off its host.
 *
 * Every input sits at the value that makes its payload longest:
 *   - each takes-reading command is handed an issue whose `takes:` label is
 *     the longest command's, an upper bound on the #1164 line; the command
 *     named itself is measured without the line;
 *   - the priced-options part is the whole shape, as a host without Core voice
 *     gets it, never the pointer;
 *   - a probe session id, which mints mantahostels#2220's Artefact-path suffix:
 *     a real payload always carries one.
 * /code-review's rule fragments are read at the root, the module's fallbacks
 * standing in for any absent, and the review tier the hook adds at run time is
 * reserved at RULE_CAP plus the blank line joining it (#1697). Its areas
 * prelude is uncapped, so a host declaring many areas can still cross the
 * threshold; the hook then puts the tier first, inside the preview.
 */

const path = require("node:path");
const { buildArbiterCommand } = require("./build-arbiter-command.js");
const { brokenError, skipError } = require("./outcome-error.js");
const { errMessage } = require("./check.js");
const { readText } = require("./file-read.js");
const { limitIn } = require("./hook-limits.js");
const { TRACKER_TEXT, loadTextModule } = require("./load-text-module.js");
const {
	readOutputStylePath,
	CONFIG_PATH,
} = require("./workflow-core-config.js");
const rs = require("./review-standards.js");
const { OWN_AGENT_REL, reviewAgentType } = require("./review-agent-type.js");
const { reviewSuffix } = require("./review-suffix.js");
const { fragmentLookup, RULES_DIR } = require("./rule-text.js");
const { PROBE_SESSION_ID } = require("./rendered-injection.js");
const { CAP_SOURCE } = require("./rule-emission.js");

/* Advisory only: under this much headroom the NEXT rule of any size may not
 * fit — the rule-size range it is derived from is on mantahostels#1915. */
const TIGHT_HEADROOM_CHARS = 1000;

const PROBE_ISSUE = "1";

/* The fragments /code-review's rules read. */
const REVIEW_RULES = [
	"review-dispatch-shape",
	"review-deviations-read",
	"review-finding-destination",
];

/* Every path a measurement reads at its root, so --index materialises each. */
const MARGIN_INPUTS = [
	TRACKER_TEXT,
	CAP_SOURCE,
	...REVIEW_RULES.map((id) => path.posix.join(RULES_DIR, `${id}.txt`)),
	CONFIG_PATH,
	rs.BASE_REL,
	rs.LOCAL_REL,
	rs.GLOSSARY_REL,
	OWN_AGENT_REL,
];

/**
 * Each command and its payload's length, and the fragments whose fallback
 * stood in.
 * @param {typeof import("./tracker-inject-text.js")} t the evaluated text module
 * @param {number} ruleCap
 * @param {string} root the host whose own values are read
 * @returns {{ sizes: [string, number][], fallbacks: string[] }}
 */
function measure(t, ruleCap, root) {
	/** @type {string[]} */
	const commands = t.COMMANDS;
	const longest = commands.reduce((a, b) => (b.length > a.length ? b : a), "");
	const pricedOptions = t.pricedOptionsWhole(
		readOutputStylePath({
			root,
			say: () => {
				/* a config fault is the config checker's to report */
			},
		}),
	);
	const read = fragmentLookup(root);
	/** @type {Set<string>} */
	const fallbacks = new Set();
	/** @type {[string, number][]} */
	const sizes = commands.map((matched) => {
		if (matched !== "code-review") {
			const takesIssue = t.TAKES_READ.includes(matched) ? PROBE_ISSUE : "";
			const otherTakes = takesIssue && longest !== matched ? longest : "";
			const payload = t.trackerContext({
				matched,
				takesIssue,
				otherTakes,
				pricedOptions,
				claimIssue: buildArbiterCommand`claim-issue <n>`,
			});
			return [matched, payload.length];
		}
		const glossary = rs.standardsGlossary(root);
		const rules = t.codeReviewRules(
			{
				standardsState: rs.standardsState(root, root),
				standardsBase: rs.standardsShown(rs.standardsBase(root), root),
				glossary: glossary === null ? null : rs.standardsShown(glossary, root),
				reviewType: reviewAgentType(root),
				sidSuffix: reviewSuffix(PROBE_SESSION_ID),
				fragment: (id) => {
					const body = read(id);
					if (body === "") fallbacks.add(id);
					return body;
				},
			},
			pricedOptions,
		);
		return [matched, rules.length + 2 + ruleCap];
	});
	return { sizes, fallbacks: [...fallbacks] };
}

/**
 * The threshold, each command's payload length and the fragments whose
 * fallback stood in, read at `root`. An absent text module is a SKIP: a commit
 * deleting or renaming it has nothing to measure. Anything else unreadable is
 * BROKEN.
 * @param {string} root
 * @returns {{ limit: number } & ReturnType<typeof measure>}
 */
function readMargins(root) {
	/** @param {string} rel */
	const read = (rel) => {
		const r = readText(path.join(root, rel));
		if (r.state === "read") return r.data;
		if (r.state === "absent" && rel === TRACKER_TEXT)
			throw skipError(`no ${TRACKER_TEXT} to measure — gate SKIPPED.`);
		throw brokenError(
			`cannot read ${rel}: ${r.state === "absent" ? "no such file" : r.message}`,
		);
	};
	const source = read(TRACKER_TEXT);
	const limits = read(CAP_SOURCE);
	/** @param {string} name */
	const limit = (name) => {
		const n = limitIn(limits, name);
		if (n === null)
			throw brokenError(`no const ${name} = <n>; line in ${CAP_SOURCE}`);
		return n;
	};
	const persist = limit("HOOK_PERSIST_CHARS");
	const ruleCap = limit("RULE_CAP");
	let measured;
	try {
		const t = /** @type {typeof import("./tracker-inject-text.js")} */ (
			loadTextModule(source, path.join(root, TRACKER_TEXT))
		);
		measured = measure(t, ruleCap, root);
	} catch (e) {
		throw brokenError(
			`${TRACKER_TEXT} could not be measured: ${errMessage(e)}`,
		);
	}
	if (measured.sizes.length === 0)
		throw brokenError(`${TRACKER_TEXT} names no command`);
	return { limit: persist, ...measured };
}

module.exports = {
	TIGHT_HEADROOM_CHARS,
	MARGIN_INPUTS,
	readMargins,
};
