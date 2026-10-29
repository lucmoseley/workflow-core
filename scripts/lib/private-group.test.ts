// @vitest-environment node
/*
 * private-group.js judges whether a group is the user's private one from the
 * user databases' text (#3676, #3715, #3716). write-secret.js lets a parent
 * directory that group can write pass on it, so a case judged private here
 * that is not lets another user swap the secrets store's directory.
 */

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const { isPrivateGroup, USERDB_DIRS } =
	createRequire(__filename)("./private-group.js");

const me = { uid: 1000, gid: 1000, username: "me" };
const myPasswd = `me:x:${me.uid}:${me.gid}::/home/me:/bin/sh\n`;
const myGroup = `me:x:${me.gid}:\n`;
const FilesOnly = "passwd: files\ngroup: files\n";
const Systemd = "passwd: files systemd\ngroup: files systemd\n";

interface Db {
	group?: string | null;
	passwd?: string;
	nsswitch?: string;
	userdb?: Record<string, string[] | null>;
}
/** The databases as given, every userdb directory absent unless named. */
const judge = ({
	group = myGroup,
	passwd = myPasswd,
	nsswitch = FilesOnly,
	userdb = {},
}: Db): boolean =>
	isPrivateGroup(me.gid, me, {
		group,
		passwd,
		nsswitch,
		userdb: {
			...Object.fromEntries(USERDB_DIRS.map((d: string) => [d, []])),
			...userdb,
		},
	});

describe("isPrivateGroup", () => {
	it.each<[string, Db]>([
		["with lookups reading only the files", {}],
		[
			"with systemd serving only dynamic users",
			{
				nsswitch: Systemd,
				userdb: { "/run/systemd/userdb": ["io.systemd.DynamicUser"] },
			},
		],
	])("judges the user's own group private %s", (_label, db) => {
		expect(judge(db)).toBe(true);
	});

	it.each<[string, Db]>([
		["lists another member", { group: `me:x:${me.gid}:me,other\n` }],
		[
			"is another user's primary group",
			{ passwd: `${myPasswd}other:x:1001:${me.gid}::/home/o:/bin/sh\n` },
		],
		[
			"is not the user's primary group",
			{ passwd: `me:x:${me.uid}:${me.gid + 1}::/home/me:/bin/sh\n` },
		],
		["is in no /etc/group row", { group: "" }],
		["has a row with no member field", { group: `g:x:${me.gid}\n` }],
		["sits in an unreadable /etc/group", { group: null }],
		["may hold NIS members", { group: `${myGroup}+:::\n` }],
		["has a password", { group: `me:$6$salt$hash:${me.gid}:\n` }],
		[
			"lists another member behind a `#`",
			{ group: `${myGroup}a#b:x:${me.gid}:other\n` },
		],
		[
			"is another user's primary group by a wrapping id",
			{
				passwd: `${myPasswd}other:x:1001:-${2 ** 32 - me.gid}::/home/o:/bin/sh\n`,
			},
		],
		[
			"may hold members by a looser nsswitch line",
			{ nsswitch: `group : sss\n${FilesOnly}` },
		],
		[
			"may hold directory-service members",
			{ nsswitch: "passwd: files sss\ngroup: files sss\n" },
		],
		[
			"is named for a user a second, blank-led passwd row also names",
			{ passwd: `${myPasswd} me:x:1001:1001::/home/o:/bin/sh\n` },
		],
		[
			"may take members from an `initgroups` source",
			{ nsswitch: `${FilesOnly}initgroups: sss\n` },
		],
		[
			"is named for a user a second passwd row also names",
			{ passwd: `${myPasswd}me:x:1001:1001::/home/o:/bin/sh\n` },
		],
		[
			"may hold a systemd userdb record",
			{ nsswitch: Systemd, userdb: { "/etc/userdb": ["other.user"] } },
		],
		[
			"may hold a systemd-homed member",
			{
				nsswitch: Systemd,
				userdb: { "/run/systemd/userdb": ["io.systemd.Home"] },
			},
		],
		[
			"sits on a host whose userdb directory cannot be read",
			{ nsswitch: Systemd, userdb: { "/run/systemd/userdb": null } },
		],
	])("judges a group not private where it %s", (_label, db) => {
		expect(judge(db)).toBe(false);
	});

	it("judges no group but the user's primary one private", () => {
		expect(
			isPrivateGroup(me.gid + 1, me, {
				group: `g:x:${me.gid + 1}:\n`,
				passwd: myPasswd,
				nsswitch: FilesOnly,
				userdb: {},
			}),
		).toBe(false);
	});
});
