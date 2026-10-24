/*
 * lib/landing-status.js's commitStates (#2407), on a fake git.
 *
 * Loosen it and a re-landed commit reads as reverted, or a reverted one that
 * had reached main reads as landed.
 */
import { describe, expect, it } from "vitest";
import { commitStates } from "./landing-status.js";

/** `reverts` maps a commit to its revert. */
const fakeGit = ({
	onMain = [] as string[],
	onLanding = [] as string[],
	onHead = [] as string[],
	reverts = {} as Record<string, string>,
}) => ({
	isOn: (ref: string, sha: string) =>
		({ "origin/main": onMain, "origin/landing": onLanding, HEAD: onHead })[
			ref
		]?.includes(sha) ?? false,
	revertOf: (sha: string) => reverts[sha] ?? null,
});

const stateOf = (sha: string, git: ReturnType<typeof fakeGit>) =>
	commitStates([sha], git)[0].state;

describe("commitStates", () => {
	it("reads a reverted commit as reverted even once it had reached main", () => {
		const git = fakeGit({
			onMain: ["c"],
			onLanding: ["c", "r"],
			reverts: { c: "r" },
		});
		expect(stateOf("c", git)).toEqual({ kind: "reverted", by: "r" });
	});

	it("reads a commit whose revert was itself reverted by where it sits", () => {
		const git = fakeGit({
			onLanding: ["c", "r", "rr"],
			reverts: { c: "r", r: "rr" },
		});
		expect(stateOf("c", git)).toEqual({ kind: "queued" });
	});

	it("reads a third revert down the chain as standing", () => {
		const git = fakeGit({
			onLanding: ["c", "r", "rr", "rrr"],
			reverts: { c: "r", r: "rr", rr: "rrr" },
		});
		expect(stateOf("c", git)).toEqual({ kind: "reverted", by: "r" });
	});

	it("leaves out a commit HEAD no longer holds and no branch carries, as an amend leaves", () => {
		const git = fakeGit({ onLanding: ["new"], onHead: ["new"] });
		expect(commitStates(["old", "new"], git)).toEqual([
			{ sha: "new", state: { kind: "queued" } },
		]);
	});

	it("keeps the order given", () => {
		const git = fakeGit({
			onMain: ["a"],
			onLanding: ["a", "b"],
			onHead: ["z"],
		});
		expect(commitStates(["b", "a", "z"], git)).toEqual([
			{ sha: "b", state: { kind: "queued" } },
			{ sha: "a", state: { kind: "landed" } },
			{ sha: "z", state: { kind: "unpushed" } },
		]);
	});
});
