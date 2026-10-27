#!/usr/bin/env node
/*
 * check-registrations.js — a repo's own hooks, guards and checkers are each
 * registered: pinned, wired or allowlisted, tested, and counted (#1456).
 *
 * Usage:
 *   node check-registrations.js [--root <dir>] [--against <rev>] [--json] [--warn]
 *
 * The host-side form of the core's three whole-repo tests, for a repo with no
 * test runner to carry them (`lib/registrations.js` has the predicates):
 *
 *   hooks     every hook the repo registers itself (lib/core-hooks.js
 *             `ownHooks`: an adopter's .claude/settings.json) has exactly one `hooks`
 *             row in .claude/registrations.json, matching its matcher, covers
 *             and timeout; every scripts/guard-*.{sh,js} is run by a hook or
 *             keyed in `registeredElsewhere`, and has a sibling test
 *   checkers  every scripts/check-*.js is called by a husky hook, a workflow,
 *             a registered hook or another script, or keyed in `calledElsewhere`,
 *             and has a sibling test
 *   needles   every script a registered hook runs has an entry in
 *             .claude/guard-fire-needles.json or the plugin's own, and the host
 *             file keys nothing the registration does not run
 *
 * Members are the core's: a `scripts/check-*.py` is no checker here, though a
 * `.test.py` counts as a sibling test.
 *
 * The core (lib/core-hooks.js `isCoreRoot`) holds all three in its own tests,
 * and is judged on one thing instead (#2447, spec #2295):
 *
 *   settings  .claude/settings.json registers the self-plugin canary
 *             (lib/core-hooks.js `CANARY_COMMAND`) and no other hook, and no
 *             command registers in both it and self-plugin/hooks/hooks.json
 *
 * Run bare, it lists every unregistered member — the migration step's listing.
 * `.husky/pre-commit` runs it under `--against HEAD`, so only a fault the
 * commit adds refuses.
 * An absent registry reads as empty, with its own finding, which is inherited
 * on every commit until the file lands.
 *
 * IMPLICIT:  on every commit staging the repo's hook registration, either host registry, scripts/, .husky/ or a workflow, refuses one that leaves a hook, guard or checker of this repo's own unregistered, untested or uncounted, naming the file to edit; in the core, one that registers a settings hook besides the canary or a command in both settings and the self-plugin.
 * JUSTIFIED: fail-safe — an unwired guard enforces nothing and an uncounted one reads as never firing, both silently; the fix is one registry entry. A guard registered in both files fires twice, doubling a deny or a counter.
 * DEFEAT:    --warn caps findings below the gating line; a caller that only mentions a checker on a line sharing code counts as a call.
 */

const fs = require("node:fs");
const path = require("node:path");
const { hostRoot } = require("./lib/host-root.js");
const { guardKeys } = require("./lib/guard-fires.js");
const { JS_TEST_FILE } = require("./lib/test-kind.js");
const {
	CANARY_COMMAND,
	HOST_SETTINGS,
	SELF_PLUGIN_HOOKS,
	flattenHooks,
	isCoreRoot,
	readOwnHookSources,
	readOwnHooks,
	ownHooksFile,
} = require("./lib/core-hooks.js");
const R = require("./lib/registrations.js");

/** @typedef {import("./lib/check").CheckContext} Ctx */
const { runCheck } = require("./lib/check");

/** The plugin's own needles, which key every core guard a host may register. */
const CORE_NEEDLES = path.join(__dirname, "guard-fire-needles.json");

/**
 * The parsed JSON at `rel`, null where absent; a parse failure is BROKEN.
 * @param {Ctx} ctx
 * @param {string} root
 * @param {string} rel
 * @returns {any}  each caller narrows its shape
 */
function readJson(ctx, root, rel) {
	const at = path.join(root, rel);
	if (!fs.existsSync(at)) return null;
	try {
		return JSON.parse(fs.readFileSync(at, "utf8"));
	} catch (e) {
		return ctx.broken(
			`${rel} does not parse as JSON (${e instanceof Error ? e.message : String(e)}) — nothing was judged`,
		);
	}
}

/**
 * Basenames under scripts/ matching `re`, test files left out: an adopter's
 * `check-x.test.js` or `check-x.spec.js` is no checker.
 * @param {string} root
 * @param {RegExp} re
 */
function readScriptsMatching(root, re) {
	const dir = path.join(root, "scripts");
	return fs.existsSync(dir)
		? fs
				.readdirSync(dir)
				.filter((f) => re.test(f) && !JS_TEST_FILE.test(f))
				.sort()
		: [];
}

/**
 * The four surfaces that run a checker unasked, by repo-relative path.
 * @param {string} root
 * @returns {Record<string, string>}
 */
