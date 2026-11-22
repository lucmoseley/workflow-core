const fs = require("node:fs");
const path = require("node:path");
const { orFallback } = require("./caught.js");
const { sweepFiles, withDirLock } = require("./dir-lock.js");

// guess, two days outlasts any working session seen, #1784
const SWEEP_AGE_MS = 2 * 24 * 60 * 60 * 1000;

/** @param {string} text */
function readTold(text) {
	const m = /^([01]) (\d+)\s*$/.exec(text);
	return m
		? { warned: m[1] === "1", named: Number(m[2]) }
		: { warned: false, named: 0 };
}

/**
 * @param {{ log: (what: string) => void }} env
 */
function buildHostPorts({ log }) {
	/** @type {import("./image-budget.js").ImageStore} */
	const imageStore = (name, entry, update) => {
		const dir = path.join(process.env.TMPDIR || "/tmp", "wfc-image-budget");
		try {
			fs.mkdirSync(dir, { recursive: true });
		} catch {
			log(`could not create ${dir} — an image Read went uncounted`);
			return null;
		}
		sweepFiles(dir, SWEEP_AGE_MS);
		const store = path.join(dir, name);
		return withDirLock(`${store}.dlock`, () => {
			try {
				fs.appendFileSync(store, `${entry.size}\t${entry.path}\n`);
			} catch {
				log(`could not write ${store} — an image Read went uncounted`);
				return null;
			}
			const entries = fs
				.readFileSync(store, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					const tab = line.indexOf("\t");
					return {
						size: Number(line.slice(0, tab)) || 0,
						path: line.slice(tab + 1),
					};
				});
			const told = orFallback(
				() => readTold(fs.readFileSync(`${store}.told`, "utf8")),
				{ warned: false, named: 0 },
			);
			const r = update(entries, told);
			try {
				fs.writeFileSync(
					`${store}.told`,
					`${r.told.warned ? 1 : 0} ${r.told.named}\n`,
				);
			} catch {
				log(`could not write ${store}.told — a notice may repeat`);
			}
			return r.message;
		});
	};
	return { imageStore };
}

module.exports = { buildHostPorts };
