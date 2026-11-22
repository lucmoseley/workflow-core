const fs = require("node:fs");
const path = require("node:path");

/**
 * @param {string} checks
 * @returns {() => void}
 */
function armLoadFailureStop(checks) {
	/** @param {unknown} e */
	const block = (e) => {
		let payload;
		try {
			payload = JSON.parse(fs.readFileSync(0, "utf8"));
		} catch {
			return;
		}
		if (payload?.stop_hook_active) return;
		const guard = path.basename(process.argv[1] ?? "this guard");
		const cause = String(e instanceof Error ? e.message : e).split("\n")[0];
		process.stdout.write(
			JSON.stringify({
				decision: "block",
				reason:
					`${guard} could not load (${cause}), so none of its checks ran ` +
					`on this message: ${checks}. Check the message against the ` +
					"guard-registry rules in your output style, fix what fails and " +
					"stop again — this blocks once a turn — and tell the founder the " +
					"guard is broken.",
			}),
		);
	};
	process.once("uncaughtException", block);
	return () => process.off("uncaughtException", block);
}

module.exports = { armLoadFailureStop };