function readCallerSources(root) {
	/** @param {string} sub @param {RegExp} re */
	const readMatchingEntries = (sub, re) =>
		fs.existsSync(path.join(root, sub))
			? fs
					.readdirSync(path.join(root, sub))
					.filter((f) => re.test(f))
					.map((f) => `${sub}/${f}`)
			: [];
	const rels = [
		...R.CALLER_HOOKS.map((h) => `.husky/${h}`),
		ownHooksFile(root),
		...readMatchingEntries(".github/workflows", /\.ya?ml$/),
		...readMatchingEntries("scripts", /\.(js|sh)$/),
		...readMatchingEntries("scripts/lib", /\.(js|sh)$/),
	];
	/** @type {Record<string, string>} */
	const out = {};
	for (const rel of rels) {
		const at = path.join(root, rel);
		if (fs.existsSync(at) && fs.statSync(at).isFile())
			out[rel] = fs.readFileSync(at, "utf8");
	}
	return out;
}

/**
 * The pathspecs a materialised side needs: at the core its two hook files
 * alone, so it never copies its whole scripts/.
 * @param {string} rev
 * @returns {string[]}
 */
function pathspecs(rev) {
	if (isCoreRoot(hostRoot(), { rev }))
		return [HOST_SETTINGS, SELF_PLUGIN_HOOKS];
	return [
		HOST_SETTINGS,
		R.HOST_REGISTRATIONS,
		R.HOST_NEEDLES,
		"scripts",
		".husky",
		".github/workflows",
	];
}

/**
 * @param {Ctx} ctx
 * @param {string} tag
 * @param {R.Fault[]} faults
 */
function report(ctx, tag, faults) {
	for (const { key, message } of faults) {
		ctx.fail(tag, message, {}, key);
		ctx.say(`  ${message}`);
	}
}

/**
 * The host registry, reporting its absence and any key left without a reason;
 * a wrong shape is BROKEN.
 * @param {Ctx} ctx
 * @param {string} root
 * @returns {R.Registry}
 */
function readHostRegistry(ctx, root) {
	/** @type {R.Registry} */
	let registry = { hooks: [], registeredElsewhere: {}, calledElsewhere: {} };
	const json = readJson(ctx, root, R.HOST_REGISTRATIONS);
	if (json === null)
		report(ctx, "REGISTRY-ABSENT", [
			{
				key: R.HOST_REGISTRATIONS,
				message: `${R.HOST_REGISTRATIONS} is absent, so every hook, guard and checker below is unregistered — \`upgrade\` seeds it empty, or write {"hooks": [], "registeredElsewhere": {}, "calledElsewhere": {}}`,
			},
		]);
	else {
		const shape = R.shapeFaults(json);
		if (shape.length > 0)
			ctx.broken(
				`${R.HOST_REGISTRATIONS} ${shape.join("; ")} — nothing was judged`,
			);
		registry = json;
	}
	const blank = [
		...R.unexplained(registry.registeredElsewhere),
		...R.unexplained(registry.calledElsewhere),
	];
	report(
		ctx,
		"ELSEWHERE-UNCOMMENTED",
		blank.map((file) => ({
			key: `uncommented ${file}`,
			message: `${R.HOST_REGISTRATIONS} keys ${file} with no reason — say why nothing runs it`,
		})),
	);
	return registry;
}

/**
 * A registered hook keyed in neither needles file, and a host key no hook runs.
 * @param {Ctx} ctx
 * @param {string} root
 * @param {{hooks: object}} registered  the repo's own hooks, settings-shaped
 * @returns {R.Fault[]}
 */
function needleFaults(ctx, root, registered) {
	const host = readJson(ctx, root, R.HOST_NEEDLES)?.guards ?? {};
	const core = JSON.parse(fs.readFileSync(CORE_NEEDLES, "utf8")).guards;
	const keys = guardKeys(registered);
	const file = ownHooksFile(root);
	return [
		...keys
			.filter((k) => !Object.hasOwn(host, k) && !Object.hasOwn(core, k))
			.map((k) => ({
				key: `unkeyed ${k}`,
				message: `${k} is run by a ${file} hook and has no entry in ${R.HOST_NEEDLES}, so count-guard-fires.js counts it as nothing — key the text it prints`,
			})),
		...Object.keys(host)
			.filter((k) => !keys.includes(k))
			.map((k) => ({
				key: `stale ${k}`,
				message: `${R.HOST_NEEDLES} keys ${k}, which no ${file} hook runs — remove the entry, or register the hook`,
			})),
	];
}

/**
 * The core's settings hooks other than the one canary, the canary's absence,
 * and the canary registered in the self-plugin too; any other command in both
 * files is already a settings hook besides the canary.
 * @param {Ctx} ctx
 * @param {string} root
 * @returns {R.Fault[]}
 */
