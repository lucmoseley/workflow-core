#!/usr/bin/env node
// #5865

const path = require("node:path");
const { ignoreFailure } = require("./lib/caught.js");
const { isFounderTyping } = require("./lib/founder-typing");
const hookMessage = require("./lib/hook-message");
const { hostRoot } = require("./lib/host-root");
const {
	isAbsentSinceSwitch,
	markPresent,
	presenceAt,
	readLastTypedAt,
} = require("./lib/presence");
const { guardDisabled } = require("./lib/workflow-core-config");

/** @param {Date} now */
function isReminderOwed(now) {
	try {
		const lastTyped = readLastTypedAt();
		if (presenceAt(lastTyped, now) === "present") return false;
		const { readControlFile } = require("./lib/refill-files.js");
		const control = readControlFile(() => undefined);
		return (
			control?.scope.mode === "away" &&
			isAbsentSinceSwitch(control.away?.since ?? null, lastTyped, now)
		);
	} catch {
		return false;
	}
}

function main() {
	if (guardDisabled(path.basename(__filename), { root: hostRoot() })) return;
	if (!isFounderTyping(hookMessage.readPayload())) return;
	const now = new Date();
	const owed = isReminderOwed(now);
	markPresent(now);
	if (!owed) return;
	const { scriptPath } = require("./lib/script-path.js");
	process.stdout.write(
		JSON.stringify({
			systemMessage: `away mode is on — run \`node ${scriptPath("refill-loop.js")} set --normal\``,
		}),
	);
}

ignoreFailure(main);
