"""swallowed_errors.py — base §N5 over Python source: an `except` raises,
exits, or hands the error it binds to a reporter imported from the
`fail_open` module (`scripts/lib/fail_open.py`) in a statement of its own
body: `fail_open` or `tallied` under any caught type, `expected` only under a
specific one, since it prints nothing (workflow-core#1830, workflow-core#5487, workflow-core#5503).

Run by scripts/check-swallowed-errors.js, which picks the program-routed paths
from the host's config. stdin is `{"sources": [{"name": ..., "text": ...}]}`;
stdout is `{"results": [{"name": ..., "breaches": [{"line", "function", "caught"}]}]}`,
a source that does not parse carrying `"error"` instead. `function` and `caught` let the judge count a file's
breaches against HEAD's without line numbers, which any edit above them moves.
"""

import ast
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
from fail_open import fail_open

EXITS = {"sys.exit", "exit", "quit", "os._exit"}
# The names the core binds an argparse parser to. A host binding one to another
# name has its `.error()` read as a swallow: a false failure, never a missed one.
PARSERS = {"p", "ap", "parser"}


REPORTERS = ("fail_open", "tallied", "expected")
# The catch-alls `expected` may not take.
BROAD = {
    "Exception",
    "BaseException",
    "OSError",
    "IOError",
    "EnvironmentError",
    "os.error",
    "socket.error",
    "select.error",
}


def reporters(tree):
    """Each spelling that reaches a reporter from the `fail_open` module, to
    the reporter's name: `<name>` from a `from ... import`, `<alias>.<name>`
    from an `import`."""
    out = {}
    for n in ast.walk(tree):
        if (
            isinstance(n, ast.ImportFrom)
            and (n.module or "").split(".")[-1] == "fail_open"
        ):
            for a in n.names:
                if a.name in REPORTERS:
                    out[a.asname or a.name] = a.name
        if isinstance(n, ast.Import):
            for a in n.names:
                if a.name.split(".")[-1] == "fail_open":
                    for r in REPORTERS:
                        out[f"{a.asname or a.name}.{r}"] = r
    return out


def specific(handler):
    """The handler spells out each caught type as an `...Error` name, and
    none is a catch-all: a name bound to a tuple of types cannot be read."""
    if handler.type is None:
        return False
    types = handler.type.elts if isinstance(handler.type, ast.Tuple) else [handler.type]
    return all(
        isinstance(t, (ast.Name, ast.Attribute))
        and ast.unparse(t).endswith("Error")
        and ast.unparse(t) not in BROAD
        and ast.unparse(t).split(".")[-1] not in BROAD
        for t in types
    )


def reports(handler, names):
    """A statement of the handler's own body is `<reporter>(<bound>, ...)`,
    `expected` only where the handler is `specific`."""
    for stmt in handler.body:
        call = stmt.value if isinstance(stmt, ast.Expr) else None
        if (
            isinstance(call, ast.Call)
            and ast.unparse(call.func) in names
            and handler.name is not None
            and call.args
            and isinstance(call.args[0], ast.Name)
            and call.args[0].id == handler.name
            and (names[ast.unparse(call.func)] != "expected" or specific(handler))
        ):
            return True
    return False


def fails_loudly(handler, names):
    """Raises, exits, calls an argparse `.error`, hands its error to a
    reporter in its own body, or prints and returns a non-zero exit code."""
    if reports(handler, names):
        return True
    prints = any(
        isinstance(n, ast.Call) and ast.unparse(n.func) == "print"
        for n in ast.walk(handler)
    )
    for n in ast.walk(handler):
        if isinstance(n, ast.Raise):
            return True
        if isinstance(n, ast.Call):
            name = ast.unparse(n.func)
            if name in EXITS or (
                name.endswith(".error") and name.split(".")[0] in PARSERS
            ):
                return True
        if (
            prints
            and isinstance(n, ast.Return)
            and isinstance(n.value, ast.Constant)
            and type(n.value.value) is int
            and n.value.value != 0
        ):
            return True
    return False


def owners(tree):
    """Each handler's innermost enclosing function, and that function's dotted
    name through its enclosing functions and classes."""
    owner, names = {}, {}

    def visit(node, trail):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                inner = [*trail, child.name]
                if not isinstance(child, ast.ClassDef):
                    names[child] = ".".join(inner)
                visit(child, inner)
            else:
                visit(child, trail)

    visit(tree, [])
    for fn in names:
        for n in ast.walk(fn):
            if isinstance(n, ast.ExceptHandler):
                owner[n] = fn  # walk order is outer first, so inner wins
    return owner, names


def breaches(src):
    """`(line, function, caught)` for each handler that swallows; `function`
    is `<module>` outside one, `caught` `<bare>` for a bare `except:`."""
    tree = ast.parse(src)
    owner, names = owners(tree)
    via = reporters(tree)
    out = []
    for h in ast.walk(tree):
        if not isinstance(h, ast.ExceptHandler) or fails_loudly(h, via):
            continue
        caught = ast.unparse(h.type) if h.type else "<bare>"
        out.append((h.lineno, names.get(owner.get(h), "<module>"), caught))
    return sorted(out)


def main():
    req = json.load(sys.stdin)
    results = []
    for s in req["sources"]:
        try:
            found = breaches(s["text"])
        except SyntaxError as error:
            fail_open(error, f"{s['name']} not judged")
            results.append({"name": s["name"], "error": str(error)})
            continue
        results.append(
            {
                "name": s["name"],
                "breaches": [
                    {"line": n, "function": f, "caught": c} for n, f, c in found
                ],
            }
        )
    json.dump({"results": results}, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
