#!/usr/bin/env node
const path = require("node:path");
const { worktreeRoot } = require("./lib/host-root.js");
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
		const root = path.resolve(ctx.value("--root") ?? worktreeRoot());
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
