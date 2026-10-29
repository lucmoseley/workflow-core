/*
 * suite-concurrency-host.js — the production ports of the
 * guard-suite-concurrency core, lib/suite-concurrency.js (#3227), the climb
 * apart (lib/suite-concurrency-hook-host.js adds the hook's), and the queue's
 * in-process read of the same gate (lib/suite-queue.js's gateDenies).
 *
 * THE SEAMS. WFC_MEMINFO and WFC_PS stand in for /proc/meminfo and `ps`.
 *
 * Every read fails open (mantahostels#103 §6): a config, command or rule it
 * cannot read reads as none (#2795).
 */

const fs = require("node:fs");
const path = require("node:path");
const { markersDir } = require("./marker-root.js");
const { readAvailableMb } = require("./meminfo.js");
const { hasWrapperCall } = require("./suite-launch.js");
const { STANDDOWN_LOG } = require("./suite-concurrency.js");
const { readCarriedWeightOf, readPs } = require("./suite-ladder.js");

/**
 * gl_when's timestamp: whole seconds, UTC.
 * @returns {string}
 */
const now = () => `${new Date().toISOString().slice(0, 19)}.000Z`;

/**
 * @param {{ root: string, log: (what: string, detail?: string) => void }} env
 * @returns {(script: string) => boolean}
 */
function buildIsWrapperScript({ root, log }) {
	/** @type {Record<string, unknown> | null | undefined} */
	let scripts;
	return (script) => {
		if (scripts === undefined) {
			const pkg = path.join(root, "package.json");
			try {
				scripts = fs.existsSync(pkg)
					? (JSON.parse(fs.readFileSync(pkg, "utf8"))?.scripts ?? {})
					: null;
			} catch {
				log(
					`package.json unreadable — \`--queue\` offered without knowing whether \`${script}\` runs run-vitest.js`,
				);
				scripts = null;
			}
		}
		if (!scripts) return true;
		const body = scripts[script];
		return hasWrapperCall(typeof body === "string" ? body : null);
	};
}

/**
 * The host's declared runners and npm scripts, the two ports
 * lib/suite-launch.js reads.
 * @param {{ root: string, log: (m: string) => void }} env
 * @returns {import("./suite-launch.js").LaunchPorts}
 */
function buildLaunchPorts({ root, log }) {
	const { readConfig } = require("./workflow-core-config.js");
	return {
		runners: () => {
			try {
				return readConfig({ root, quiet: true }).suiteRunners ?? [];
			} catch {
				log("workflow-core.json unreadable — no declared suite runner counted");
				return [];
			}
		},
		isWrapperScript: buildIsWrapperScript({ root, log }),
	};
}

/**
 * @param {string} root
 * @param {(what: string, detail?: string) => void} log
 * @returns {Omit<import("./suite-concurrency.js").SuitePorts, "climbMb">}
 *   every port but the climb, which each caller charges its own way
 */
function buildHostPorts(root, log) {
	const { readCommandFor } = require("./workflow-core-config.js");
	return {
		availableMb: () => {
			const read = readAvailableMb();
			return read.ok ? read.mb : null;
		},
		psRows: () => {
			const ps = readPs();
			return ps.ok ? ps.rows : null;
		},
		carriedOf: readCarriedWeightOf,
		...buildLaunchPorts({ root, log }),
		declaredTest: () => {
			try {
				return readCommandFor("test", { root });
			} catch {
				log("workflow-core.json unreadable — no declared test command read");
				return null;
			}
		},
		appendStanddown: (line) => {
			try {
				fs.appendFileSync(
					path.join(markersDir(root), STANDDOWN_LOG),
					`${line}\n`,
				);
				return true;
			} catch {
				return false;
			}
		},
		now,
		/* Required at the call: full-launch-plain.js requires run-vitest.js,
		 * which requires the queue, which requires this file. */
		fullLaunchPlain: (argv) =>
			require("./full-launch-plain.js").readFullLaunchPlain(argv),
	};
}

/**
 * The gate's reading of `command` for the queue's poll (mantahostels#2024):
 * the limb the guard would refuse it on, or null where it would not. The
 * escape is cleared, or an exporting shell would stand the gate down and every
 * poll answer "open"; the session's latches are neither read nor spent. A
 * disabled guard reads open. `weight` is the launch's carried admission
 * weight (#2931), which the gate charges in place of its words' file count.
 * `climbMb` is what the type-check slot's launches have yet to draw (#3416).
 * @param {string} command
 * @param {string} [root]
 * @param {import("./suite-handoff.js").CarriedWeight | null} [weight]
 * @param {number} [climbMb]
 * @returns {import("./suite-queue.js").GateDenial | null}
 */
function readGate(command, root, weight = null, climbMb = 0) {
	const { guardDisabled, hostRoot } = require("./workflow-core-config.js");
	const host = root ?? hostRoot();
	if (guardDisabled("guard-suite-concurrency", { root: host })) return null;
	const { logError } = require("./arbiter-core.js");
	/** @param {string} what @param {string} [detail] */
	const log = (what, detail) => {
		try {
			logError("guard-suite-concurrency", what, detail);
		} catch {
			/* A log that cannot be written must not break the poll. */
		}
	};
	const { decide } = require("./suite-concurrency.js");
	const { kitContext, sharedReaders } = require("./kit-context.js");
	const env = { root: host, payload: { cwd: host }, log };
	const ctx = kitContext(env, sharedReaders(host, log));
	const { WFC_SUITE_CONCURRENT: _escape, ...vars } = ctx.vars;
	const verdict = decide(command, {
		...ctx,
		vars,
		told: () => true,
		readLatch: () => "",
		session: "",
		...buildHostPorts(host, log),
		climbMb: () => climbMb,
		launchWeight: weight,
		/* Never asked: `told` answers yes, so the limb is never weighed. */
		fullLaunchPlain: () => ({ plain: false }),
	});
	if (!verdict || !("deny" in verdict)) return null;
	return "gate" in verdict ? verdict.gate : { limb: "count" };
}

module.exports = {
	buildHostPorts,
	buildLaunchPorts,
	readGate,
	buildIsWrapperScript,
};
