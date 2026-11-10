// @vitest-environment node
/*
 * lib/lander-on-push.js, start-lander-on-push.js's core (#2785), in process:
 * which pushes start the queue lander (#2405, #4458).
 *
 * Loosen it and a push elsewhere starts a lander nobody asked for; tighten it
 * and a queue ref sits untested until some later session starts.
 */

import path from "node:path";
import { expect, it } from "vitest";
import { fakeSymbolicName, fakeTreeClassifier } from "./git-tree-fake.js";
import { kitContextFake } from "./kit-context-fake";

const { decide } = require("./lander-on-push.js") as {
	decide: (command: string, ctx: object) => unknown;
};

const REPO = "/repo";
const LAUNCH = {
	launch: {
		script: path.join(__dirname, "..", "start-lander.js"),
		log: ".lander.log",
	},
};

function harness({ branch = "topic", landing = true, cwd = REPO } = {}) {
	const asked: string[] = [];
	const ctx = kitContextFake({
		fallbackCwd: cwd,
		isDir: () => true,
		moduleOn: (m) => {
			asked.push(m);
			return m === "landing" && landing;
		},
		treeClass: fakeTreeClassifier({ [REPO]: "shared" }),
		symbolicName: fakeSymbolicName({
			root: REPO,
			head: branch,
			branches: ["main"],
		}),
	});
	return { ctx, asked };
}

it.each([
	"git push origin HEAD:queue/q1",
	"git push origin main:refs/heads/queue/q1",
	"git push -f origin HEAD:queue/q1",
	"timeout 60 git push -q origin HEAD:refs/heads/queue/q1",
	"env GIT_TRACE=0 git push origin HEAD:queue/q1",
	"git push origin main && git push origin HEAD:queue/q1",
	"git -C /repo/sub push origin HEAD:queue/q1",
])("starts the lander after %s", (command) => {
	expect(decide(command, harness().ctx)).toEqual(LAUNCH);
});

it("starts it from a bare push on a branch named for a queue ref", () => {
	expect(decide("git push", harness({ branch: "queue/q1" }).ctx)).toEqual(
		LAUNCH,
	);
});

it.each([
	["git push origin main", "another ref"],
	["git push origin HEAD:landing", "landing"],
	["git push origin HEAD:queue/", "the bare prefix"],
	["git push origin HEAD:spike/x", "another branch"],
	["git push origin HEAD:refs/tags/queue/q1", "a tag named for a queue ref"],
	["git push --dry-run origin HEAD:queue/q1", "a dry run"],
	["git push -h", "the help"],
	["git push origin --delete queue/q1", "a deletion"],
	["git push origin :queue/q1", "a deletion by refspec"],
	[
		"git push origin --delete refs/heads/queue/q1",
		"a deletion of the full ref",
	],
	["git push --all origin", "--all"],
	["git push --mirror origin", "--mirror"],
	["echo git push origin HEAD:queue/q1", "a mention"],
	['git push origin "$B":queue/q1', "a spec it cannot read"],
	["git -C /else push origin HEAD:queue/q1", "a push from another repo"],
	["git push", "a bare push on another branch"],
])("starts nothing after %s — %s", (command) => {
	expect(decide(command, harness().ctx)).toBeNull();
});

it("starts nothing with the landing module off", () => {
	expect(
		decide("git push origin HEAD:queue/q1", harness({ landing: false }).ctx),
	).toBeNull();
});

it("reads the module only once a push reaches a queue ref", () => {
	const { ctx, asked } = harness();
	decide("git push origin main", ctx);
	expect(asked).toEqual([]);
});
