/**
 * @param {string} pid
 * @param {{ children: Map<string, string[]>, stopPids: Set<string>, pssKbOf: (pid: string) => number | null }} tree
 * @param {string[]} reached
 */
function descendantsPssKb(pid, { children, stopPids, pssKbOf }, reached) {
	let kb = 0;
	const queue = [...(children.get(pid) ?? [])];
	for (let d = queue.shift(); d !== undefined; d = queue.shift()) {
		if (stopPids.has(d)) continue;
		reached.push(d);
		kb += pssKbOf(d) ?? 0;
		queue.push(...(children.get(d) ?? []));
	}
	return kb;
}

module.exports = { descendantsPssKb };
