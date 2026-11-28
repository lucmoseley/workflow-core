#!/usr/bin/env node

const path = require("node:path");
const { now, runCheck } = require("./lib/check");
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
const store = require("./lib/arbiter-store");
const { readMainLag, renderSurvey } = require("./lib/level-main.js");
const { homeDir, readAdopterCheckouts } = require("./lib/refill-repos.js");
const {
	LAG_WARN_DAYS,
	MAIN,
	formatAdopters,
	judgeInstalls,
	judgeLag,
	judgeMainLag,
	labelPin,
	readLag,
} = require("./lib/release-lag.js");

const PLUGIN = "workflow-core";

/**
 * @param {string} pluginsDir
 * @param {string|null} marketplace
 * @param {string} root
 * @returns {string|null}
 */
function installedVersion(pluginsDir, marketplace, root) {
	const row = findInstallRecord(pluginsDir, PLUGIN, marketplace, root);
	return (
		row?.version ?? readRunningPlugin(row?.installPath ?? null)?.version ?? null
	);
}

/** @param {string} home @returns {string[]} */
const readAdopterRoots = (home) =>
	readAdopterCheckouts(home).included.filter((root) => !isCoreHost(root));

/** @param {string[]} roots @returns {import("./lib/release-lag").Adopter[]} */
function readAdopters(roots) {
	const pluginsDir = path.join(resolveConfigDir(), "plugins");
	return roots.map((root) => {
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

/**
 * @param {string} root
 * @param {number} at
 * @returns {import("./lib/release-lag").MainReading}
 */
function readMain(root, at) {
	const name = path.basename(root);
	try {
		const lag = readMainLag(root, {
			now: at,
			lastWriter: (rel) => store.readLastWriterOf(rel, { root }),
		});
		return {
			name,
			kind: "read",
			behind: lag.behind,
			fetchedAt: lag.fetchedAt,
			lines: renderSurvey(lag.survey, at),
		};
	} catch (e) {
		return { name, kind: "unread", why: caught(e).message.trim() };
	}
}

runCheck({
	name: "release-lag",
	usage: "node check-release-lag.js [--json]",
	/** @param {import("./lib/check").Ctx} ctx */
	run(ctx) {
		const root = process.env.WFC_REPO_ROOT || hostRoot();
		if (!isCoreHost(root))
			ctx.skip("not workflow-core itself; an adopter cuts no release.");
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
		const roots = readAdopterRoots(homeDir());
		const adopters = readAdopters(roots);
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
		const at = now();
		for (const adopterRoot of roots) {
			const behind = judgeMainLag(readMain(adopterRoot, at), at);
			if (behind !== null) findings.push(behind);
		}
		if (findings.length === 0) return { okLine: lag.line, data };
		if (lag.finding === null) ctx.say(lag.line);
		for (const { finding, line } of findings) {
			ctx.warn(finding, line);
			ctx.say(`${finding} — ${line}`);
		}
		return { noun: "release-lag finding(s)", data };
	},
});
