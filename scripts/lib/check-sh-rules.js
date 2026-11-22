const { parseCommand, walkCommands } = require("./shell-parse.js");

/** @param {string[]} words */
function npmScript(words) {
	if (words[0] !== "npm") return null;
	return (words[1] === "run" ? words[2] : words[1]) ?? null;
}

/**
 * @param {string} command
 * @param {import("./kit-context.js").KitContext} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(command, ctx) {
	let subject = false;
	let fullRun = false;
	walkCommands(
		parseCommand(command),
		({ words }) => {
			const script = npmScript(words);
			if (words[0] === "shellcheck" || script === "check:sh:changed")
				subject = true;
			else if (script === "check:sh") {
				subject = true;
				fullRun = true;
			}
		},
		ctx,
	);
	if (!subject) return null;
	if (fullRun)
		return {
			injectRules: [
				"shellcheck-not-installed",
				"shellcheck-source-directive",
				"shellcheck-changed-scope",
			],
		};
	return {
		injectRules: ["shellcheck-not-installed", "shellcheck-source-directive"],
	};
}

module.exports = { field: "command", noun: "command", decide };
