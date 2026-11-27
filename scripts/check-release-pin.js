#!/usr/bin/env node

const fs = require("node:fs");
const { scriptPath } = require("./lib/script-path.js");
const path = require("node:path");
const { hostRoot } = require("./lib/host-root.js");
const { now, runCheck } = require("./lib/check");
const { requiredGroup } = require("./lib/regex-group.js");
const { caught } = require("./lib/caught.js");
const { compareVersions } = require("./lib/compare-versions.js");
const { execGit } = require("./lib/git.js");
const { trimEndRun } = require("./lib/trim-run.js");

/** @typedef {import("./lib/check").Ctx} Ctx */

const TAG_RE = /^v\d+\.\d+\.\d+$/;

const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** @param {string} tag */
const tagVersion = (tag) => tag.replace(/^v/, "");

const FETCH_REMOTE_RE = /^(\S+)\s+(\S+)\s+\(fetch\)$/;

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function semverGt(a, b) {
	return compareVersions(semverParts(a), semverParts(b)) > 0;
}

/**
 * @param {string} v
 * @returns {[number, number, number]}
 */
function semverParts(v) {
	const [major, minor, patch] = v.split(".").map(Number);
	if (major === undefined || minor === undefined || patch === undefined)
		throw new Error(`semverGt: \`${v}\` has fewer than three parts`);
	return [major, minor, patch];
}

// guess, workflow-core#257
const LS_REMOTE_TIMEOUT_MS = 15_000;

// guess, two ~12h sweep intervals, workflow-core#4675
const PENDING_CUT_HOURS = 24;

/**
 * @param {string} url
 * @returns {string}
 */
