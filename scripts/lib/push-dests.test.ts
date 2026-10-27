// @vitest-environment node
/*
 * lib/push-dests.js (#2785): where a `git push` sends each ref, as
 * lib/branch-publish.js and lib/lander-on-push.js read it (#2405).
 */

import { describe, expect, it } from "vitest";
import { fakeSymbolicName } from "./git-tree-fake.js";

interface Row {
	kind: string;
	ref: string;
	forced: boolean;
	bare: boolean;
}
interface Read {
	inert: boolean;
	all: boolean;
	delete: boolean;
	rows: Row[];
}

const { readPush } = require("./push-dests.js") as {
	readPush: (
		args: string[],
		spans: string[],
		symbolicName: (src: string) => string,
	) => Read;
};
const { parseCommand } = require("./shell-parse.js") as {
	parseCommand: (s: string) => { spans: string[]; segments: string[] };
};
const { gitWords } = require("./shell-words.js") as {
	gitWords: (
		words: string[],
		spans: string[],
	) => { sub: string; args: string[] } | null;
};

/* `git rev-parse --symbolic-full-name` in a tree holding branches `topic` and
 * `main` and tag v1, on `topic` or detached. */
const TREE = "/repo";
const REFS = { root: TREE, branches: ["main"], tags: ["v1"] };
const onTopicName = fakeSymbolicName({ ...REFS, head: "topic" });
const detachedName = fakeSymbolicName({
	...REFS,
	head: null,
	branches: ["topic", "main"],
});
const onTopic = (src: string) => onTopicName(TREE, src);
const detached = (src: string) => detachedName(TREE, src);

/** The words after `push` in a one-segment command, as the walk hands them. */
function read(command: string, names = onTopic): Read {
	const parsed = parseCommand(command);
	const words = (parsed.segments[0] ?? "").split(" ").filter(Boolean);
	const git = gitWords(words, parsed.spans);
	if (git?.sub !== "push") throw new Error(`not a push: ${command}`);
	return readPush(git.args, parsed.spans, names);
}

const push = (ref: string, forced = false, bare = false) => ({
	kind: "push",
	ref,
	forced,
	bare,
});

describe("a refspec's destination", () => {
	it.each([
		[
			"git push origin HEAD:landing",
			"refs/heads/landing",
			"a src:dst takes dst",
		],
		[
			"git push origin main:refs/heads/landing",
			"refs/heads/landing",
			"a full dst kept",
		],
		[
			"git push origin main:heads/landing",
			"refs/heads/landing",
			"heads/ is a branch",
		],
		["git push origin v1:v2", "refs/tags/v2", "a tag's dst is a tag"],
		[
			"git push origin main",
			"refs/heads/main",
			"a bare src is what git names it",
		],
		["git push origin v1", "refs/tags/v1", "a bare tag is a tag"],
		[
			"git push origin refs/heads/x",
			"refs/heads/x",
			"a full src is kept unread",
		],
		[
			"git push origin nosuch",
			"refs/heads/nosuch",
			"an unnamed src is a branch",
		],
		[
			"git push origin 'HEAD:landing'",
			"refs/heads/landing",
			"a quoted spec is read back",
		],
	])("%s → %s — %s", (command, ref) => {
		expect(read(command).rows).toEqual([push(ref)]);
	});

	it("a bare push is the current branch, marked bare", () => {
		expect(read("git push").rows).toEqual([
			push("refs/heads/topic", false, true),
		]);
		expect(read("git push origin").rows).toEqual([
			push("refs/heads/topic", false, true),
		]);
	});

	it("a detached HEAD's bare push, which git refuses, gives no row", () => {
		expect(read("git push", detached).rows).toEqual([]);
		expect(read("git push origin HEAD", detached).rows).toEqual([]);
	});

	it("`tag <name>` gives no row, and the specs after it are read", () => {
		expect(read("git push origin tag v1 main").rows).toEqual([
			push("refs/heads/main"),
		]);
	});

	it("a trailing `tag` is a ref named tag", () => {
		expect(read("git push origin tag").rows).toEqual([push("refs/heads/tag")]);
	});

	it("--tags with no refspec gives no row", () => {
		expect(read("git push --tags origin").rows).toEqual([]);
	});

	it("a spec it cannot read is an unread push", () => {
		expect(read('git push origin "$B" main').rows).toEqual([
			{ kind: "unread-push", ref: "", forced: false, bare: false },
			push("refs/heads/main"),
		]);
	});

	it("the push's value flags take their value, which is no refspec", () => {
		expect(
			read("git push -o ci.skip --repo origin --exec x up HEAD:landing").rows,
		).toEqual([push("refs/heads/landing")]);
	});
});

describe("deletions", () => {
	it("`:dst` deletes dst, as written", () => {
		expect(read("git push origin :landing").rows).toEqual([
			{ kind: "delete", ref: "landing", forced: false, bare: false },
		]);
	});

	it.each(["-d", "--delete", "--del"])(
		"%s makes every spec a deletion",
		(flag) => {
			const r = read(`git push origin ${flag} landing "$X"`);
			expect(r.delete).toBe(true);
			expect(r.rows.map((row) => row.kind)).toEqual([
				"delete",
				"unread-delete",
			]);
		},
	);

	it("--d, under git's four letters, is no deletion", () => {
		expect(read("git push --d origin main").delete).toBe(false);
	});
});

describe("force", () => {
	it.each([
		["-f", true],
		["--force", true],
		["--force-with-lease", true],
		["--force-with-lease=main:abc", true],
		["--force-w", true],
		["--force-", false],
		["--force-with-lease --no-force-with-lease", false],
		["--no-force-with", false],
	])("%s forces every row: %s", (flags, forced) => {
		expect(read(`git push ${flags} origin main`).rows[0]?.forced).toBe(forced);
	});

	it("a + refspec forces its own row alone", () => {
		expect(read("git push origin +main HEAD:x").rows).toEqual([
			push("refs/heads/main", true),
			push("refs/heads/x"),
		]);
	});
});

describe("pushes that push nothing, or everything", () => {
	it.each(["-h", "--help", "-n", "--dry-run"])("%s is inert", (flag) => {
		expect(read(`git push ${flag} origin main`).inert).toBe(true);
	});

	it.each(["--all", "--branches", "--mirror"])("%s is all", (flag) => {
		expect(read(`git push ${flag} origin`).all).toBe(true);
	});

	it("a plain push is neither", () => {
		const r = read("git push origin main");
		expect([r.inert, r.all, r.delete]).toEqual([false, false, false]);
	});
});
