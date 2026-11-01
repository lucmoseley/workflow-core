/* The id in the line `repo-hold.js raise` prints, for tests that go on to use it. */
export const parseHoldId = (stdout: string) => {
	const id = /raised: ([0-9a-f]+) /.exec(stdout)?.[1];
	if (!id) throw new Error(`no hold id in: ${stdout}`);
	return id;
};