function normaliseUrl(url) {
	const hostPath = url
		.trim()
		.replace(/^[a-z+]+:\/\//i, "")
		.replace(/^[^@/]+@/, "")
		.replace(/:(?=[^\d/])/, "/");
	return trimEndRun(hostPath, "/")
		.replace(/\.git$/, "")
		.toLowerCase();
}

/**
 * @param {string} root
 * @param {string[]} args
 * @param {import("node:child_process").ExecFileSyncOptions} [opts]
 * @returns {string}
 */
function git(root, args, opts = {}) {
	return execGit(args, {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		...opts,
	}).toString();
}

/**
 * @param {unknown} e
 * @returns {boolean}
 */
const isApparatusFailure = (e) => caught(e).code === "ENOENT";

/**
 * @param {unknown} e
 * @returns {string}
 */
const parseGitReason = (e) => {
	const { stderr, message } = caught(e);
	return (stderr ?? "").trim().split("\n")[0] || message || "git failed";
};

/**
 * @param {Ctx} ctx
 * @param {string} root
 * @param {string} url
 * @returns {string}
 */
function readRemoteFor(ctx, root, url) {
	let listed;
	try {
		listed = git(root, ["remote", "-v"]);
	} catch (e) {
		ctx.broken(`cannot list this repo's remotes — ${parseGitReason(e)}`);
	}
	const want = normaliseUrl(url);
	for (const line of listed.split("\n")) {
		const m = line.match(FETCH_REMOTE_RE);
		if (m && normaliseUrl(requiredGroup(m, 2, FETCH_REMOTE_RE)) === want)
			return requiredGroup(m, 1, FETCH_REMOTE_RE);
	}
	return url;
}

/**
 * @param {Ctx} ctx
 * @param {string} root
 * @param {string} name
 * @param {{url?: string}} source
 * @returns {string}
 */
function readRequiredRemote(ctx, root, name, source) {
	const remote =
		ctx.value("--remote") ?? readRemoteFor(ctx, root, source.url ?? "");
	if (!remote) {
		ctx.broken(
			`.claude-plugin/marketplace.json gives ${name} no \`source.url\` to query`,
		);
	}
	return remote;
}

/**
 * @param {Ctx} ctx
 * @param {string} root
 * @param {string} remote
 * @returns {{ tags: string[] } | { unreachable: string }}
 */
function readCutTagsOnRemote(ctx, root, remote) {
	try {
		const out = git(root, ["ls-remote", "--tags", remote, "refs/tags/v*"], {
			timeout: LS_REMOTE_TIMEOUT_MS,
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		});
		const tags = out
			.split("\n")
			.flatMap((line) => {
				const ref = line.split("\t")[1];
				return ref ? [ref.replace(/^refs\/tags\//, "")] : [];
			})
			.filter((t) => TAG_RE.test(t));
		return { tags };
	} catch (e) {
		if (isApparatusFailure(e))
			ctx.broken(`cannot run git to reach ${remote} — ${parseGitReason(e)}`);
		return { unreachable: parseGitReason(e) };
	}
}

/**
 * @param {string[]} tags
 * @returns {string|null}
 */
const newestTag = (tags) =>
	tags
		.toSorted((a, b) => (semverGt(tagVersion(a), tagVersion(b)) ? 1 : -1))
		.at(-1) ?? null;

/**
 * @param {Ctx} ctx
 * @param {string} remote
 * @param {string} reason
 * @param {{ skipLines: string, failLine: string }} prose
 * @returns {{ noun: string }}
 */
function remoteUnreachable(ctx, remote, reason, { skipLines, failLine }) {
	if (!ctx.has("--require-remote")) ctx.skip(skipLines);

	ctx.fail(
		"REMOTE-UNREACHABLE",
		failLine,
		{ remote, reason },
		`unreachable:${remote}`,
	);
	ctx.say(
		`${remote} could not be reached — ${reason}\n\n` +
			"This run was asked to require the remote, so an unreachable one is a\n" +
			"fault rather than a skip: nothing here proves what an adopter can\n" +
			"install, and a run that can never reach the remote would report healthy\n" +
			"forever.\n\n" +
			"On the sweep, two things carry the reach and either can break silently:\n" +
			"actions/checkout@v4's `persist-credentials` writing the auth header, and\n" +
			".claude-plugin/marketplace.json's `source.url` still matching a configured\n" +
			"remote's fetch URL. A transient outage is likelier and the next sweep\n" +
			"clears it; a second red in a row is one of those two.",
	);
	return { noun: "remote that could not be reached" };
}

/**
 * @param {Ctx} ctx
 * @param {string} root
 * @param {string} tag
 * @returns {boolean}
 */
function hasLocalTag(ctx, root, tag) {
	try {
		return git(root, ["tag", "--list", tag]).trim() !== "";
	} catch (e) {
		ctx.broken(`cannot list this repo's tags — ${parseGitReason(e)}`);
	}
}

/**
 * @returns {boolean}
 */
function hasTrustworthyLocalTags() {
	return process.env.GITHUB_ACTIONS !== "true";
}

const unresolvedTagRemedy = (
	/** @type {string} */ remote,
	/** @type {string} */ tag,
	/** @type {string} */ cutInstruction = `  node ${scriptPath("release-plugin.js")}`,
) =>
	`  # if ${tag} was already cut, just not pushed:\n` +
	`  git push ${remote} ${tag}\n` +
	"  # otherwise, cut it first:\n" +
	cutInstruction;

/**
 * @param {Ctx} ctx
 * @param {string} root
 * @param {string} at
 */
function readJson(ctx, root, at) {
	try {
		return JSON.parse(fs.readFileSync(at, "utf8"));
	} catch (e) {
		ctx.broken(`cannot read ${path.relative(root, at)} — ${caught(e).message}`);
	}
}

/**
 * @param {Ctx} ctx
 * @param {string} name
 * @param {string} version
 */
function failNoEntry(ctx, name, version) {
	ctx.fail(
		"NO-ENTRY",
		`.claude-plugin/marketplace.json lists no plugin named ${name}`,
		{ name },
		`no-entry:${name}`,
	);
	ctx.say(
		`.claude-plugin/marketplace.json has no entry for ${name}, so nothing\n` +
			"tells an adopter where to fetch it. Add the entry, pinned to " +
			`v${version}.`,
	);
	return { noun: "missing marketplace entry" };
}

/**
 * @param {Ctx} ctx
 * @param {{ name: string, ref: string|undefined, version: string, expected: string }} pin
 */
function failPinMismatch(ctx, { name, ref, version, expected }) {
	ctx.fail(
		"PIN-MISMATCH",
		`marketplace pins ${name} to ${ref ?? "no ref"}, but plugin.json says ${version}`,
		{ ref: ref ?? null, version },
		`pin-mismatch:${name}`,
	);
	ctx.say(
		`.claude-plugin/marketplace.json pins ${name} to ${ref ?? "no ref"} while\n` +
			`.claude-plugin/plugin.json says ${version}. An adopter installs what the\n` +
			`marketplace names, so the two must agree. Set the ref to ${expected},\n` +
			"or lower the version to match the ref you meant to publish.",
	);
	return { noun: "pin disagreeing with the plugin version" };
}

/**
 * @param {Ctx} ctx
 * @param {{ root: string, remote: string, expected: string, pointRefFirst: string }} at
 */
function aheadRemedy(ctx, { root, remote, expected, pointRefFirst }) {
	if (!hasTrustworthyLocalTags())
		return unresolvedTagRemedy(remote, expected, pointRefFirst);
	if (hasLocalTag(ctx, root, expected))
		return `  git push ${remote} ${expected}`;
	return pointRefFirst;
}

/**
 * @param {Ctx} ctx
 * @param {{ root: string, name: string, version: string, source: {url?: string}, ref: string }} pin
 */
function judgeNonTagPin(ctx, { root, name, version, source, ref }) {
	const expected = `v${version}`;
	if (!VERSION_RE.test(version))
		ctx.broken(
			`.claude-plugin/plugin.json's version \`${version}\` is not X.Y.Z, so it cannot be compared against a cut tag`,
		);

	if (ctx.has("--pin-only"))
		ctx.skip(
			`${name} is pinned to \`${ref}\`, which only the remote can judge`,
		);

	const remote = readRequiredRemote(ctx, root, name, source);

	const cut = readCutTagsOnRemote(ctx, root, remote);
	if ("unreachable" in cut) {
		return remoteUnreachable(ctx, remote, cut.unreachable, {
			skipLines:
				`${name} is pinned to \`${ref}\`, which is not a release tag, and ${remote}\n` +
				`      could not be reached to find the newest cut tag against — ${cut.unreachable}.`,
			failLine: `${remote} could not be reached to find the newest cut tag ${name}'s \`${ref}\` pin should be judged against`,
		});
	}

	const newest = newestTag(cut.tags);
	if (newest !== null && semverGt(version, tagVersion(newest))) {
		ctx.fail(
			"VERSION-AHEAD",
			`plugin.json says ${version}, ahead of ${newest}, the newest tag ${remote} has, but ${name} is pinned to \`${ref}\`, not a tag`,
			{ ref, version, newest },
			`version-ahead:${name}`,
		);
		const pointRefFirst =
			`  # point the ref at ${expected}, commit, then:\n` +
			`  node ${scriptPath("release-plugin.js")}`;
		const remedy = aheadRemedy(ctx, { root, remote, expected, pointRefFirst });
		ctx.say(
			`.claude-plugin/plugin.json says ${version}, ahead of ${newest}, the\n` +
				`newest release tag ${remote} has. ${name} is pinned to \`${ref}\` rather than\n` +
				"a tag, so the pin-mismatch and tag-cut checks above never see this: an\n" +
				`adopter fetching \`${ref}\` gets the bumped ${version} code with no release\n` +
				"cut behind it. release-plugin.js refuses to cut unless\n" +
				`.claude-plugin/marketplace.json already pins ${expected}, so:\n\n${remedy}`,
		);
		return { noun: "version ahead of every cut tag on a non-tag pin" };
	}

	ctx.skip(
		`${name} is pinned to \`${ref}\`, which is not a release tag — resolvability is not this checker's question`,
	);
}

/**
 * @param {string} root
 * @param {string} ref
 * @returns {number|null}
 */
function readBumpCommittedAt(root, ref) {
	if (git(root, ["rev-parse", "--is-shallow-repository"]).trim() === "true")
		return null;
	const out = git(root, [
		"log",
		"-1",
		"--format=%ct",
		"--pickaxe-regex",
		`-S"ref": *"${ref.replaceAll(".", "\\.")}"`,
		"HEAD",
		"--",
		".claude-plugin/marketplace.json",
	]).trim();
	return out === "" ? null : Number(out);
}

/**
 * @param {{ root: string, ref: string, newest: string|null }} pin
 * @returns {number|null}
 */
function judgePendingCut({ root, ref, newest }) {
	if (newest !== null && !semverGt(tagVersion(ref), tagVersion(newest)))
		return null;
	const committedAt = readBumpCommittedAt(root, ref);
	if (committedAt === null) return null;
	const hoursLeft = PENDING_CUT_HOURS - (now() / 1000 - committedAt) / 3600;
	return hoursLeft > 0 ? hoursLeft : null;
}

/**
 * @param {Ctx} ctx
 * @param {{ root: string, remote: string, ref: string, newest: string|null }} pin
 */
function judgeUnpublishedTag(ctx, { root, remote, ref, newest }) {
	const trusted = hasTrustworthyLocalTags();
	const cutHere = trusted && hasLocalTag(ctx, root, ref);
	if (ctx.has("--require-remote") && !cutHere) {
		const hoursLeft = judgePendingCut({ root, ref, newest });
		if (hoursLeft !== null) {
			const remedy = unresolvedTagRemedy(remote, ref);
			ctx.skip(
				`${ref} is a bump whose release is pending: ${remote} lacks the tag, and the\n` +
					`      cut falls due within ${Math.ceil(hoursLeft)}h, after which this fails.\n` +
					remedy.replace(/^/gm, "      "),
			);
		}
	}

	if (!trusted) {
		ctx.fail(
			"TAG-UNRESOLVED",
			`${ref} is pinned but not on ${remote}, and local tags here are populated from that same remote, so this cannot tell TAG-UNCUT from TAG-UNPUSHED`,
			{ ref, remote },
			`unresolved:${ref}`,
		);
		ctx.say(
			`${ref} is pinned but ${remote} does not have it. This run's local tags are\n` +
				"populated from that same remote, so a tag absent from the remote is\n" +
				"absent locally too here, and this checker cannot tell whether it was cut\n" +
				"and never pushed, or never cut at all.\n\n" +
				unresolvedTagRemedy(remote, ref),
		);
		return { noun: "pinned tag unresolved against the remote" };
	}

	if (cutHere) {
		ctx.fail(
			"TAG-UNPUSHED",
			`${ref} was cut here but ${remote} does not have it`,
			{ ref, remote },
			`unpushed:${ref}`,
		);
		ctx.say(
			`${ref} exists in this checkout but not on ${remote}, so every adopter is\n` +
				"still on whatever tag was last published — silently, because the repo\n" +
				"shows a bumped plugin.json and the adopter shows a plausible older\n" +
				"version.\n\n" +
				`  git push ${remote} ${ref}`,
		);
		return { noun: "cut tag that was never pushed" };
	}

	ctx.fail(
		"TAG-UNCUT",
		`${ref} is pinned but exists neither here nor on ${remote}`,
		{ ref, remote },
		`uncut:${ref}`,
	);
	ctx.say(
		`.claude-plugin/marketplace.json pins ${ref}, and no such tag exists here or\n` +
			`on ${remote}. Adopters are pinned to a ref that resolves to nothing, so\n` +
			"they stay on the last tag that did.\n\n" +
			`  node ${scriptPath("release-plugin.js")}\n` +
			`  git push ${remote} ${ref}`,
	);
	return { noun: "pinned tag that was never cut" };
}

/**
 * @param {Ctx} ctx
 * @param {{ root: string, name: string, source: {url?: string}, ref: string }} pin
 */
function judgeTagPin(ctx, { root, name, source, ref }) {
	if (ctx.has("--pin-only"))
		return { okLine: `${name} pins ${ref}, matching plugin.json` };

	const remote = readRequiredRemote(ctx, root, name, source);

	const cut = readCutTagsOnRemote(ctx, root, remote);

	if ("unreachable" in cut) {
		return remoteUnreachable(ctx, remote, cut.unreachable, {
			skipLines:
				`could not reach ${remote} to check that ${ref} is published — ${cut.unreachable}.\n` +
				"      An adopter fetches from the remote, so this run proves nothing about\n" +
				"      what adopters can install. Re-run with the network up.",
			failLine: `${remote} could not be reached to check that ${ref} is published`,
		});
	}

	if (cut.tags.includes(ref)) {
		return {
			okLine: `${name} pins ${ref}, and ${remote} has it`,
		};
	}

	return judgeUnpublishedTag(ctx, {
		root,
		remote,
		ref,
		newest: newestTag(cut.tags),
	});
}

runCheck({
	name: "release-pin",
	usage:
		"node check-release-pin.js [--warn] [--remote <name-or-url>] [--require-remote] [--pin-only]",
	valueFlags: ["--remote"],
	flags: ["--require-remote", "--pin-only"],
	run(/** @type {Ctx} */ ctx) {
		const root = hostRoot();
		const pluginPath = path.join(root, ".claude-plugin", "plugin.json");
		const marketPath = path.join(root, ".claude-plugin", "marketplace.json");

		if (!fs.existsSync(pluginPath) || !fs.existsSync(marketPath))
			ctx.skip("this repo publishes no plugin — nothing pins a release tag");

		const plugin = readJson(ctx, root, pluginPath);
		const market = readJson(ctx, root, marketPath);
		const name = plugin.name;
		const version = plugin.version;
		if (typeof name !== "string" || typeof version !== "string")
			ctx.broken(".claude-plugin/plugin.json carries no `name` and `version`");

		const entry = (market.plugins ?? []).find(
			(/** @type {{name?: string}} */ p) => p.name === name,
		);
		if (!entry) return failNoEntry(ctx, name, version);

		const source = entry.source ?? {};
		if (source.source !== "url") {
			ctx.skip(
				`${name} is sourced as \`${source.source ?? "(none)"}\` rather than a URL — no tag to resolve`,
			);
		}

		const ref = source.ref;
		const expected = `v${version}`;

		if (ref !== undefined && !TAG_RE.test(ref))
			return judgeNonTagPin(ctx, { root, name, version, source, ref });

		if (ref !== expected)
			return failPinMismatch(ctx, { name, ref, version, expected });

		return judgeTagPin(ctx, { root, name, source, ref });
	},
});
