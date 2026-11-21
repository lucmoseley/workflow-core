#!/usr/bin/env node
/*
 * check-release-lag.js — how far the newest release tag lags `origin/main`,
 * and each adopter's pin beside the version it has installed (#4448, #5228).
 *
 * THE LAG IS MEASURED FROM THE TAG'S SOURCE, never the tag: release-plugin.js
 * cuts each release as a root commit, so `git rev-list <tag>..origin/main`
 * counts all of main's history. The source is the commit the release
 * message names (lib/release-tags.js's RENDERED_FROM). Days run from that
 * commit's committer date to `origin/main`'s, so an idle `main` ages nothing.
 *
 * LOCAL REFS ONLY, no fetch. A clone that has not fetched lately under-reads
 * the lag.
 *
 * ADOPTERS are lib/refill-repos.js's: each main checkout under `$HOME` with a
 * `.claude/workflow-core.json`, its pin read from `.claude/settings.json` and
 * its installed version from the config dir's `installed_plugins.json`, as
 * lib/plugin-state.js reads both.
 *
 * WFC_REPO_ROOT, HOME and CLAUDE_CONFIG_DIR inject the repo, the adopters'
 * home and the install registry.
 */

const path = require("node:path");
const { runCheck } = require("./lib/check");
const { caught } = require("./lib/caught.js");
const { readCommitOrBroken } = require("./lib/commit-sha.js");
const { hostRoot } = require("./lib/host-root.js");
const {
	findInstallRecord,
	findPin,
	isCoreHost,
	readJsonSafe,
	readRunningPlugin,
	resolveConfigDir,
} = require("./lib/plugin-state.js");
const { homeDir, readAdopterCheckouts } = require("./lib/refill-repos.js");
const {
	LAG_WARN_DAYS,
	MAIN,
	formatAdopters,
	judgeInstalls,
	judgeLag,
	labelPin,
	readLag,
} = require("./lib/release-lag.js");

const PLUGIN = "workflow-core";

/**
 * The row's recorded version, else the manifest its `installPath` holds.
 * @param {string} pluginsDir @param {string|null} marketplace @param {string} root
 * @returns {string|null}
 */
function installedVersion(pluginsDir, marketplace, root) {
	const row = findInstallRecord(pluginsDir, PLUGIN, marketplace, root);
	return (
		row?.version ?? readRunningPlugin(row?.installPath ?? null)?.version ?? null
	);
}

/** @param {string} home @returns {import("./lib/release-lag").Adopter[]} */
function readAdopters(home) {
	const pluginsDir = path.join(resolveConfigDir(), "plugins");
	return readAdopterCheckouts(home)
		.included.filter((root) => !isCoreHost(root))
		.map((root) => {
			const settings =
				/** @type {import("./lib/plugin-state").AdopterSettings|null} */ (
					readJsonSafe(path.join(root, ".claude", "settings.json"))
				);
			const pin = findPin(settings, PLUGIN);
			return {
				name: path.basename(root),
				pin: labelPin(pin),
				installed: installedVersion(pluginsDir, pin.marketplace, root),
			};
		});
}

runCheck({
	name: "release-lag",
	usage: "node check-release-lag.js [--json]",
	/** @param {import("./lib/check").Ctx} ctx */
	run(ctx) {
		const root = process.env.WFC_REPO_ROOT || hostRoot();
		if (!isCoreHost(root))
			ctx.skip("not workflow-core itself; an adopter cuts no release.");
		/* Required past the check above: the release never ships it. */
		const {
			readReleaseTags,
			buildReleaseLagPort,
		} = require("./lib/release-tags.js");
		const tag = readReleaseTags(root).at(-1);
		if (!tag) ctx.skip("no release tag in this clone.");
		const tip = readCommitOrBroken(MAIN, root);
		if (!tip)
			ctx.skip(`no ${MAIN} in this clone; \`git fetch origin\` makes one.`);
		/** @type {import("./lib/release-lag").Reading} */
		let reading;
		try {
			reading = readLag(buildReleaseLagPort(root), tag, tip);
		} catch (e) {
			ctx.broken(`git could not measure ${tag}: ${caught(e).message}`);
		}
		const adopters = readAdopters(homeDir());
		const lag = judgeLag(tag, reading, formatAdopters(adopters));
		const data = {
			tag,
			...reading,
			state: lag.state,
			threshold: LAG_WARN_DAYS,
			adopters,
		};
		/** @type {import("./lib/release-lag").Finding[]} */
		const findings = [];
		if (lag.finding !== null)
			findings.push({ finding: lag.finding, line: lag.line });
		const installs = judgeInstalls(adopters);
		if (installs !== null) findings.push(installs);
		if (findings.length === 0) return { okLine: lag.line, data };
		/* The lag line carries every adopter's pin and install, level ones too. */
		if (lag.finding === null) ctx.say(lag.line);
		for (const { finding, line } of findings) {
			/* lib/check.js records a finding but prints none of it. */
			ctx.warn(finding, line);
			ctx.say(`${finding} — ${line}`);
		}
		return { noun: "release-lag finding(s)", data };
	},
});
