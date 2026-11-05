/*
 * lib/landing-status.js's commitStates (#2407), on a fake git.
 *
 * Loosen it and a commit on the session's queue ref that reached main reads
 * as queued, or one on the queue ref reads as unpushed.
 */
import { describe, expect, it } from "vitest";
import { commitStates } from "./landing-status.js";

/** `onQueue` is the session's queue ref. */
const fakeGit = ({
	onMain = [] as string[],
	onQueue = [] as string[],
	onHead = [] as string[],
}) => ({
	pushed: "origin/queue/s",
	isOn: (ref: string, sha: string) =>
		({ "origin/main": onMain, "origin/queue/s": onQueue, HEAD: onHead })[
			ref
		]?.includes(sha) ?? false,
});

const stateOf = (sha: string, git: ReturnType<typeof fakeGit>) =>
	commitStates([sha], git)[0].state;

describe("commitStates", () => {
	it("reads a commit on the queue ref that reached main as landed", () => {
		const git = fakeGit({ onMain: ["c"], onQueue: ["c"] });
		expect(stateOf("c", git)).toEqual({ kind: "landed" });
	});

	it("leaves out a commit HEAD no longer holds and no branch carries, as an amend leaves", () => {
		const git = fakeGit({ onQueue: ["new"], onHead: ["new"] });
		expect(commitStates(["old", "new"], git)).toEqual([
			{ sha: "new", state: { kind: "queued" } },
		]);
	});

	it("keeps the order given", () => {
		const git = fakeGit({
			onMain: ["a"],
			onQueue: ["a", "b"],
			onHead: ["z"],
		});
		expect(commitStates(["b", "a", "z"], git)).toEqual([
			{ sha: "b", state: { kind: "queued" } },
			{ sha: "a", state: { kind: "landed" } },
			{ sha: "z", state: { kind: "unpushed" } },
		]);
	});
});
