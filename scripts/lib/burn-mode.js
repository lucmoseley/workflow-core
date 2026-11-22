const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { caught } = require("./caught.js");
const { machineMarkerPath } = require("./machine-marker.js");
const { modeSettings } = require("./model-table.js");
const { readPlanDirs } = require("./plan-dirs.js");
const { trimmed } = require("./trimmed.js");
const { writeFd } = require("./write-fd.js");

const MARKER = ".burn-mode";

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
function markerPath(env = process.env) {
	return env.WFC_BURN_MARKER || machineMarkerPath(MARKER, env);
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {boolean}
 */
function isBurnMarkerOn(env) {
	try {
		return fs.existsSync(markerPath(env));
	} catch {
		return false;
	}
}

/**
 * @param {string} home
 * @returns {{files: Map<string, string>, dangling: string[]}}
 */
function readPlanFiles(home) {
	const homeReal = fs.realpathSync(home);
	/** @type {Map<string, string>} */
	const files = new Map();
	/** @type {string[]} */
	const dangling = [];
	for (const dir of readPlanDirs(home)) {
		const file = path.join(dir, "settings.json");
		try {
			const real = fs.realpathSync(file);
			files.set(real, path.relative(homeReal, real));
		} catch {
			if (isPresent(file)) dangling.push(file);
		}
	}
	return { files, dangling };
}

/** @param {string} file */
function isPresent(file) {
	try {
		fs.lstatSync(file);
		return true;
	} catch {
		return false;
	}
}

/**
 * @param {string} file
 * @param {boolean} burn
 * @returns {{model: string, faults: string[]}}
 */
function readPlanFaults(file, burn) {
	const want = modeSettings(burn);
	const mode = burn ? "burn" : "standard";
	let settings;
	try {
		settings = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return { model: "", faults: ["settings will not parse"] };
	}
	const model = trimmed(settings?.model);
	/** @type {string[]} */
	const faults = [];
	if (model !== want.model) faults.push(`not the ${mode} model, ${want.model}`);
	for (const [id, { effortLevel }] of Object.entries(want.modelSettings)) {
		const has = settings?.modelSettings?.[id]?.effortLevel;
		if (has !== effortLevel)
			faults.push(
				`${id} effortLevel=${has ?? "absent"}, not the ${mode} effort, ${effortLevel}`,
			);
	}
	return { model, faults };
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {{on: boolean|null, disagreeing: string[], error: string|null}}
 */
function readBurnState(env = process.env) {
	try {
		const on = fs.existsSync(markerPath(env));
		const disagreeing = [...readPlanFiles(env.HOME ?? "").files]
			.filter(([file]) => readPlanFaults(file, on).faults.length > 0)
			.map(([, name]) => name);
		return { on, disagreeing, error: null };
	} catch (err) {
		return { on: null, disagreeing: [], error: caught(err).message };
	}
}

module.exports = {
	isBurnMarkerOn,
	markerPath,
	readBurnState,
};

if (require.main === module) {
	try {
		const { values, positionals } = parseArgs({
			allowPositionals: true,
			strict: true,
			options: { quiet: { type: "boolean" }, burn: { type: "boolean" } },
		});
		const [mode] = positionals;
		if (mode === "marker") {
			writeFd(1, `${markerPath()}\n`);
			process.exit(0);
		}
		if (mode === "plans") {
			const home = process.env.HOME ?? "";
			let listed;
			try {
				listed = readPlanFiles(home);
			} catch (err) {
				writeFd(
					2,
					`burn-mode: cannot list the plans under ${home}: ${caught(err).message}\n`,
				);
				process.exit(2);
			}
			const { files, dangling } = listed;
			for (const file of values.quiet ? [] : dangling)
				writeFd(
					2,
					`warning: skipping ${path.relative(home, file)} — it resolves to nothing\n`,
				);
			writeFd(1, [...files.keys()].map((f) => `${f}\0`).join(""));
			process.exit(0);
		}
		if (mode === "report") {
			let rows;
			try {
				rows = [...readPlanFiles(process.env.HOME ?? "").files].map(
					([file, name]) => ({
						name,
						...readPlanFaults(file, values.burn === true),
					}),
				);
			} catch (err) {
				writeFd(2, `burn-mode: ${caught(err).message}\n`);
				process.exit(2);
			}
			const width = Math.max(0, ...rows.map((r) => r.name.length));
			for (const { name, model, faults } of rows)
				writeFd(
					1,
					`  ${name.padEnd(width)} model=${model || "absent"}${faults.map((f) => `  (${f})`).join("")}\n`,
				);
			process.exit(rows.some((r) => r.faults.length > 0) ? 1 : 0);
		}
		process.exit(2);
	} catch {
		process.exit(2);
	}
}
