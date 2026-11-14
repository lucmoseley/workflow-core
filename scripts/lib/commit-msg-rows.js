/*
 * commit-msg-rows.js — .husky/commit-msg's Node steps, one row each, run in
 * order by scripts/commit-msg-dispatch.js through lib/precommit-dispatch.js
 * (#5207).
 */

const path = require("node:path");
const { main: scanCloses } = require("../check-commit-message-closes.js");
const { SPEC: WEAKENS } = require("../check-weakens-line.js");
const { checkInProcess } = require("./check.js");
const { checkSubject } = require("./commit-subject.js");

/**
 * @typedef {import("./precommit-dispatch.js").RowResult} RowResult
 * @typedef {import("./precommit-dispatch.js").Row & {
 *   script: string,
 *   run: (file: string) => RowResult | Promise<RowResult>,
 * }} CommitMsgRow `run` judges the message file `file`; `script` is the file
 *   holding the check, which check-guard-registry.js reads as wired
 */

/** @param {{ code: number, stderr: string }} r */
const asRow = (r) => ({ exit: r.code, stdout: "", stderr: r.stderr });

/** @type {CommitMsgRow[]} */
const ROWS = [
	{
		id: "closing-keyword",
		script: "scripts/check-commit-message-closes.js",
		arm: { always: true },
		when: { unlessRoutes: ["replay"] },
		policy: "gate",
		run: (file) => asRow(scanCloses([file, "commit-msg"])),
	},
	{
		id: "subject",
		script: "scripts/lib/commit-subject.js",
		arm: { always: true },
		when: { unlessRoutes: ["replay"] },
		policy: "gate",
		run: (file) => asRow(checkSubject([file, "commit-msg"])),
	},
	{
		id: "weakens-line",
		script: "scripts/check-weakens-line.js",
		arm: { always: true },
		when: { unlessRoutes: ["replay", "merge"] },
		policy: "gate",
		run: (file) =>
			checkInProcess(WEAKENS, [file], {
				script: path.join(__dirname, "..", "check-weakens-line.js"),
			}),
	},
];

module.exports = { ROWS };
