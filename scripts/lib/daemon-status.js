/**
 * @param {string} out
 * @returns {{state: "none"} | {state: "pid", pid: string} | {state: "unread"}}
 */
function parseDaemonStatus(out) {
	if (out.split("\n")[0]?.trim() === "not running") return { state: "none" };
	const pid = /^pid:[ \t]+(\d+)[ \t]*$/m.exec(out)?.[1];
	return pid === undefined ? { state: "unread" } : { state: "pid", pid };
}

module.exports = { parseDaemonStatus };
