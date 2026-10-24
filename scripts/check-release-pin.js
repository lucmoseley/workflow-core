#!/usr/bin/env node
/*
 * check-release-pin.js — does the tag `.claude-plugin/marketplace.json` pins
 * actually exist where an adopter fetches it? (#257) And, for a branch- or
 * SHA-pinned entry, which composes with none of the tag-pinned findings
 * below: is `plugin.json`'s version already ahead of every tag the remote
 * has cut (#261)?
 *
 * #261's VERSION-AHEAD FIRES ON A WORKING-TREE READ (see READS THE WORKING
 * TREE below), so its false-positive window is not just the few minutes
 * between a bump commit and its cut — it opens the moment the version is
 * EDITED, committed or not. VERSION-AHEAD also makes a network `ls-remote`
 * call on the non-tag branch (#261), so a branch/SHA pin SKIPs on an
 * unreachable remote too — and
 * FAILs there under --require-remote, that limb routing through the same
 * helper as the tag-pinned one (#263). A
 * version behind or level with the newest cut tag, or a remote that has cut
 * no release tag at all, is a plain SKIP, not a fault.
 *
 * Usage:
 *   node check-release-pin.js [--warn] [--remote <name-or-url>] [--require-remote]
 *
 * THE REMOTE IS THE SUBJECT, never the local tag set. A tag cut here and never
 * pushed is exactly what bit in #257, and `git tag --list` reads it as healthy;
 * the local tag only tells TAG-UNPUSHED apart from TAG-UNCUT in the remedy.
 * `release-plugin.js` refuses the reverse case — a cut the marketplace does not
 * pin (its `pins ... not ...` message) — so this is the other half of that pair.
 *
 * WHY THIS IS NOT A PRE-COMMIT GATE, though #257 asks for one. Resolvability
 * cannot be judged at commit time: `release-plugin.js` reads the bump from
 * `HEAD:.claude-plugin/plugin.json`, refuses a dirty tree, and refuses a tag
 * that already exists — so the bump must be COMMITTED while its tag does not
 * yet resolve. `npm run status` is #257's other named home and the only one
 * the ordering leaves open.
 *
 * IT DOES FIRE UNATTENDED (#260): a step in the `Document guards` job of
 * .github/workflows/roadmap-digest.yml, which every scheduled sweep runs. That
 * job is ungated by scheduled-checks.yml's skip gate and its minute is already
 * billed, so the placement costs no Actions minutes. The detection lag is the
 * DELIVERED sweep interval, ~12 hours — the cron asks for four a day and
 * GitHub delivers late and drops slots (mantahostels#2228), so 6h is the ask, not the lag.
 *
 * AN UNREACHABLE REMOTE GATES UNDER --require-remote, AND ONLY THERE (#263),
 * against lib/check.js's alphabet. The sweep step passes it and nothing else
 * does; remoteUnreachable() carries why, and the price.
 *
 * READS THE WORKING TREE, where `release-plugin.js` reads `HEAD:`. A reporter
 * should answer for the bump you are looking at; the consequence is that a
 * dirty `.claude-plugin/` makes this and the cut disagree until it is committed.
 *
 * MISSING PLUGIN FILES ARE A SKIP, not a fault: this script ships into every
 * adopter, and an adopter publishes no marketplace of its own.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { hostRoot } = require("./lib/host-root.js");
const { runCheck } = require("./lib/check");
const { requiredGroup } = require("./lib/regex-group.js");
const { caught } = require("./lib/caught.js");

/** @typedef {import("./lib/check").CheckContext} Ctx */

/** A release tag as `release-plugin.js` spells one. */
const TAG_RE = /^v\d+\.\d+\.\d+$/;

/**
 * A bare `plugin.json` version in the same three-numeric-part shape a
 * release tag requires. `semverGt` needs this: an unparsed part becomes
 * `NaN`, and `NaN !== n` reads as "not equal" while `NaN > n` reads `false`
 * either way round, so a malformed version would silently compare as NOT
 * ahead rather than surface as the fault it is.
 */
const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** @param {string} tag `v1.2.3` -> `1.2.3` */
const tagVersion = (tag) => tag.replace(/^v/, "");

/** `git remote -v`'s fetch line: name, then URL. */
const FETCH_REMOTE_RE = /^(\S+)\s+(\S+)\s+\(fetch\)$/;

/**
 * @param {string} a `1.2.3`
 * @param {string} b `1.2.3`
 * @returns {boolean} whether `a` is a later semver than `b`
 */
function semverGt(a, b) {
	const [a1, a2, a3] = semverParts(a);
	const [b1, b2, b3] = semverParts(b);
	if (a1 !== b1) return a1 > b1;
	if (a2 !== b2) return a2 > b2;
	return a3 > b3;
}

