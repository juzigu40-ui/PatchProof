import json
import os

from calculator import add

if add(2, 2) != 4:
    print("bug reproduced")
    print(json.dumps({"nonce": os.environ.get("PATCHPROOF_NONCE"), "status": "assertion_failed"}))
    raise SystemExit(1)

print(json.dumps({"nonce": os.environ.get("PATCHPROOF_NONCE"), "status": "assertion_passed"}))
