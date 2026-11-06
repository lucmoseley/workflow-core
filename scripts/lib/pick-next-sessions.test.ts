// @vitest-environment node
/*
 * Pins what pick-next decides off the session listing and the claim store:
 * whether the store it read claims from is the tree they were filed under
 * (mantahostels#703), what the claims read carries when it is not, and which
 * finished sessions count as reclaimable (mantahostels#421) — #4329.
 *
 * Loosen a case and a run from a worktree reads an empty store as an
 * unclaimed frontier and offers live work as takeable, or promises headroom
 * stopping this very session could never return.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const {
	claimsFromStore,
	reclaimableFrom,
	storeElsewhere,
} = require("./pick-next-sessions.js");

const listedWith = (ids: string[], finished: string[]) => ({
	ids: new Set(ids),
	names: new Map(),
	finished: new Set(finished),
	terminal: new Set(),
	pids: new Map(),
});

describe("the finished-but-resident pool (mantahostels#421)", () => {
	it("never counts this run's own session as reclaimable", () => {
		expect(reclaimableFrom(listedWith(["self"], ["self"]), "self")).toEqual({
			ok: true,
			count: 0,
			ids: [],
		});
		expect(
			reclaimableFrom(listedWith(["self", "a"], ["self", "a"]), "self"),
		).toEqual({ ok: true, count: 1, ids: ["a"] });
	});

	it("reads as unknown, carrying the oracle's refusal, when the oracle will not answer", () => {
		expect(reclaimableFrom({ why: "agents --json timed out" }, "self")).toEqual(
			{ ok: false, error: "agents --json timed out" },
		);
	});
});

describe("which tree the claims came from (mantahostels#703)", () => {
	let dir = "";
	let canonical = "";
	let worktree = "";
	const git = (cwd: string, ...args: string[]) =>
		spawnSync(
			"git",
			["-c", "user.email=t@example", "-c", "user.name=t", ...args],
			{ cwd, encoding: "utf8" },
		);

	beforeAll(() => {
		dir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "pick-next-sessions-")),
		);
		canonical = path.join(dir, "canonical");
		worktree = path.join(dir, "linked-worktree");
		fs.mkdirSync(path.join(canonical, "sub"), { recursive: true });
		git(canonical, "init", "-q");
		git(canonical, "config", "user.email", "test@example.com");
		git(canonical, "config", "user.name", "test");
		git(canonical, "commit", "-q", "--allow-empty", "-m", "base");
		git(canonical, "worktree", "add", "-q", "--detach", worktree, "HEAD");
	});
	afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

	it("points the reader at the canonical checkout, not the worktree", () => {
		expect(storeElsewhere(worktree, worktree)).toEqual({
			why: `the claim store resolves to ${worktree}, not the tree this run's claims are filed under (${canonical})`,
			use: canonical,
		});
	});

	it("calls a subdirectory a mismatch", () => {
		const sub = path.join(canonical, "sub");
		const r = storeElsewhere(canonical, sub);
		expect(r.why).toMatch(/not the tree this run's claims are filed under/);
	});

	it("names both trees, so the reader can see which store was read", () => {
		const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(dir, "store-")));
		expect(storeElsewhere(canonical, elsewhere)).toEqual({
			why: `the claim store resolves to ${elsewhere}, not the tree this run's claims are filed under (${canonical})`,
			use: canonical,
		});
	});

	it("says nothing when the two roots agree", () => {
		expect(storeElsewhere(canonical, canonical)).toBeNull();
	});

	const divergence = {
		why: "the claim store resolves to /x, not the tree this run's claims are filed under (/y)",
		use: "/y",
	};

	it("keeps the corrupt-record warning beside the divergence, not overwritten by it (mantahostels#1186)", () => {
		const r = claimsFromStore(
			{
				held: new Map(),
				kept: false,
				why: "1 claim record could not be read and was dropped",
			},
			divergence,
		);
		expect(r.why).toBe(
			`${divergence.why}; also, 1 claim record could not be read and was dropped`,
		);
		expect(r.claimsTree).toBe("/y");
	});

	it("prefers the divergence to the oracle's own degraded read", () => {
		const r = claimsFromStore(
			{ held: new Map(), kept: true, why: "agents --json timed out" },
			divergence,
		);
		expect(r.why.startsWith(divergence.why)).toBe(true);
		expect(
			claimsFromStore({ held: new Map(), kept: false, why: null }, divergence)
				.why,
		).toBe(divergence.why);
	});

	it("still reads the claims it found there, rather than discarding them", () => {
		const held = new Map([[1, "alice"]]);
		const r = claimsFromStore({ held, kept: false, why: null }, divergence);
		expect(r.held).toBe(held);
		const same = { held, kept: false, why: null };
		expect(claimsFromStore(same, null)).toBe(same);
	});
});
