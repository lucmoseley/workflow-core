/*
 * pytest-child.js — `run-pytest.js`'s pytest run: spawned in its own group and
 * scope, signals passed on, and killed at the suite ceiling with a report of
 * the tests it had in flight (#2702).
 */

const fs = require("node:fs");
const path = require("node:path");

const { writeFd } = require("./write-fd.js");
const { pythonBin } = require("./python-bin.js");
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
	monotonicMs,
} = require("./suite-ceiling.js");

/* Where `pytest_pass_plugin.py` ships: beside `run-pytest.js`. */
const PLUGIN_DIR = path.join(__dirname, "..");

/* `-n 2` more than halves the local suite but gains only ~7% on the 2-vCPU CI
 * runner (mantahostels#313). No other worker count was ever measured;
 * requirements-dev.txt has why two, not one per core. */
/* `-p` here rather than in pytest.ini's addopts, so a bare `pytest` run
 * writes no marker. */
const DEFAULT_ARGS = ["-n", "2", "-p", "pytest_pass_plugin"];

/* Passed on to pytest's group rather than left to end the wrapper, so pytest
 * still prints its own interrupted summary. */
const FORWARDED = /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"]);

/**
 * @param {string[]} argv
 * @param {string} root
 * @param {{ handOff: string|null, inflightFile: string|null,
 *   schedule?: Parameters<typeof armCeiling>[0]["schedule"] }} options
 *   `schedule` reaches `armCeiling`, for a test to fire the ceiling on an
 *   event (#3520)
 * @returns {Promise<{ status: number|null, error: Error|null,
 *   forcedRed: boolean }>} `forcedRed` on a run killed at the ceiling or one
 *   that hit its scope's task cap, which fails whatever pytest said
 */
function runPytest(argv, root, { handOff, inflightFile, schedule }) {
	const ceiling = ceilingMs();
	return new Promise((resolve) => {
		/* Injected at WFC_PYTHON, never by PATH, because the tests feed it chosen
		 * hand-offs (§N7, #2102). */
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
					// The plugin is loaded by name before conftest puts `scripts/` on
					// sys.path, so the path has to be given here. It ships beside the
					// wrapper, not in the host's `scripts/`, so a plugin install needs
					// `PLUGIN_DIR` too; the host's goes first so its own imports win (#1285).
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
		let ceilingKilled = false;
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
				ceilingKilled = true;
				writeFd(
					2,
					buildCeilingReport(readInflight(inflightFile), {
						ceiling,
						elapsed: monotonicMs() - spawnedAtMono,
					}),
				);
				const unkilled = child.pid ? killGroup(child.pid) : null;
				if (unkilled) writeFd(2, groupUnkilled("pytest", unkilled));
				giveUp = setTimeout(() => {
					/* A child that never closed would keep this process alive past
					 * its own verdict. */
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
			resolve({ status, error, forcedRed: ceilingKilled || capped !== null });
		};
		child.on("error", (error) => settle(null, error));
		child.on("close", (status) => settle(status, null));
	});
}

/**
 * @typedef {{ open: { nodeid: string, stage: string }[], finished: number,
 *   collected: number|null }} PytestInflight
 */

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
		/* A missing or torn file costs the report its names, never the kill
		 * itself (#2702). */
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
		lines.push(
			"",
			inflight.collected === null
				? "Never started: unavailable, as pytest reported no collected count."
				: `Never started: ${String(inflight.collected - inflight.finished - inflight.open.length)} test(s).`,
			`Finished: ${String(inflight.finished)} test(s).`,
		);
	}
	lines.push("", ...CEILING_CLOSE, "");
	return lines.join("\n");
}

module.exports = { runPytest };
