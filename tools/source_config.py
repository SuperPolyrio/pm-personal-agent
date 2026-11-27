"""Read shared source settings with the project's dotenv parser."""

import json
from pathlib import Path
from subprocess import check_output


def source_settings(*names):
    root = Path(__file__).resolve().parent.parent
    return json.loads(check_output([
        "node", "--env-file=.env.example", "--env-file-if-exists=.env", "-e",
        "console.log(JSON.stringify(Object.fromEntries(process.argv.slice(1).map(k => [k, process.env[k]]))))",
        *names,
    ], cwd=root, text=True))
