// @vitest-environment node
/*
 * parent-claims.js's own suite: whether a live session's claim on an issue's
 * parent map holds the issue too (#2310), and how a holder is named.
 *
 * Each case builds its claim stores in a fresh temp directory, with HOME and
 * CLAUDE_CONFIG_DIR pointed into it, so a parent in another repo is read from
 * a checkout this case wrote and never from the machine's own.
 *
 * pick-next.js reads every candidate's parent through parentVerdictOf: loosen
 * a case here and a ticket under a map still being charted is launched, or a
 * store that would not read hides a ticket with no WARN.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	writeAdopterCheckout,
	writeIssueClaim,
	writeTornClaim,
} from "./claim-store-testkit";

const { heldIssues } = require("./arbiter-issue-claims.js");
const { holderName, parentVerdictOf } = require("./parent-claims.js");

let dir = "";
const configDir = () => path.join(dir, "home", ".claude");
const home = () => path.join(dir, "adopters");

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "parent-claims-"));
	fs.mkdirSync(home(), { recursive: true });
	vi.stubEnv("CLAUDE_CONFIG_DIR", configDir());
	vi.stubEnv("HOME", home());
});

afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(dir, { recursive: true, force: true });
});

const here = "https://api.github.com/repos/o/r/issues/20";
const there = "https://api.github.com/repos/o/there/issues/7";
const MAP = ["wayfinder:map"];
const held = (claims: Record<number, string>) => ({
	held: new Map(Object.entries(claims).map(([n, s]) => [Number(n), s])),
	kept: false,
	why: null,
});

describe("parentVerdictOf", () => {
	it("frees a child whose live-claimed parent is no map, and holds it under a map", () => {
		const ctx = {
			childRepo: "o/r",
			listed: { ids: new Set(["alice"]) },
			hostHeld: held({ 20: "alice" }),
		};
		expect(
			parentVerdictOf(21, { url: here, labels: ["kind:spec"] }, ctx),
		).toEqual({ state: "free" });
		expect(parentVerdictOf(21, { url: here, labels: MAP }, ctx)).toEqual({
			state: "claimed",
			label: "#20",
			sessionId: "alice",
			kept: false,
		});
	});

	it("frees a child whose map parent's claim is held by an ended session", () => {
		const repo = path.join(dir, "repo");
		writeIssueClaim(configDir(), repo, 20, "alice");
		const verdict = (ids: string[]) =>
			parentVerdictOf(
				21,
				{ url: here, labels: MAP },
				{
					childRepo: "o/r",
					listed: { ids: new Set(ids) },
					hostHeld: heldIssues({ ids: new Set(ids) }, repo),
				},
			);
		expect(verdict(["self"])).toEqual({ state: "free" });
		expect(verdict(["self", "alice"])).toMatchObject({
			state: "claimed",
			sessionId: "alice",
		});
	});

	it("reads a parent in another repo as unread, with why, where that repo's store reads only in part", () => {
		const at = path.join(home(), "there");
		writeAdopterCheckout(at, "o/there");
		writeIssueClaim(configDir(), at, 8, "alice");
		writeTornClaim(configDir(), at);
		expect(
			parentVerdictOf(
				21,
				{ url: there, labels: MAP },
				{
					childRepo: "o/r",
					listed: { ids: new Set(["alice"]) },
					hostHeld: held({}),
				},
			),
		).toEqual({
			state: "unread",
			why: expect.stringMatching(
				/^the claim on parent o\/there#7 was not read: 1 issue-claim record could not be read and was dropped/,
			),
		});
	});

	it("reads a parent in another repo as unread, with why, where no checkout tracks that repo", () => {
		expect(
			parentVerdictOf(
				21,
				{ url: there, labels: MAP },
				{
					childRepo: "o/r",
					listed: { ids: new Set(["alice"]) },
					hostHeld: held({ 7: "alice" }),
				},
			),
		).toEqual({
			state: "unread",
			why: `no checkout under ${home()} tracks o/there, so the claim on parent o/there#7 was not read`,
		});
	});
});

describe("holderName", () => {
	it("names the holding session where the oracle listed its name", () => {
		const names = new Map([["alice", "Implement 708"]]);
		expect(holderName(names, "alice")).toBe("Implement 708");
	});

	it("falls back to the id's first 8 characters where the oracle named no session", () => {
		const id = "0b1a4d3e-1111-2222-3333-444455556666";
		expect(holderName(new Map(), id)).toBe("0b1a4d3e");
		expect(holderName(null, id)).toBe("0b1a4d3e");
	});
});
