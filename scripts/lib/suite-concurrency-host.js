const { readAvailableMb, readTotalMb } = require("./meminfo.js");
const { readWindowsMemory } = require("./windows-memory.js");
const { treePorts } = require("./guard-host-ports.js");
const { buildIsWrapperScript } = require("./suite-launch.js");
const { readCarriedWeightOf, readPs } = require("./suite-ladder.js");
const { ignoreFailure } = require("./caught.js");

/**
 * @param {string} root
 * @param {(what: string) => void} log
 * @returns {() => string[]}
 */
function buildRunners(root, log) {
	const { readConfig } = require("./workflow-core-config.js");
	return () => {
		try {
			return readConfig({ root, quiet: true }).suiteRunners ?? [];
		} catch {
			log("workflow-core.json unreadable — no declared suite runner counted");
			return [];
		}
	};
}

/**
 * @param {{ root: string, log: (m: string) => void }} env
 * @returns {import("./suite-launch.js").LaunchPorts}
 */
function buildLaunchPorts({ root, log }) {
	return {
		runners: buildRunners(root, log),
		isWrapperScript: buildIsWrapperScript(() => treePorts(root), log),
	};
}

/**
 * @param {string} root
 * @param {(what: string, detail?: string) => void} log
 * @returns {Omit<import("./suite-concurrency.js").SuitePorts, "climbMb" | "gateSeats">}
 */
function buildHostPorts(root, log) {
	const { readCommandFor, readConfig } = require("./workflow-core-config.js");
	return {
		tscLaunchPeakMb: (dir, bin) =>
			require("./tsc-slot.js").launchPeakMb(dir, { bin }),
		availableMb: () => {
			const read = readAvailableMb();
			return read.ok ? read.mb : null;
		},
		totalMb: readTotalMb,
		windowsMemory: () => readWindowsMemory(),
		psRows: () => {
			const ps = readPs();
			return ps.ok ? ps.rows : null;
		},
		carriedOf: readCarriedWeightOf,
		partPeak: (run) =>
			require("./part-suite-ledger.js").readPartSuitePeak(run, { root }),
		tripwire: () => require("./peak-tripwire.js").gateTripwire({ log }),
		runners: buildRunners(root, log),
		declaredTest: () => {
			try {
				return readCommandFor("test", { root });
			} catch {
				log("workflow-core.json unreadable — no declared test command read");
				return null;
			}
		},
		testProven: (tree) => {
			try {
				const { commands, testCanary } = readConfig({ root, quiet: true });
				const { proofState } = require("./verdict-probe.js");
				const { markersDir } = require("./marker-root.js");
				return (
					proofState({
						root: tree,
						command: commands.test,
						canary: testCanary,
						markers: markersDir(root),
					}).state === "fresh"
				);
			} catch {
				log("verdict proof unreadable — commands.test read as unproven");
				return false;
			}
		},
		fullLaunchPlain: (argv, tree) =>
			require("./full-launch-plain.js").readFullLaunchPlain(argv, tree),
	};
}

/**
 * @param {string} command
 * @param {string | undefined} root
 * @param {{ weight?: import("./suite-handoff.js").CarriedWeight | null, climbMb?: number, allClimbMb: () => number, gateSeats: () => import("./suite-ladder.js").GateSeats, onAdmission?: (admission: import("./part-suite-peak.js").PartAdmission) => void }} reads
 * @returns {import("./suite-queue.js").GateDenial | null}
 */
function readGate(
	command,
	root,
	{ weight = null, climbMb = 0, allClimbMb, gateSeats, onAdmission },
) {
	const { guardDisabled, hostRoot } = require("./workflow-core-config.js");
	const host = root ?? hostRoot();
	if (guardDisabled("guard-suite-concurrency", { root: host })) return null;
	const { logError } = require("./arbiter-core.js");
	/** @param {string} what @param {string} [detail] */
	const log = (what, detail) =>
		ignoreFailure(() => logError("guard-suite-concurrency", what, detail));
	const { decide } = require("./suite-concurrency.js");
	const { kitContext, sharedReaders } = require("./kit-context.js");
	const env = { root: host, payload: { cwd: host }, log };
	const ctx = kitContext(env, sharedReaders(host, log));
	const verdict = decide(command, {
		...ctx,
		told: () => true,
		readLatch: () => "",
		...treePorts(host),
		...buildHostPorts(host, log),
		climbMb: (scope) => (scope === "all" ? allClimbMb() : climbMb),
		gateSeats,
		launchWeight: weight,
		...(onAdmission ? { noteAdmission: onAdmission } : {}),
		tree: () =>
			treePorts(root ?? require("./host-root.js").sessionTree({}) ?? host),
		fullLaunchPlain: () => ({ plain: false }),
	});
	if (!verdict || !("deny" in verdict)) return null;
	return "gate" in verdict ? verdict.gate : { limb: "count" };
}

module.exports = {
	buildHostPorts,
	buildLaunchPorts,
	readGate,
};
