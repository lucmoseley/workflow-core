"""swallowed_errors.py — base §N5 over Python source: an `except` raises,
exits, or hands the error it binds to `fail_open`, imported from the
`fail_open` module (`scripts/lib/fail_open.py`), in a statement of its own
body, so every path through the handler prints it (#1830, #5487).

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


def reporters(tree):
    """The spellings that reach `fail_open` from the `fail_open` module:
    `fail_open` from a `from ... import`, `<alias>.fail_open` from an `import`."""
    out = set()
    for n in ast.walk(tree):
        if (
            isinstance(n, ast.ImportFrom)
            and (n.module or "").split(".")[-1] == "fail_open"
        ):
            out |= {a.asname or a.name for a in n.names if a.name == "fail_open"}
        if isinstance(n, ast.Import):
            out |= {
                f"{a.asname or a.name}.fail_open"
                for a in n.names
                if a.name.split(".")[-1] == "fail_open"
            }
    return out


def reports(handler, names):
    """A statement of the handler's own body is `<reporter>(<bound>, ...)`."""
    for stmt in handler.body:
        call = stmt.value if isinstance(stmt, ast.Expr) else None
        if (
            isinstance(call, ast.Call)
            and ast.unparse(call.func) in names
            and handler.name is not None
            and call.args
            and isinstance(call.args[0], ast.Name)
            and call.args[0].id == handler.name
        ):
            return True
    return False


def fails_loudly(handler, names):
    """Raises, exits, calls an argparse `.error`, hands its error to
    `fail_open` in its own body, or prints and returns a non-zero exit code."""
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
