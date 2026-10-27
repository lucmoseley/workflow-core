/*
 * load-failure-stop.js — a Stop guard whose own libs will not load blocks the
 * stop once a turn instead of failing open (#2645). A top-level `require` that
 * throws leaves every check unrun, and the registration's `|| true` swallows
 * the crash; so the guard arms this first, before any other `require`, and
 * disarms it once loaded. Node builtins alone: any other lib may be the one
 * missing.
 *
 * It reads stdin itself, the one Stop-guard read outside lib/stop-guard.js,
 * because that lib may be what failed. The re-stop, whose payload carries
 * `stop_hook_active`, passes, so a broken install costs a round a turn; a
 * payload it cannot read allows.
 */

const fs = require("node:fs");
const path = require("node:path");

/**
 * Arm the block while the guard loads.
 * @param {string} checks what the guard's checks are, for the reason
 * @returns {() => void} disarm, called once every `require` has returned
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
