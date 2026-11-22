const { gitOrNull } = require("./git.js");

const SCISSORS = /^# -+ >8 -+/;

/** @returns {"strip" | "scissors" | "keep"} */
function cleanupMode() {
	const configured =
		gitOrNull(["config", "--get", "commit.cleanup"])?.trim() || "default";
	if (configured === "strip" || configured === "scissors") return configured;
	if (configured !== "default") return "keep";
	return process.env.GIT_EDITOR === ":" ? "keep" : "strip";
}

/**
 * @param {string} raw
 * @returns {string[]}
 */
function recordedLines(raw) {
	const mode = cleanupMode();
	/** @type {string[]} */
	const kept = [];
	for (const line of raw.split("\n")) {
		if (mode !== "keep" && SCISSORS.test(line)) break;
		if (!(mode === "strip" && line.startsWith("#"))) kept.push(line);
	}
	return kept;
}

module.exports = { recordedLines };