/**
 * Both callers pass a version VERSION_RE or TAG_RE has passed, so a missing
 * part is a broken invariant.
 * @param {string} v `1.2.3`
 * @returns {[number, number, number]}
 */
function semverParts(v) {
	const [major, minor, patch] = v.split(".").map(Number);
	if (major === undefined || minor === undefined || patch === undefined)
		throw new Error(`semverGt: \`${v}\` has fewer than three parts`);
	return [major, minor, patch];
}

/* Long enough for a cold TLS handshake to a private repo, short enough that a
 * hung fetch does not hold up the rest of `npm run status`. A first guess —
 * nothing here has been profiled. */
const LS_REMOTE_TIMEOUT_MS = 15_000;

/**
 * Compare two git URLs for the same repository, so an `origin` spelled
 * `git@github.com:o/r.git` is recognised as the marketplace's
 * `https://github.com/o/r.git`. Scheme, credentials, a trailing slash and a
 * trailing `.git` all vary between the two spellings without changing where
 * the fetch lands.
 *
 * @param {string} url
 * @returns {string}
 */
function normaliseUrl(url) {
	return url
		.trim()
		.replace(/^[a-z+]+:\/\//i, "")
		.replace(/^[^@/]+@/, "")
		.replace(/:(?=[^\d/])/, "/")
		.replace(/\/+$/, "")
		.replace(/\.git$/, "")
		.toLowerCase();
}

/**
 * One git read against the repo, `stderr` captured so a failure can be told
 * apart rather than collapsed. `opts` carries only what a single caller needs
 * on top — the ls-remote timeout and its credential-prompt gag.
 *
 * @param {string} root
 * @param {string[]} args
 * @param {import("node:child_process").ExecFileSyncOptions} [opts]
 * @returns {string}
 */
function git(root, args, opts = {}) {
	return execFileSync("git", args, {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		...opts,
	}).toString();
}

/**
 * APPARATUS or SUBJECT, for a git call that threw (lib/check.js's split). Git
 * missing from the PATH is this checker's own reading apparatus failing, and a
 * spawn that never produced a process is the one signal that says so; every
 * other failure is git answering about something it was asked to reach.
 *
 * @param {unknown} e
 * @returns {boolean}
 */
const isApparatusFailure = (e) => caught(e).code === "ENOENT";

/**
 * The first line of what git said, or the thrown error's own message.
 *
 * @param {unknown} e
 * @returns {string}
 */
const gitReason = (e) => {
	const { stderr, message } = caught(e);
	return (stderr ?? "").trim().split("\n")[0] || message || "git failed";
};

/**
 * The configured remote whose fetch URL is the marketplace's, or the URL
 * itself where no remote carries it. Naming a remote is preferred over the
 * bare URL because the remote inherits whatever credential and insteadOf
 * config the checkout already has; a private repo reached by URL alone may
 * have no way to authenticate.
 *
 * @param {Ctx} ctx
 * @param {string} root
 * @param {string} url the marketplace entry's `source.url`
 * @returns {string}
 */
function remoteFor(ctx, root, url) {
	let listed;
	try {
		listed = git(root, ["remote", "-v"]);
	} catch (e) {
		/* A repo with no remotes exits 0 and says nothing, so a THROW here is git
		 * failing to enumerate at all — apparatus either way, and BROKEN rather
		 * than a silent fall-through to the URL, which would report a private
		 * repo as unreachable and look like a real fault. */
		ctx.broken(`cannot list this repo's remotes — ${gitReason(e)}`);
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
 * The remote to query for `name`'s pin — `--remote` first, else whatever
 * configured remote's fetch URL matches the marketplace entry's — or BROKEN
 * where the entry gives nothing to resolve one from.
 *
 * @param {Ctx} ctx
 * @param {string} root
 * @param {string} name
 * @param {{url?: string}} source
 * @returns {string}
 */
function requiredRemote(ctx, root, name, source) {
	const remote =
		ctx.value("--remote") ?? remoteFor(ctx, root, source.url ?? "");
	if (!remote) {
		ctx.broken(
			`.claude-plugin/marketplace.json gives ${name} no \`source.url\` to query`,
		);
	}
	return remote;
}

/**
 * Whether `remote` publishes `tag`, or the reason the question could not be
 * put — which the caller turns into a SKIP, the remote being the subject.
 *
 * @param {Ctx} ctx
 * @param {string} root
 * @param {string} remote a remote name or a URL, as git itself accepts either
 * @param {string} tag
 * @returns {{ present: boolean } | { unreachable: string }}
 */
function tagOnRemote(ctx, root, remote, tag) {
	try {
		const out = git(root, ["ls-remote", "--tags", remote, `refs/tags/${tag}`], {
			timeout: LS_REMOTE_TIMEOUT_MS,
			/* Never sit on a credential prompt: this runs unattended inside
			 * `npm run status`, where a prompt is indistinguishable from a hang. */
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		});
		return { present: out.trim() !== "" };
	} catch (e) {
		if (isApparatusFailure(e))
			ctx.broken(`cannot run git to reach ${remote} — ${gitReason(e)}`);
		return { unreachable: gitReason(e) };
	}
}

/**
 * The highest `v<semver>` tag `remote` publishes, or the reason the question
 * could not be put — which the caller turns into a SKIP, the remote being the
 * subject. `null` where the remote is reachable but has cut no release tag
 * yet, which is not itself a fault.
 *
 * @param {Ctx} ctx
 * @param {string} root
 * @param {string} remote a remote name or a URL, as git itself accepts either
 * @returns {{ tag: string|null } | { unreachable: string }}
 */
function newestCutTagOnRemote(ctx, root, remote) {
	try {
		const out = git(root, ["ls-remote", "--tags", remote, "refs/tags/v*"], {
			timeout: LS_REMOTE_TIMEOUT_MS,
			/* Never sit on a credential prompt: this runs unattended inside
			 * `npm run status`, where a prompt is indistinguishable from a hang. */
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		});
		const tags = out
			.split("\n")
			.flatMap((line) => {
				const ref = line.split("\t")[1];
				return ref ? [ref.replace(/^refs\/tags\//, "")] : [];
			})
			// Excludes an annotated tag's dereferenced `^{}` line along with anything
			// else ls-remote's glob let through that is not a release tag.
			.filter((t) => TAG_RE.test(t));
		if (tags.length === 0) return { tag: null };
		return {
			tag:
				tags
					.sort((a, b) => (semverGt(tagVersion(a), tagVersion(b)) ? 1 : -1))
					.at(-1) ?? null,
		};
	} catch (e) {
		if (isApparatusFailure(e))
			ctx.broken(`cannot run git to reach ${remote} — ${gitReason(e)}`);
		return { unreachable: gitReason(e) };
	}
}

/**
 * An unreachable remote, reported as the CALLER asked for it.
 *
 * By default a SKIP: the remote is this checker's subject, and lib/check.js's
 * alphabet keeps an unavailable subject off the gate.
 *
 * `--require-remote` says the reach itself is what this run was checking, so
 * the same condition gates instead (#263). The sweep passes it: there a SKIP
 * exits 0, the job stays green, and nothing is printed anywhere a session
 * reads — so a credential or URL-match regression would reproduce #257's own
 * harm, a pin no adopter can fetch with nothing saying so. A FAIL reddens the
 * job, which `check-ci-status.js --notify` reports at the next session start;
 * a WARN would not, nothing here reading a green run's annotations.
 *
 * THE PRICE IS A FALSE RED on a transient outage, accepted at #263 against
 * ~1460 sweeps a year. Never make this the default: it would gate `npm run
 * status` on the reader's own network.
 *
 * @param {Ctx} ctx
 * @param {string} remote
 * @param {string} reason what git said, from gitReason()
 * @param {{ skipLines: string, failLine: string }} prose `skipLines` is the
 *   SKIP's prose, already indented for its line; `failLine` the FAIL finding's
 *   one-line summary
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
		/* Never `false`: an unenumerable tag list would become a TAG-UNCUT that
		 * reads as a real release fault, and the tag set is this checker's own
		 * reading apparatus rather than its subject. */
		ctx.broken(`cannot list this repo's tags — ${gitReason(e)}`);
	}
}

/**
 * Whether `hasLocalTag` can be trusted to tell "cut here, not pushed" apart
 * from "cut nowhere". `GITHUB_ACTIONS` is GitHub's own env var, set `"true"`
 * on every Actions runner: `actions/checkout@v4` populates a runner's local
 * tags FROM the remote it just fetched, so a tag absent from the remote is
 * by construction absent locally too there (#264).
 *
 * @returns {boolean}
 */
function hasTrustworthyLocalTags() {
	return process.env.GITHUB_ACTIONS !== "true";
}

/** The remedy where a tag's local absence cannot be trusted to mean uncut. */
const unresolvedTagRemedy = (
	/** @type {string} */ remote,
	/** @type {string} */ tag,
	/** @type {string} */ cutInstruction = "  node scripts/release-plugin.js",
) =>
	`  # if ${tag} was already cut, just not pushed:\n` +
	`  git push ${remote} ${tag}\n` +
	"  # otherwise, cut it first:\n" +
	cutInstruction;

/**
 * A JSON file under the plugin root, BROKEN where unreadable.
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
 * The marketplace lists no entry for this plugin.
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
 * The marketplace pins a ref other than `v<version>`.
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
 * What to run for a version ahead of every cut tag on a non-tag pin.
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
 * A branch- or SHA-pinned entry, judged against the newest tag the remote has
 * cut (#261): resolvability is not this checker's question there.
 * @param {Ctx} ctx
 * @param {{ root: string, name: string, version: string, source: {url?: string}, ref: string }} pin
 */
function judgeNonTagPin(ctx, { root, name, version, source, ref }) {
	const expected = `v${version}`;
	if (!VERSION_RE.test(version))
		ctx.broken(
			`.claude-plugin/plugin.json's version \`${version}\` is not X.Y.Z, so it cannot be compared against a cut tag`,
		);

	const remote = requiredRemote(ctx, root, name, source);

	const newest = newestCutTagOnRemote(ctx, root, remote);
	if ("unreachable" in newest) {
		return remoteUnreachable(ctx, remote, newest.unreachable, {
			skipLines:
				`${name} is pinned to \`${ref}\`, which is not a release tag, and ${remote}\n` +
				`      could not be reached to find the newest cut tag against — ${newest.unreachable}.`,
			failLine: `${remote} could not be reached to find the newest cut tag ${name}'s \`${ref}\` pin should be judged against`,
		});
	}

	if (newest.tag !== null && semverGt(version, tagVersion(newest.tag))) {
		ctx.fail(
			"VERSION-AHEAD",
			`plugin.json says ${version}, ahead of ${newest.tag}, the newest tag ${remote} has, but ${name} is pinned to \`${ref}\`, not a tag`,
			{ ref, version, newest: newest.tag },
			`version-ahead:${name}`,
		);
		/* release-plugin.js's own `release()` refuses to cut unless the
		 * marketplace ref ALREADY reads `expected` (its `pins ... not ...`
		 * check), so "just run release-plugin.js" is no remedy while `ref`
		 * is a branch or SHA — the ref has to move first. */
		const pointRefFirst =
			`  # point the ref at ${expected}, commit, then:\n` +
			"  node scripts/release-plugin.js";
		const remedy = aheadRemedy(ctx, { root, remote, expected, pointRefFirst });
		ctx.say(
			`.claude-plugin/plugin.json says ${version}, ahead of ${newest.tag}, the\n` +
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
 * A tag-pinned entry whose tag the remote lacks: unresolved, unpushed or
 * never cut.
 * @param {Ctx} ctx
 * @param {{ root: string, remote: string, ref: string }} pin
 */
function judgeUnpublishedTag(ctx, { root, remote, ref }) {
	if (!hasTrustworthyLocalTags()) {
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

	if (hasLocalTag(ctx, root, ref)) {
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
			"  node scripts/release-plugin.js\n" +
			`  git push ${remote} ${ref}`,
	);
	return { noun: "pinned tag that was never cut" };
}

runCheck({
	name: "release-pin",
	usage:
		"node check-release-pin.js [--warn] [--remote <name-or-url>] [--require-remote]",
	valueFlags: ["--remote"],
	flags: ["--require-remote"],
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

		/* Ahead of the mismatch check, not after it: a marketplace pinned to a
		 * branch or a SHA is a deliberate choice this checker has no subject in,
		 * and it can never equal `v<version>`, so judging the mismatch first
		 * would report every one of them as a fault. An ABSENT ref still falls
		 * through to the mismatch, that being a broken entry rather than a
		 * different pinning scheme.
		 *
		 * #257's second limb — a `plugin.json` version ahead of the newest cut
		 * tag — reaches a tag-pinned entry by composition, through PIN-MISMATCH
		 * and the two resolvability faults below. A branch- or SHA-pinned entry
		 * reaches nothing by composition, so it is judged here instead, against
		 * whatever the remote has actually cut (#261). */
		if (ref !== undefined && !TAG_RE.test(ref))
			return judgeNonTagPin(ctx, { root, name, version, source, ref });

		if (ref !== expected)
			return failPinMismatch(ctx, { name, ref, version, expected });

		const remote = requiredRemote(ctx, root, name, source);

		const onRemote = tagOnRemote(ctx, root, remote, ref);

		if ("unreachable" in onRemote) {
			/* SKIP or a finding, per remoteUnreachable(). The local tag set answers
			 * a different question either way and is deliberately not offered as a
			 * consolation reading — #257's failure was a tag that existed locally. */
			return remoteUnreachable(ctx, remote, onRemote.unreachable, {
				skipLines:
					`could not reach ${remote} to check that ${ref} is published — ${onRemote.unreachable}.\n` +
					"      An adopter fetches from the remote, so this run proves nothing about\n" +
					"      what adopters can install. Re-run with the network up.",
				failLine: `${remote} could not be reached to check that ${ref} is published`,
			});
		}

		if (onRemote.present) {
			return {
				okLine: `${name} pins ${ref}, and ${remote} has it`,
			};
		}

		return judgeUnpublishedTag(ctx, { root, remote, ref });
	},
});
