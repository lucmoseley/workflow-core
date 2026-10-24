#!/usr/bin/env node
/*
 * check-gate-switches.js — refuses a commit while the tracked tree holds what a
 * gate guards but that gate's switch is off (#1506, ruled at #1410 Q1 (A)).
 *
 * Usage:
 *   node check-gate-switches.js [--json] [--warn]
 *
 * A gate over a missing document checks nothing, so a new repo starts with no
 * module and no commands — but only because this refuses the first commit
 * after the subject lands. The four subjects, found by lib/gate-subjects.js,
 * which init-adopter.js and /new-repo read too:
 *
 *   a test file                         commands.test undeclared
 *   docs/reference-roadmap.html         module "roadmap" off
 *   the manual, or a doc-map §B entry   module "governance" off
 *   the brand sheet plus app/           module "site" off
 *
 * WHOLE TREE, NOT THE STAGED PATHS: a repo that adopted before this shipped
 * holds its subjects already, and a staged-only form would never see them.
 * The switches are read from the working copy's config, where the gates
 * they arm read it; a config committed with one off is refused at the first
 * commit made from it.
 *
 * IMPLICIT:  on every commit, refuses one while a tracked test file, roadmap, manual, §B entry or brand sheet with app/ sits in the tree with its gate's switch off.
 * JUSTIFIED: fail-safe — a config that will not read, or a git that cannot list the index, is BROKEN rather than green.
 * DEFEAT:    --warn caps findings below the gating line, and pre-commit never passes it; WFC_MODULES, a test-injection point, replaces the declared modules.
 */

const { runCheck } = require("./lib/check.js");
const config = require("./lib/workflow-core-config.js");
const { subjectsInIndex } = require("./lib/gate-subjects.js");
const { caught } = require("./lib/caught.js");
const { corePath } = require("./lib/script-path.js");

/** @typedef {import("./lib/check").CheckContext} Ctx */
/**
 * @typedef {{on: (cfg: ReturnType<typeof config.readConfig>) => boolean,
 *   gate: string, fix: string}} Switch whether the host has set it, the line
 *   saying it is off, and the config edit that sets it
 */

const INIT = corePath("scripts/init-adopter.js");

/* A guess, not a measurement: enough paths to recognise what was found,
 * few enough that the refusal's first line stays one line. */
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
	gate: config.moduleOffLine(m),
	fix: `add "${m}" to "modules"`,
});

/**
 * A test file's switch is its command, not its `suites` module: the command
 * is gated at commit whatever `suites` says (#1410 row 4).
 * @type {Switch}
 */
const TEST_SWITCH = {
	on: (cfg) => Boolean(cfg.commands.test),
	gate: config.commandUndeclaredLine("test"),
	fix: 'declare the command that runs them as "commands": { "test": "…" }',
};

/** @param {import("./lib/gate-subjects.js").Found} s */
const switchOf = (s) =>
	s.subject === "tests" ? TEST_SWITCH : moduleSwitch(s.module);

runCheck({
	name: "gate-switches",
	usage: "node check-gate-switches.js [--json] [--warn]",
	run(/** @type {Ctx} */ ctx) {
		let cfg;
		let subjects;
		try {
			cfg = config.readConfig({ quiet: true });
			subjects = subjectsInIndex(process.cwd());
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
});
