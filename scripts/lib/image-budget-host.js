/*
 * image-budget-host.js — the production store lib/image-budget.js counts in
 * (workflow-core#2787): one `<size>\t<path>` line per Read under
 * ${TMPDIR:-/tmp}/wfc-image-budget/<session>.<agent>, oldest first, and a
 * `.told` sidecar holding `<warned 0|1> <files named gone>`, rewritten on
 * every Read so the two age out together.
 */

const fs = require("node:fs");
const path = require("node:path");
const { sweepFiles, withDirLock } = require("./dir-lock.js");

/* A judgement: two days outlasts any working session seen here. */
const SWEEP_AGE_MS = 2 * 24 * 60 * 60 * 1000;

/** @param {string} text */
function readTold(text) {
	const m = /^([01]) (\d+)\s*$/.exec(text);
	return m
		? { warned: m[1] === "1", named: Number(m[2]) }
		: { warned: false, named: 0 };
}

/**
 * @param {string} _root
 * @param {(what: string) => void} log
 */
function buildHostPorts(_root, log) {
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
		/* Parallel Reads in one message run this hook concurrently; the append,
		 * the sums and the sidecar update are one read-modify-write. */
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
			let told = { warned: false, named: 0 };
			try {
				told = readTold(fs.readFileSync(`${store}.told`, "utf8"));
			} catch {
				/* No sidecar yet: nothing has been said. */
			}
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
