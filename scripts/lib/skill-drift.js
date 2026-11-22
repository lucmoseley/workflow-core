/*
 * skill-drift.js — diffs an adopter's forked skill against the plugin's
 * current copy of the same skill (spec §Override model, mantahostels#3516
 * story 19: "a bump reports drift between my fork and the core instead of
 * silently overwriting it"; #7 AC3).
 *
 * Pure comparison only, no writing and no git: scripts/upgrade.js is the
 * caller that prints what this returns. Owed there as a one-line wiring debt
 * (#7) — this file is unclaimed, upgrade.js was not at the time #7 landed.
 */

const path = require("node:path");
const { readConfig, hostRoot } = require("./workflow-core-config.js");
const { readText } = require("./file-read.js");

/**
 * @typedef {object} SkillDrift
 * @property {string} name
 * @property {string} recordedFrom the value `overrides.skills` declared for this skill
 * @property {boolean} drifted whether the fork's bytes differ from the plugin's current copy
 * @property {string} [reason] set instead of comparing where either file is missing
 */

/**
 * Every `overrides.skills` entry, checked against the plugin's shipped copy.
 * @param {{root?: string, pluginRoot: string}} opts
 * @returns {SkillDrift[]}
 */
function skillDrift({ root = hostRoot(), pluginRoot }) {
	const { overrides } = readConfig({ root });
	return Object.entries(overrides.skills).map(([name, recordedFrom]) => {
		const forkPath = path.join(root, ".claude", "skills", name, "SKILL.md");
		const corePath = path.join(
			pluginRoot,
			".claude",
			"skills",
			name,
			"SKILL.md",
		);
		const fork = readText(forkPath);
		const core = readText(corePath);
		/** @param {string} reason @returns {SkillDrift} */
		const notCompared = (reason) => ({
			name,
			recordedFrom,
			drifted: false,
			reason,
		});
		/** @param {string} reason @returns {SkillDrift & { unreadable: true }} */
		const unreadable = (reason) => ({
			...notCompared(reason),
			unreadable: true,
		});
		if (fork.state === "absent") return notCompared(`no fork at ${forkPath}`);
		if (fork.state === "unreadable")
			return unreadable(
				`the fork at ${forkPath} will not read: ${fork.message}`,
			);
		if (core.state === "absent")
			return notCompared(`the plugin ships no "${name}" skill at ${corePath}`);
		if (core.state === "unreadable")
			return unreadable(
				`the plugin's "${name}" skill at ${corePath} will not read: ${core.message}`,
			);
		return { name, recordedFrom, drifted: fork.data !== core.data };
	});
}

module.exports = { skillDrift };
