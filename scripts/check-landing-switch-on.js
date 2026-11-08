#!/usr/bin/env node
/*
 * check-landing-switch-on.js — report a repo on workflow-core v2.1.0 or later
 * that still runs as one shared tree: the `landing` module off, or on with
 * the main checkout not cut over (#4688). lib/landing-switch-on.js judges.
 *
 * Usage:  node scripts/check-landing-switch-on.js [--notify] [--json]
 *
 * THE VERSION IS THE CORE THIS FILE SHIPS IN (lib/script-path.js's coreRoot),
 * never the install record: the guards a session runs are this core's, so
 * this core's version is what says whether they are gone.
 *
 * WFC_REPO_ROOT injects the repo, WFC_SCRIPT_ROOT the core.
 *
 * IMPLICIT:  at every session start, reads the core's version, the repo's `landing` module and the main checkout's upstream, and on v2.1.0 or later with the module off or the main checkout not cut over prints a FAIL naming the switch-on steps; prints nothing otherwise.
 * JUSTIFIED: fail-safe — otherwise a repo whose core dropped the shared-tree guards shares one unguarded tree with nothing saying so (#4688).
 * DEFEAT:    none at the hook; switching `landing` on and cutting the main checkout over clears it.
 * TREE:      host — reads the main checkout's config and upstream
 */

const fs = require("node:fs");
const path = require("node:path");
const { runCheck } = require("./lib/check");
const { caught } = require("./lib/caught.js");
const { readCutOver } = require("./lib/cutover.js");
const { GIT_TIMEOUT_MS, gitReader } = require("./lib/git.js");
const { hostRoot } = require("./lib/host-root.js");
const { NOTE, judgeSwitchOn } = require("./lib/landing-switch-on.js");
const { coreRoot, corePath, scriptPath } = require("./lib/script-path.js");
const { moduleOn } = require("./lib/workflow-core-config.js");

/** @param {string} manifest @returns {unknown} */
const readVersion = (manifest) =>
	JSON.parse(fs.readFileSync(manifest, "utf8")).version;

runCheck({
	name: "landing-switch-on",
	usage: "node check-landing-switch-on.js [--notify] [--json]",
	run(ctx) {
		const root = process.env.WFC_REPO_ROOT || hostRoot();
		const manifest = path.join(coreRoot(), ".claude-plugin", "plugin.json");
		const version = (() => {
			try {
				return readVersion(manifest);
			} catch (e) {
				return ctx.broken(`${manifest} will not read: ${caught(e).message}`);
			}
		})();
		if (typeof version !== "string")
			return ctx.broken(`${manifest} names no version.`);
		const landingOn = (() => {
			try {
				return moduleOn("landing", { root });
			} catch (e) {
				return ctx.skip(
					`${root}'s .claude/workflow-core.json will not read: ${caught(e).message}`,
				);
			}
		})();
		const cutOver = landingOn
			? readCutOver(gitReader(root, GIT_TIMEOUT_MS))
			: null;
		const judged = judgeSwitchOn(
			{ version, landingOn, cutOver },
			{
				note: corePath(NOTE),
				cutoverCommand: `node ${scriptPath("cutover-main-checkout.js")}`,
				stepsCommand: `node ${scriptPath("steps-owed.js")} list`,
			},
		);
		const data = { version, landingOn, cutOver, state: judged.state };
		if (judged.state === "before" || judged.state === "unread")
			return ctx.skip(judged.line);
		if (judged.state === "ok") return { okLine: judged.line, data };
		const tag = judged.state === "off" ? "LANDING-OFF" : "NOT-CUT-OVER";
		ctx.fail(tag, judged.line, data);
		ctx.say(`${tag} — ${judged.line}`);
		return { noun: "shared-tree exposure(s)", data };
	},
});
