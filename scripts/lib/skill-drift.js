const path = require("node:path");
const { readConfig, hostRoot } = require("./workflow-core-config.js");
const { readText } = require("./file-read.js");

/**
 * @typedef {object} SkillDrift
 * @property {string} name
 * @property {string} recordedFrom
 * @property {boolean} drifted
 * @property {string} [reason]
 */

/**
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
		const buildNotCompared = (reason) => ({
			name,
			recordedFrom,
			drifted: false,
			reason,
		});
		/** @param {string} reason @returns {SkillDrift & { unreadable: true }} */
		const buildUnreadable = (reason) => ({
			...buildNotCompared(reason),
			unreadable: true,
		});
		if (fork.state === "absent")
			return buildNotCompared(`no fork at ${forkPath}`);
		if (fork.state === "unreadable")
			return buildUnreadable(
				`the fork at ${forkPath} will not read: ${fork.message}`,
			);
		if (core.state === "absent")
			return buildNotCompared(
				`the plugin ships no "${name}" skill at ${corePath}`,
			);
		if (core.state === "unreadable")
			return buildUnreadable(
				`the plugin's "${name}" skill at ${corePath} will not read: ${core.message}`,
			);
		return { name, recordedFrom, drifted: fork.data !== core.data };
	});
}

module.exports = { skillDrift };
