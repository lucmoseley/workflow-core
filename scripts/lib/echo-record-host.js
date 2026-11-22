const fs = require("node:fs");
const path = require("node:path");
const { writeFileAtomic } = require("./atomic-write.js");
const { ignoreFailure } = require("./caught.js");
const { sweepFiles, withDirLock } = require("./dir-lock.js");
const { parseRecords, storeText } = require("./echo-chain.js");
const { readText } = require("./file-read.js");
const { scratchDir } = require("./guard-entry.js");

// guess, #5529
const SWEEP_AGE_MS = 24 * 60 * 60 * 1000;

/** @param {fs.BigIntStats} st */
function fileStateOf(st) {
	const Ns = BigInt(1_000_000_000);
	/** @param {bigint} ns */
	const at = (ns) => `${ns / Ns}.${String(ns % Ns).padStart(9, "0")}`;
	return `${st.ino}:${st.size}:${at(st.mtimeNs)}:${at(st.ctimeNs)}`;
}

/**
 * @param {{ log: (what: string) => void }} env
 * @returns {import("./echo-record.js").EchoPorts & {
 *   readChain: (name: string) => string | null }}
 */
function buildHostPorts({ log }) {
	const dir = scratchDir(process.env, "echo-chain");
	return {
		fileState: (file) => {
			if (!fs.existsSync(file)) return null;
			try {
				return fileStateOf(fs.statSync(file, { bigint: true }));
			} catch {
				log("could not stat a Read's file — signed on its input alone");
				return null;
			}
		},
		readChain: (name) => {
			const got = readText(path.join(dir, name));
			if (got.state === "read") return got.data;
			return got.state === "absent" ? "" : null;
		},
		chain: (name, sig, next) => {
			const file = path.join(dir, name);
			try {
				fs.mkdirSync(dir, { recursive: true });
			} catch {
				return false;
			}
			const first = !fs.existsSync(file);
			const ok = withDirLock(`${file}.dlock`, () => {
				const now = Math.floor(Date.now() / 1000);
				let records;
				try {
					records = first
						? []
						: parseRecords(fs.readFileSync(file, "utf8"), now);
				} catch {
					log("could not read the chain store — no echo chain recorded");
					return true;
				}
				const prior = records.find((r) => r.sig === sig) ?? null;
				const rec = next(prior);
				try {
					writeFileAtomic(file, storeText(records, { sig, ...rec, at: now }));
				} catch {
					return false;
				}
				return true;
			});
			if (first) ignoreFailure(() => sweepFiles(dir, SWEEP_AGE_MS));
			return ok;
		},
	};
}

module.exports = { buildHostPorts };
