#!/usr/bin/env node
/*
 * injector-margin.js — each tracker command's payload length, composed from a
 * given copy of lib/tracker-inject-text.js through its own composers, for
 * scripts/check-injector-margin.sh (mantahostels#1915).
 *
 * Usage:
 *   node scripts/lib/injector-margin.js <text-module> <rules-dir> <rule-cap>
 *
 * Prints one `<command> <length>` line per command, in COMMANDS order, the
 * length in UTF-16 units: the harness slices with String.prototype.length.
 * Exits 2 with the reason on stderr where the copy will not evaluate or
 * compose.
 *
 * The copy is evaluated, never required (lib/load-text-module.js), so the
 * staged blob is measured without running anything else of the index. The
 * host's own values — the output style path, the standards files, the
 * glossary, the reviewer type — are read off the working tree at the current
 * directory, as the hook reads them off its host.
 *
 * Every input sits at the value that makes its payload longest:
 *   - each takes-reading command is handed an issue whose `takes:` label is
 *     the longest command's, an upper bound on the #1164 line; the command
 *     named itself is measured without the line;
 *   - the priced-options part is the whole shape, as a host without Core voice
 *     gets it, never the pointer;
 *   - a probe session id, which mints mantahostels#2220's Artefact-path suffix:
 *     a real payload always carries one.
 * /code-review's rules read the rule fragments in <rules-dir>, the hook's
 * fallbacks standing in for any absent, and the review tier it adds at run
 * time is reserved at <rule-cap> plus the blank line joining it (#1697). Its
 * areas prelude is uncapped, so a host declaring many areas can still cross
 * the threshold; the injector then puts the tier first, inside the preview.
 */

const fs = require("node:fs");
const path = require("node:path");
const { buildArbiterCommand } = require("./build-arbiter-command.js");
const { loadTextModule } = require("./load-text-module.js");
const { writeFd } = require("./write-fd.js");
const { readOutputStylePath } = require("./workflow-core-config.js");
const rs = require("./review-standards.js");
const { reviewAgentType } = require("./review-agent-type.js");
const { reviewSuffix } = require("./review-suffix.js");
const { trimEndRun } = require("./trim-run.js");

/* rendered-injection.js renders with its own probe id; any id mints a suffix
 * of the same length. */
const PROBE_SESSION_ID = "check-injector-margin-probe-00000000";
const PROBE_ISSUE = "1";

/**
 * A rule fragment's text in `dir`, or null where it is absent.
 * @param {string} dir @param {string} id
 */
function fragment(dir, id) {
	try {
		return trimEndRun(
			fs.readFileSync(path.join(dir, `${id}.txt`), "utf8"),
			"\n",
		);
	} catch {
		return null;
	}
}

/**
 * Each command and its payload's length.
 * @param {Record<string, any>} t the evaluated text module
 * @param {string} rulesDir
 * @param {number} ruleCap
 * @param {string} root the host whose own values are read
 * @returns {[string, number][]}
 */
function measure(t, rulesDir, ruleCap, root) {
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
	return commands.map((matched) => {
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
		let standards = t.standardsText(
			rs.standardsState(root, root),
			rs.standardsShown(rs.standardsBase(root), root),
		);
		const glossary = rs.standardsGlossary(root);
		if (glossary !== null)
			standards = t.withGlossary(standards, rs.standardsShown(glossary, root));
		const rules = t.codeReviewRules({
			standards,
			dispatch: t.dispatchText(
				reviewAgentType(root),
				reviewSuffix(PROBE_SESSION_ID),
				fragment(rulesDir, "review-dispatch-shape") ??
					t.DISPATCH_SHAPE_FALLBACK,
			),
			deviationsRead:
				fragment(rulesDir, "review-deviations-read") ??
				t.DEVIATIONS_READ_FALLBACK,
			disposition:
				fragment(rulesDir, "review-finding-destination") ??
				t.DISPOSITION_FALLBACK,
			pricedOptions,
		});
		return [matched, rules.length + 2 + ruleCap];
	});
}

if (require.main === module) {
	const [file, rulesDir, cap] = process.argv.slice(2);
	if (!file || !rulesDir || !/^\d+$/.test(cap ?? "")) {
		writeFd(
			2,
			"usage: injector-margin.js <text-module> <rules-dir> <rule-cap>\n",
		);
		process.exit(2);
	}
	try {
		const t = loadTextModule(fs.readFileSync(file, "utf8"), file);
		writeFd(
			1,
			measure(t, rulesDir, Number(cap), process.cwd())
				.map(([cmd, n]) => `${cmd} ${n}\n`)
				.join(""),
		);
	} catch (e) {
		writeFd(2, `${e instanceof Error ? e.message : String(e)}\n`);
		process.exit(2);
	}
}

module.exports = { measure };
