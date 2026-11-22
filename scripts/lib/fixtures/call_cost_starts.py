import os
import shutil
import subprocess
import sys

python = shutil.which("python3")
quiet = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}

subprocess.Popen([python, "--version"], **quiet).wait()
subprocess.run([python, "-V"], check=True, **quiet)
subprocess.run([python, "-E", "-c", "pass"], close_fds=False, check=True)
os.system(f"{python} -c pass")
os.waitpid(os.posix_spawn(python, [python, "-I", "-c", "pass"], os.environ), 0)
os.waitpid(os.posix_spawnp("python3", ["python3", "-S", "-c", "pass"], os.environ), 0)
subprocess.check_output(
    [
        python,
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "call_cost_child.py"),
    ]
)
sys.exit(0)
