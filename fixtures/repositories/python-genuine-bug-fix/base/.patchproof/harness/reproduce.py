import json
import os
import subprocess
import sys

challenge = json.loads(os.read(3, 4096).decode("utf-8"))
target = subprocess.run(
    [
        sys.executable,
        "-c",
        "from calculator import add; raise SystemExit(0 if add(2, 2) == 4 else 1)",
    ],
    cwd=os.getcwd(),
    env={"PATH": os.environ.get("PATH", "")},
)
status = "assertion_passed" if target.returncode == 0 else "assertion_failed"

if status == "assertion_failed":
    print("bug reproduced")

os.write(4, (json.dumps({"nonce": challenge["nonce"], "status": status}) + "\n").encode("utf-8"))
raise SystemExit(0 if status == "assertion_passed" else 1)
