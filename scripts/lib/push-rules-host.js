/*
 * push-rules-host.js — the production ports the dispatcher wires into the
 * guard-push-rules core, lib/push-rules.js (#2785, #3226).
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { markersDir } = require("./marker-root.js");
const { reviewOwed } = require("./push-review.js");
const { pushGateState } = require("./test-gate.js");
const { readConfig } = require("./workflow-core-config.js");

/**
 * @param {string} root
 * @param {(what: string, detail?: string) => void} log
 * @returns {import("./push-rules.js").PushPorts}
 */
function buildHostPorts(root, log) {
	return {
		reviewOwed: (tree, sessionId) => reviewOwed({ sessionId, tree, log }),
		markerSum: (sessionId) => {
			if (!sessionId) return "";
			try {
				const marker = fs.readFileSync(
					path.join(markersDir(root), `.codereview-pass-${sessionId}`),
				);
				return crypto.createHash("sha256").update(marker).digest("hex");
			} catch {
				/* No readable marker is no marker: the warn's latch then keys on
				 * none (#1840). */
				return "";
			}
		},
		pushOwesCertificate: () => {
			const { state, line } = pushGateState({ root });
			if (state === "broken")
				log("test-gate.js refused the config, push-green-suite withheld", line);
			return state === "owes";
		},
		deploysVercel: () => {
			try {
				return readConfig({ root, quiet: true }).deploy === "vercel";
			} catch {
				/* The config fault is the module read's to log; an unreadable config
				 * hands the Vercel rule to nobody (mantahostels#103 §6). */
				return false;
			}
		},
		/* The one workflow check-ci-status.js reads, on a schedule. */
		hasSweep: () => {
			try {
				return /^[ \t]*schedule:/m.test(
					fs.readFileSync(
						path.join(root, ".github", "workflows", "scheduled-checks.yml"),
						"utf8",
					),
				);
			} catch {
				/* No readable workflow is no sweep: the rule naming it is withheld
				 * (mantahostels#103 §6). */
				return false;
			}
		},
	};
}

module.exports = { buildHostPorts };
