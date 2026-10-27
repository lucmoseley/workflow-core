/*
 * echo-record-host.js — the production echo-chain store (#2787): one file
 * per (session, agent) under ${TMPDIR:-/tmp}/wfc-echo-chain, in
 * lib/echo-chain.js's record format. lib/echo-record.js records in it, and
 * lib/echo-call.js reads it and writes its refusals through the same `chain`
 * port (lib/echo-call-host.js).
 *
 * TWO HAZARDS, two mechanisms. The atomic write stops a concurrent reader
 * seeing a half-written chain; the lock stops two overlapping calls' rebuilds
 * losing one record. The lock is `<file>.dlock`, a directory
 * (lib/dir-lock.js), taken by the recorder's write and the guard's alike. A
 * record lost to a lock wait run out undercounts a chain, which delays a
 * refusal and never causes one.
 */

const fs = require("node:fs");
const path = require("node:path");
const { writeFileAtomic } = require("./atomic-write.js");
const { sweepFiles, withDirLock } = require("./dir-lock.js");
const { parseRecords, storeText } = require("./echo-chain.js");
const { caught } = require("./caught.js");
const { scratchDir } = require("./guard-entry.js");

/* Swept at a day, on this agent's first record only, since this runs on
 * every call. */
const SWEEP_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * `stat -L -c '%i:%s:%.9Y:%.9Z'`: inode, size, and mtime and ctime to the
 * nanosecond, through any symlink.
 * @param {fs.BigIntStats} st
 */
function fileStateOf(st) {
	const Ns = BigInt(1_000_000_000);
	/** @param {bigint} ns */
	const at = (ns) => `${ns / Ns}.${String(ns % Ns).padStart(9, "0")}`;
	return `${st.ino}:${st.size}:${at(st.mtimeNs)}:${at(st.ctimeNs)}`;
}

/**
 * @param {string} _root
 * @param {(what: string) => void} log
 * @returns {import("./echo-record.js").EchoPorts & {
 *   readChain: (name: string) => string | null }}
 */
function buildHostPorts(_root, log) {
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
		/* The store's text, "" where it is absent, null where it will not read.
		 * Unlocked: the write is atomic, so a reader sees the whole old file or
		 * the whole new one. */
		readChain: (name) => {
			try {
				return fs.readFileSync(path.join(dir, name), "utf8");
			} catch (e) {
				return caught(e).code === "ENOENT" ? "" : null;
			}
		},
		chain: (name, sig, next) => {
			const file = path.join(dir, name);
			try {
				fs.mkdirSync(dir, { recursive: true });
			} catch {
				/* Fail open (§N5): no store, no chain, and the guard never fires on
				 * this call's answer; the core logs it. */
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
					/* A chain that cannot be READ is a broken clock, not an absent
					 * record: restarting it at 1 would disarm the guard. */
					log("could not read the chain store — no echo chain recorded");
					return true;
				}
				const prior = records.find((r) => r.sig === sig) ?? null;
				const rec = next(prior);
				try {
					writeFileAtomic(file, storeText(records, { sig, ...rec, at: now }));
				} catch {
					/* Fail open (§N5), as the unmade directory above. */
					return false;
				}
				return true;
			});
			if (first) {
				try {
					sweepFiles(dir, SWEEP_AGE_MS);
				} catch {
					/* Hygiene: a failed sweep is retried on the next agent's first. */
				}
			}
			return ok;
		},
	};
}

module.exports = { buildHostPorts };
