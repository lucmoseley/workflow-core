const fs = require("node:fs");
const path = require("node:path");

const { writeFd } = require("./write-fd.js");
const { pythonBin } = require("./python-bin.js");
const { TEST_PY_WORKERS } = require("./suite-launch.js");
const { spawnInRunScope, endRunScope } = require("./user-scope.js");
const {
	CEILING_CLOSE,
	SETTLE_MS,
	armCeiling,
	ceilingHeadline,
	ceilingMs,
	deadlineUnwritten,
	groupUnkilled,
	killGroup,
} = require("./suite-ceiling.js");
const { monotonicMs } = require("./clock.js");

const PLUGIN_DIR = path.join(__dirname, "..");

/* `-p` here rather than in pytest.ini's addopts, so a bare `pytest` run
 * writes no marker. */
const DEFAULT_ARGS = [
	"-n",
	String(TEST_PY_WORKERS),
	"-p",
	"pytest_pass_plugin",
];

const FORWARDED = /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"]);

/**
 * @param {string[]} argv
 * @param {string} root
 * @param {{ handOff: string|null, inflightFile: string|null,
 *   schedule?: Parameters<typeof armCeiling>[0]["schedule"] }} options
 * @returns {Promise<{ status: number|null, error: Error|null,
 *   forcedRed: boolean, ceilingKill: CeilingKill|null }>}
 */
function runPytest(argv, root, { handOff, inflightFile, schedule }) {
	const ceiling = ceilingMs();
	return new Promise((resolve) => {
		const child = spawnInRunScope(
			pythonBin(),
			["-m", "pytest", ...DEFAULT_ARGS, ...argv],
			{
				cwd: root,
				stdio: "inherit",
				detached: true,
				env: {
					...process.env,
					...(handOff ? { WFC_PYTEST_SCOPE_OUT: handOff } : {}),
					...(inflightFile ? { WFC_PYTEST_INFLIGHT_OUT: inflightFile } : {}),
					PYTHONPATH: [
						path.join(root, "scripts"),
						PLUGIN_DIR,
						process.env.PYTHONPATH,
					]
						.filter(Boolean)
						.join(path.delimiter),
				},
			},
		);
		const spawnedAtMono = monotonicMs();
		/** @type {CeilingKill|null} */
		let ceilingKill = null;
		const forward = (/** @type {NodeJS.Signals} */ signal) => {
			const unreached = child.pid ? killGroup(child.pid, signal) : null;
			if (unreached)
				writeFd(
					2,
					`${signal} could not be passed on to pytest's process group (${unreached}); it may run on.\n`,
				);
		};
		for (const signal of FORWARDED) process.on(signal, forward);

		/** @type {ReturnType<typeof setTimeout>|null} */
		let giveUp = null;
		const held = armCeiling({
			pgid: child.pid,
			ms: ceiling,
			now: spawnedAtMono,
			schedule,
			onCeiling: () => {
				const kill = {
					at: new Date().toISOString(),
					ceilingMs: ceiling,
					elapsedMs: monotonicMs() - spawnedAtMono,
					inflight: readInflight(inflightFile),
				};
				ceilingKill = kill;
				writeFd(
					2,
					buildCeilingReport(kill.inflight, {
						ceiling,
						elapsed: kill.elapsedMs,
					}),
				);
				const unkilled = child.pid ? killGroup(child.pid) : null;
				if (unkilled) writeFd(2, groupUnkilled("pytest", unkilled));
				giveUp = setTimeout(() => {
					child.unref();
					settle(null, null);
				}, SETTLE_MS);
				giveUp.unref?.();
			},
		});
		if (held.error) writeFd(2, deadlineUnwritten(held.error));

		let settled = false;
		/** @param {number|null} status @param {Error|null} error */
		const settle = (status, error) => {
			if (settled) return;
			settled = true;
			if (giveUp) clearTimeout(giveUp);
			held.release();
			for (const signal of FORWARDED) process.off(signal, forward);
			const capped = endRunScope(child);
			if (capped) writeFd(2, capped);
			resolve({
				status,
				error,
				forcedRed: ceilingKill !== null || capped !== null,
				ceilingKill,
			});
		};
		child.on("error", (error) => settle(null, error));
		child.on("close", (status) => settle(status, null));
	});
}

/**
 * @typedef {{ open: { nodeid: string, stage: string }[], finished: number,
 *   collected: number|null }} PytestInflight
 * @typedef {{ at: string, ceilingMs: number, elapsedMs: number,
 *   inflight: PytestInflight|null }} CeilingKill
 */

/**
 * @param {CeilingKill} kill
 * @param {{ sha: string, startedAtMs: number, argv: string[],
 *   sessionId: string|null, lander: boolean,
 *   touchedBase: import("./test-pass-marker.js").TouchedBase|null }} run
 * @returns {import("./test-pass-marker.js").KillRow}
 */
function ceilingKillRow(
	kill,
	{ sha, startedAtMs, argv, sessionId, lander, touchedBase },
) {
	const { inflight } = kill;
	return {
		sha,
		at: kill.at,
		suite: "pytest",
		startedAt: new Date(startedAtMs).toISOString(),
		durationMs: kill.elapsedMs,
		ceilingKill: true,
		ceilingMs: kill.ceilingMs,
		testsInFlight: inflight?.open ?? null,
		testsFinished: inflight?.finished ?? null,
		testsNeverStarted: inflight ? neverStartedCount(inflight) : null,
		argv,
		sessionId,
		...(lander ? { lander: true } : {}),
		...(touchedBase ? { touchedBase } : {}),
	};
}

/**
 * @param {PytestInflight} inflight
 * @returns {number|null}
 */
function neverStartedCount(inflight) {
	return inflight.collected === null
		? null
		: inflight.collected - inflight.finished - inflight.open.length;
}

/**
 * @param {string|null} file
 * @returns {PytestInflight|null}
 */
function readInflight(file) {
	if (!file) return null;
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		return Array.isArray(parsed.open) && Number.isInteger(parsed.finished)
			? parsed
			: null;
	} catch {
		return null;
	}
}

/**
 * @param {PytestInflight|null} inflight
 * @param {{ ceiling: number, elapsed: number }} run
 */
function buildCeilingReport(inflight, run) {
	const lines = ["", `${ceilingHeadline("pytest", run)}.`, ""];
	if (inflight === null)
		lines.push(
			"pytest reported no tests in flight, so the list is unavailable: the kill",
			"came before a test started, or the plugin could not write it.",
		);
	else {
		if (inflight.open.length > 0) {
			lines.push("In flight:");
			for (const row of inflight.open)
				lines.push(`  ${row.nodeid} — ${row.stage}`);
		} else lines.push("No test was in flight.");
		const never = neverStartedCount(inflight);
		lines.push(
			"",
			never === null
				? "Never started: unavailable, as pytest reported no collected count."
				: `Never started: ${String(never)} test(s).`,
			`Finished: ${String(inflight.finished)} test(s).`,
		);
	}
	lines.push("", ...CEILING_CLOSE, "");
	return lines.join("\n");
}

module.exports = { runPytest, ceilingKillRow };
