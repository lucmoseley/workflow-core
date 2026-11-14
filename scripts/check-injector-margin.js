#!/usr/bin/env node
/*
 * check-injector-margin.js — what each tracker command's injected payload
 * measures, against the harness's 10,000-character persistence threshold
 * (mantahostels#1915).
 *
 * Usage:
 *   node check-injector-margin.js [--root <dir>] [--index] [--json] [--warn]
 *
 * `--index` is the pre-commit dispatcher row's path: it measures the commit's bytes, the
 * text module, lib/hook-limits.js, the rule fragments and the host values
 * read beside them, never a neighbour's half-saved working copy
 * (mantahostels#250). A bare run measures the working tree. Either way the
 * fragments are the measured root's alone; one it lacks is measured as the
 * text module's fallback, and named.
 *
 * WHY THIS EXISTS SEPARATELY FROM check-context-budget.js. That checker's
 * injection cap is a union of every payload part the text module holds,
 * larger than any real variant and comparable with none. So it cannot report
 * the limit that binds, which is per command. This composes each command's
 * payload through the text module's own composers (lib/injector-margin.js).
 *
 * CROSSING THE THRESHOLD IS SILENT. The harness persists a payload over 10,000
 * characters to a file and hands the session a ~2 KB preview plus a link, which
 * /implement opened 10.2% of the time (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/hook-payload-persistence.md).
 *
 * INCLUSIVE, AND THAT IS A CHOICE RATHER THAN A MEASUREMENT. mantahostels#1868
 * read the constant and not the comparison, so whether the harness persists at
 * exactly the threshold or only above it is unmeasured. Refusing at the
 * boundary costs at most one commit that would in fact have been delivered
 * inline; the other way round costs a rule that silently stops arriving.
 *
 * IMPLICIT:  on every commit staging scripts/lib/tracker-inject-text.js or a rule fragment /code-review's rules read, prints each command's margin against the persistence threshold and refuses a commit whose payload reaches it.
 * JUSTIFIED: fail-safe — a payload over the threshold reaches the session as a preview it seldom opens, and nothing else says so.
 * DEFEAT:    --warn caps the finding below the gating line.
 */

const path = require("node:path");
const { hostRoot } = require("./lib/host-root.js");
const { RULES_DIR, withRuleStore } = require("./lib/rule-text.js");
const {
	MARGIN_INPUTS,
	TIGHT_HEADROOM_CHARS,
	readMargins,
} = require("./lib/injector-margin.js");

/** @typedef {import("./lib/check").Ctx} Ctx */
const { runCheck } = require("./lib/check");

const REMEDY =
	"A payload at or over the threshold is written to a file and replaced inline by a ~2 KB preview plus a link, which a session follows about a tenth of the time. Shrink it — shorten a rule, or replace a paste with a pointer naming the file AND the section that answers, which is the shape mantahostels#1870 landed.";

/** @type {import("./lib/check").CheckSpec} */
const SPEC = {
	name: "injector-margin",
	usage:
		"node check-injector-margin.js [--root <dir>] [--index] [--json] [--warn]",
	valueFlags: ["--root"],
	against: {
		profile: "injector-margin",
		materialise: "blobs",
		pathspecs: () => MARGIN_INPUTS,
	},
	run(/** @type {Ctx} */ ctx) {
		const root = path.resolve(ctx.value("--root") ?? hostRoot());
		/* The root's own fragments and no other layer, so --index never reads a
		 * fragment off the working tree. Pinned in rule-text.js rather than set
		 * in the environment, since the pre-commit dispatcher runs this in a
		 * process every later row shares (#5194). */
		const { limit, sizes, fallbacks } = withRuleStore(
			path.join(root, RULES_DIR),
			"",
			() => readMargins(root),
		);
		ctx.say(
			`Payload per command, against the harness ${limit}-character persistence threshold:`,
		);
		for (const [cmd, n] of sizes) {
			const left = limit - n;
			let note = "";
			if (n >= limit) {
				note =
					"  ← OVER: this payload is persisted to a file, not delivered inline";
				ctx.fail(
					"PAYLOAD-OVER",
					`/${cmd}'s payload is ${n} chars, at or over the ${limit}-character threshold.`,
					{ command: cmd, chars: n },
					cmd,
				);
			} else if (left < TIGHT_HEADROOM_CHARS)
				note = "  ← tight: under one rule of headroom";
			ctx.say(
				`  /${cmd.padEnd(12)} ${String(n).padStart(5)} chars, ${String(left).padStart(5)} left${note}`,
			);
		}
		for (const id of fallbacks) {
			const message = `/code-review measured with the text module's fallback for unreadable fragment ${id}.`;
			ctx.say(message);
			ctx.warn("FRAGMENT-FALLBACK", message, { id }, id);
		}
		if (ctx.findings.some((f) => f.severity === "FAIL")) ctx.say(`\n${REMEDY}`);
		return {
			okLine: `${sizes.length} command payload(s), each under the ${limit}-character threshold.`,
			noun: "payload(s) at or over the threshold or measured on a fallback",
			count: ctx.findings.length,
			data: { limit, sizes: Object.fromEntries(sizes) },
		};
	},
};

module.exports = { SPEC };
if (require.main === module) runCheck(SPEC);