function settingsFaults(ctx, root) {
	/** @type {import("./lib/core-hooks.js").HookEntry[]} */
	let settings;
	/** @type {import("./lib/core-hooks.js").HookEntry[]} */
	let self;
	try {
		const sources = readOwnHookSources(root);
		/** @param {string} rel */
		const of = (rel) => {
			const source = sources.find(({ file }) => file === path.join(root, rel));
			if (!source) throw new Error(`the shared reader returned no ${rel}`);
			return flattenHooks(source.settings?.hooks ?? {});
		};
		settings = of(HOST_SETTINGS);
		self = of(SELF_PLUGIN_HOOKS);
	} catch (e) {
		return ctx.broken(
			`${e instanceof Error ? e.message : String(e)} — nothing was judged`,
		);
	}
	const isCanary = (/** @type {import("./lib/core-hooks.js").HookEntry} */ h) =>
		h.event === "PreToolUse" &&
		h.matcher === undefined &&
		h.command === CANARY_COMMAND;
	/** @type {R.Fault[]} */
	const faults = settings
		.filter((h) => !isCanary(h))
		.map((h) => ({
			key: `settings-hook ${h.event} ${h.command}`,
			message: `${HOST_SETTINGS} registers ${h.event} \`${h.command}\`, but it keeps only the self-plugin canary — register the hook in ${SELF_PLUGIN_HOOKS} and remove it from ${HOST_SETTINGS}`,
		}));
	if (!settings.some(isCanary))
		faults.push({
			key: "canary-absent",
			message: `${HOST_SETTINGS} has no PreToolUse hook, with no matcher, running \`${CANARY_COMMAND}\`, so a session the self-plugin did not load runs with no guards and nothing said — restore it`,
		});
	if (self.some((h) => h.command === CANARY_COMMAND))
		faults.push({
			key: "canary-in-self-plugin",
			message: `${SELF_PLUGIN_HOOKS} registers the canary \`${CANARY_COMMAND}\` too, so it runs twice on every tool call — keep it in ${HOST_SETTINGS} alone`,
		});
	return faults;
}

runCheck({
	name: "registrations",
	usage:
		"node check-registrations.js [--root <dir>] [--against <rev>] [--json] [--warn]",
	valueFlags: ["--root"],
	against: {
		profile: "registrations",
		materialise: "blobs",
		pathspecs: (_ctx, rev) => pathspecs(rev),
	},
	run(/** @type {Ctx} */ ctx) {
		const root = path.resolve(ctx.value("--root") ?? hostRoot());
		if (!fs.existsSync(root))
			ctx.broken(`the host root ${root} does not exist — nothing was judged`);
		if (isCoreRoot(root)) {
			report(ctx, "SETTINGS", settingsFaults(ctx, root));
			return {
				okLine: `this repo holds its registries in its own tests (scripts/hook-registrations.test.ts, scripts/checker-registrations.test.ts, scripts/count-guard-fires.test.ts); ${HOST_SETTINGS} registers the self-plugin canary alone.`,
				noun: `${HOST_SETTINGS} fault(s) against the canary-only rule`,
				count: ctx.findings.length,
			};
		}

		const carried = (/** @type {string} */ rel) =>
			fs.existsSync(path.join(root, rel));

		let hooks;
		try {
			hooks = readOwnHooks(root) ?? {};
		} catch (e) {
			ctx.broken(
				`${e instanceof Error ? e.message : String(e)} — nothing was judged`,
			);
		}
		const registered = { hooks };
		const regs = R.allRegistrations(registered);
		const registry = readHostRegistry(ctx, root);

		const { unpinned, drifted } = R.hookFaults(registry.hooks, regs);
		report(ctx, "HOOK-UNPINNED", unpinned);
		report(ctx, "HOOK-ROW", drifted);
		report(
			ctx,
			"GUARD",
			R.guardFaults({
				guards: readScriptsMatching(root, /^guard-.+\.(sh|js)$/),
				regs,
				elsewhere: registry.registeredElsewhere,
				exists: carried,
			}),
		);
		report(
			ctx,
			"CHECKER",
			R.checkerFaults({
				checkers: readScriptsMatching(root, /^check-.+\.js$/),
				callers: readCallerSources(root),
				elsewhere: registry.calledElsewhere,
				exists: carried,
			}),
		);
		report(ctx, "NEEDLE", needleFaults(ctx, root, registered));

		return {
			okLine: "every hook, guard and checker of this repo's own is registered.",
			noun: `unregistered member(s) — ${R.HOST_REGISTRATIONS} and ${R.HOST_NEEDLES} are the files to edit`,
			count: ctx.findings.length,
		};
	},
});
