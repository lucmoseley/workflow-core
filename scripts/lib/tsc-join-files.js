const fs = require("node:fs");
const path = require("node:path");
const { ignoreFailure } = require("./caught.js");
const { escapeRe, requiredGroup } = require("./regex-group.js");

const JOIN_PREFIX = "wfc-tsc-join-";
const RUN_PREFIX = "wfc-tsc-run-";

/**
 * @typedef {{ toplevel: string, cwd: string, command: string[], session: string | null }} TscHolder
 * @typedef {{ pid: number, start: number }} RunId
 * @typedef {{ pid: number, start: number, at: number, session: string | null, run: RunId }} JoinRecord
 * @typedef {{ code: number, signal: NodeJS.Signals | null, spawnedAt: number, endedAt: number }} RunResult
 */

/**
 * @param {string} dir
 * @param {RunId} run
 */
function runFiles(dir, { pid, start }) {
	const stem = path.join(dir, `${RUN_PREFIX}${pid}-${start}`);
	return {
		out: `${stem}.out`,
		err: `${stem}.err`,
		result: `${stem}.result.json`,
	};
}

/**
 * @param {string} dir
 * @param {number} pid
 */
const joinMarkerPath = (dir, pid) =>
	path.join(dir, `${JOIN_PREFIX}${pid}.json`);

/**
 * @param {string} dir
 * @param {JoinRecord} record
 * @param {typeof fs} [queueFs]
 * @returns {string | Error}
 */
function writeJoinMarker(dir, record, queueFs = fs) {
	const file = joinMarkerPath(dir, record.pid);
	try {
		queueFs.mkdirSync(dir, { recursive: true });
		queueFs.writeFileSync(file, JSON.stringify(record));
		return file;
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
}

/**
 * @param {string} dir
 * @param {typeof fs} [queueFs]
 * @returns {{ file: string, record: JoinRecord }[]}
 */
function readJoinMarkers(dir, queueFs = fs) {
	let names;
	try {
		names = queueFs.readdirSync(dir);
	} catch {
		return [];
	}
	return names
		.map(String)
		.filter((name) => name.startsWith(JOIN_PREFIX))
		.flatMap((name) => {
			const file = path.join(dir, name);
			try {
				const record = JSON.parse(String(queueFs.readFileSync(file, "utf8")));
				return typeof record?.pid === "number" &&
					typeof record?.run?.pid === "number"
					? [{ file, record }]
					: [];
			} catch {
				return [];
			}
		});
}

/**
 * @param {JoinRecord} record
 * @param {RunId} run
 */
const isJoinOf = (record, run) =>
	record.run.pid === run.pid && record.run.start === run.start;

/**
 * @param {string} dir
 * @param {RunId} run
 * @param {{ queueFs?: typeof fs, isStale: (record: { pid: number, start?: number }) => boolean }} options
 * @returns {boolean}
 */
function hasLiveJoiner(dir, run, { queueFs = fs, isStale }) {
	return readJoinMarkers(dir, queueFs).some(
		({ record }) => isJoinOf(record, run) && !isStale(record),
	);
}

/**
 * @param {string} dir
 * @param {RunId} run
 * @param {{ queueFs?: typeof fs, say: { write: (s: string) => unknown }, label: string }} options
 */
function openCapture(dir, run, { queueFs = fs, say, label }) {
	const files = runFiles(dir, run);
	/** @type {{ out: number, err: number } | null} */
	let fds = null;
	try {
		queueFs.mkdirSync(dir, { recursive: true });
		fds = {
			out: queueFs.openSync(files.out, "w"),
			err: queueFs.openSync(files.err, "w"),
		};
	} catch (error) {
		removeRunFiles(dir, run, queueFs);
		say.write(
			`${label}: could not open this type-check's capture files in ${dir} (${error instanceof Error ? error.message : error}) — it runs, but a request that joined it joins another queued run or runs its own (#5639).\n`,
		);
	}
	/** @param {"out" | "err"} stream */
	const into = (stream) => (/** @type {string} */ text) => {
		if (!fds) return;
		const fd = fds[stream];
		ignoreFailure(() => queueFs.writeSync(fd, text));
	};
	const close = () => {
		if (!fds) return;
		const { out, err } = fds;
		fds = null;
		ignoreFailure(() => queueFs.closeSync(out));
		ignoreFailure(() => queueFs.closeSync(err));
	};
	return {
		out: into("out"),
		err: into("err"),
		/** @param {Omit<RunResult, "code"> & { code: number | null }} result */
		settle: (result) => {
			const opened = fds !== null;
			close();
			if (!opened || result.code === null) return;
			const tmp = `${files.result}.${process.pid}.tmp`;
			ignoreFailure(() => {
				queueFs.writeFileSync(tmp, JSON.stringify(result));
				queueFs.renameSync(tmp, files.result);
			});
		},
		close,
	};
}

/**
 * @param {string} dir
 * @param {RunId} run
 * @param {typeof fs} [queueFs]
 * @returns {RunResult | null}
 */
function readResult(dir, run, queueFs = fs) {
	try {
		const record = JSON.parse(
			String(queueFs.readFileSync(runFiles(dir, run).result, "utf8")),
		);
		return typeof record?.spawnedAt === "number" &&
			typeof record?.code === "number"
			? record
			: null;
	} catch {
		return null;
	}
}

/**
 * @param {string} dir
 * @param {RunId} run
 * @param {typeof fs} [queueFs]
 * @returns {{ stdout: string, stderr: string }}
 */
function readCaptured(dir, run, queueFs = fs) {
	const files = runFiles(dir, run);
	/** @param {string} file */
	const read = (file) => {
		try {
			return String(queueFs.readFileSync(file, "utf8"));
		} catch {
			return "";
		}
	};
	return { stdout: read(files.out), stderr: read(files.err) };
}

/**
 * @param {string} dir
 * @param {RunId} run
 * @param {typeof fs} [queueFs]
 */
function removeRunFiles(dir, run, queueFs = fs) {
	for (const file of Object.values(runFiles(dir, run)))
		ignoreFailure(() => queueFs.rmSync(file, { force: true }));
}

const RUN_FILE = new RegExp(`^${escapeRe(RUN_PREFIX)}(\\d+)-(\\d+)\\.`);

/**
 * @param {string} dir
 * @param {{ queueFs?: typeof fs, isStale: (record: { pid: number, start?: number }) => boolean }} options
 */
function sweepJoinFiles(dir, { queueFs = fs, isStale }) {
	const joiners = readJoinMarkers(dir, queueFs).filter(({ file, record }) => {
		if (!isStale(record)) return true;
		ignoreFailure(() => queueFs.unlinkSync(file));
		return false;
	});
	let entries;
	try {
		entries = queueFs.readdirSync(dir).map(String);
	} catch {
		return;
	}
	for (const name of entries) {
		const match = RUN_FILE.exec(name);
		if (!match) continue;
		const run = {
			pid: Number(requiredGroup(match, 1, RUN_FILE)),
			start: Number(requiredGroup(match, 2, RUN_FILE)),
		};
		if (!isStale(run)) continue;
		if (joiners.some(({ record }) => isJoinOf(record, run))) continue;
		ignoreFailure(() => queueFs.unlinkSync(path.join(dir, name)));
	}
}

module.exports = {
	hasLiveJoiner,
	openCapture,
	readCaptured,
	readResult,
	removeRunFiles,
	sweepJoinFiles,
	writeJoinMarker,
};
