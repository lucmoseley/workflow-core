// guess: room for a session uuid or a subagent id, workflow-core#5774
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * @param {unknown} id
 * @returns {id is string}
 */
function isSafeId(id) {
	return typeof id === "string" && SAFE_ID.test(id);
}

module.exports = { isSafeId };
