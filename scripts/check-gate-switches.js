#!/usr/bin/env node
const { runCheck } = require("./lib/check.js");
const config = require("./lib/workflow-core-config.js");
const { readIndexSubjects } = require("./lib/gate-subjects.js");
const { caught } = require("./lib/caught.js");
const { corePath } = require("./lib/script-path.js");

/** @typedef {import("./lib/check").Ctx} Ctx */
/**
 * @typedef {{on: (cfg: ReturnType<typeof config.readConfig>) => boolean,
 *   gate: string, fix: string}} Switch
 */

const INIT = corePath("scripts/init-adopter.js");

const SHOWN = 3;

/** @param {string[]} found */
function listedPaths(found) {
	const shown = found.slice(0, SHOWN).join(", ");
	return found.length > SHOWN
		? `${shown} and ${found.length - SHOWN} more`
		: shown;
}

/**
 * @param {import("./lib/workflow-core-config.js").Module} m
 * @returns {Switch}
 */
const moduleSwitch = (m) => ({
	on: (cfg) => cfg.modules.includes(m),
	gate: config.buildModuleOffLine(m),
	fix: `add "${m}" to "modules"`,
});

/** @type {Switch} */
const TEST_SWITCH = {
	on: (cfg) => Boolean(cfg.commands.test),
	gate: config.buildCommandUndeclaredLine("test"),
	fix: 'declare the command that runs them as "commands": { "test": "…" }',
};

/** @param {import("./lib/gate-subjects.js").Found} s */
const switchOf = (s) => ("module" in s ? moduleSwitch(s.module) : TEST_SWITCH);

/** @type {import("./lib/check.js").CheckSpec} */
const SPEC = {
	name: "gate-switches",
	usage: "node check-gate-switches.js [--json] [--warn]",
	run(/** @type {Ctx} */ ctx) {
		let cfg;
		let subjects;
		try {
			cfg = config.readConfig({ quiet: true });
			subjects = readIndexSubjects(process.cwd());
		} catch (e) {
			ctx.broken(caught(e).message);
		}
		const off = subjects.filter((s) => !switchOf(s).on(cfg));
		for (const s of off) {
			const { subject, found } = s;
			const { gate, fix } = switchOf(s);
			ctx.fail(
				"GATE-OFF",
				`${listedPaths(found)} tracked, but ${gate}`,
				{ subject, found: found.length },
				subject,
			);
			ctx.say(`The tree tracks ${listedPaths(found)}, but ${gate}.`);
			ctx.say(`  Fix: ${fix} in ${config.CONFIG_PATH}, then run`);
			ctx.say(`    node ${INIT} --no-plugin-install`);
			ctx.say("  and commit what it wrote with this change.");
		}
		return {
			okLine: "every gate whose subject the tree holds is switched on.",
			noun: "gate(s) switched off over a subject the tree holds",
		};
	},
};

module.exports = { SPEC };
if (require.main === module) runCheck(SPEC);
