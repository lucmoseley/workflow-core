#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { readTrackedScripts } = require("./lib/tracked-scripts.js");
const { isJsTestFile } = require("./lib/test-kind.js");

const { runCheck, errMessage } = require("./lib/check.js");
const { exemptMarker } = require("./lib/exempt-markers.js");
const { escapeRe, requiredGroup } = require("./lib/regex-group.js");

const EXEMPT = exemptMarker("git-identity");

const QUOTE = `["'\`]`;
const REPO_VAR = "[A-Za-z_$][\\w.]*";

const VAR_CALL = new RegExp(
	`\\bgit\\w*\\(\\s*(${REPO_VAR})\\s*,\\s*(${QUOTE})(init|commit)\\2\\s*[,)]`,
);

const DEFAULT_CALL = new RegExp(
	`\\bgit\\w*\\(\\s*(${QUOTE})(init|commit)\\1\\s*[,)]`,
);

const INLINE_CONFIGS = `(?:${QUOTE}-c${QUOTE}\\s*,\\s*${QUOTE}[^"'\`]*${QUOTE}\\s*,\\s*)*`;
const EXEC_ARRAY_CALL = new RegExp(
	`\\b(?:execFileSync|execFile|spawnSync|spawn)\\(\\s*${QUOTE}git${QUOTE}\\s*,\\s*\\[\\s*` +
		INLINE_CONFIGS +
		`(?:${QUOTE}-C${QUOTE}\\s*,\\s*(${REPO_VAR})\\s*,\\s*)?` +
		INLINE_CONFIGS +
		`(${QUOTE})(init|commit)\\2([^\\]]*)`,
	"g",
);
const CWD_VAR = new RegExp(`\\bcwd:\\s*(${REPO_VAR})`);
const INIT_PATH_VAR = new RegExp(`,\\s*(${REPO_VAR})\\s*(?:,\\s*)?$`);

function statements(/** @type {string} */ text) {
	return text.replace(/\s+/g, " ").split(";");
}

function* callSites(/** @type {string} */ text) {
	for (const stmt of statements(text)) yield* statementCallSites(stmt);
}

function* statementCallSites(/** @type {string} */ stmt) {
	for (const m of stmt.matchAll(new RegExp(VAR_CALL.source, "g"))) {
		yield { key: m[1], verb: m[3] };
	}
	for (const m of stmt.matchAll(EXEC_ARRAY_CALL)) {
		const verb = requiredGroup(m, 3, EXEC_ARRAY_CALL);
		yield { key: m[1] ?? stmt.match(CWD_VAR)?.[1] ?? "__default__", verb };
		if (verb !== "init") continue;
		const initDir = requiredGroup(m, 4, EXEC_ARRAY_CALL).match(INIT_PATH_VAR);
		if (initDir?.[1]) yield { key: initDir[1], verb };
	}
	if (new RegExp(VAR_CALL.source, "g").test(stmt)) return;
	for (const m of stmt.matchAll(new RegExp(DEFAULT_CALL.source, "g"))) {
		yield { key: "__default__", verb: m[2] };
	}
}

function hasKeyedTokenEvidence(
	/** @type {string} */ text,
	/** @type {string} */ key,
	/** @type {RegExp} */ token,
) {
	if (key === "__default__") return token.test(text);
	const re = new RegExp(`\\b${escapeRe(key)}\\b`);
	return statements(text).some((stmt) => re.test(stmt) && token.test(stmt));
}

const EMAIL_TOKEN = /user\.email/;
const NAME_TOKEN = /user\.name/;

function hasKeyedIdentityEvidence(
	/** @type {string} */ text,
	/** @type {string} */ key,
) {
	return (
		hasKeyedTokenEvidence(text, key, EMAIL_TOKEN) &&
		hasKeyedTokenEvidence(text, key, NAME_TOKEN)
	);
}

function pairedRepos(/** @type {string} */ text) {
	const inited = new Set();
	const committed = new Set();
	for (const { key, verb } of callSites(text)) {
		if (verb === "init") inited.add(key);
		else committed.add(key);
	}
	const clean = /** @type {string[]} */ ([]);
	const bare = /** @type {string[]} */ ([]);
	for (const key of inited) {
		if (!committed.has(key)) continue;
		(hasKeyedIdentityEvidence(text, key) ? clean : bare).push(key);
	}
	return { clean: clean.sort(), bare: bare.sort() };
}

/** @type {import("./lib/check").CheckSpec} */
const SPEC = {
	name: "git-fixture-identity",
	usage:
		"node check-git-fixture-identity.js [--json] [--warn] [--root <dir>] [--against <rev>]",
	valueFlags: ["--root"],
	against: { profile: "git-fixture-identity", materialise: "tree" },
	run(/** @type {any} */ ctx) {
		const { root, files } = readTrackedScripts(ctx, isJsTestFile);
		const checked = /** @type {string[]} */ ([]);
		const exempt = /** @type {string[]} */ ([]);

		for (const rel of files) {
			let source = "";
			try {
				source = fs.readFileSync(path.join(root, rel), "utf8");
			} catch (e) {
				return ctx.broken(
					`could not read the tracked file ${rel}: ${errMessage(e)}.`,
				);
			}
			const { clean, bare } = pairedRepos(source);
			if (clean.length === 0 && bare.length === 0) continue;
			checked.push(rel);
			if (bare.length === 0) continue;
			if (EXEMPT.test(source)) {
				exempt.push(rel);
				continue;
			}
			const findings = bare;

			ctx.fail(
				"GIT-FIXTURE-IDENTITY",
				`${rel} inits and commits a raw git repo (${findings.join(", ")}) with no identity set for it, so it fails on a runner with no global user.email/user.name (mantahostels#2310's shape, mantahostels#2355).`,
				{ file: rel, repos: findings },
			);
			ctx.say(
				`${rel} inits and commits ${findings.join(", ")} with no identity.`,
			);
			ctx.say(
				"  A developer machine carries a global git identity and never sees this fail; a runner with none fails every commit into that repo.",
			);
			ctx.say(
				'  Fix: after `git(<repo>, "init", ...)`, add `git(<repo>, "config", "user.email", "test@example.com")` and `git(<repo>, "config", "user.name", "test")` — the shape scripts/lib/git-fixture.ts\'s initGitRepo and every sibling fixture already use.',
			);
			ctx.say(
				"  Genuinely need no identity? Record why on an issue and put `git-identity-exempt: #N` in a comment naming it; this check drops the file.",
			);
		}

		const data = {
			rawFixtureTests: checked.length,
			exempt: exempt.length,
			scanned: files.length,
		};
		const tail =
			exempt.length > 0
				? `${exempt.length} exempt, the rest carrying an identity.`
				: "all carrying an identity.";
		return {
			okLine: `${checked.length} of ${files.length} scripts/ test files raw-init and raw-commit a git repo — ${tail}`,
			noun: "identity-less git fixture",
			data,
		};
	},
};

module.exports = { SPEC };
if (require.main === module) runCheck(SPEC);
