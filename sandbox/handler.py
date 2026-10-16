"""VBot code sandbox (Lambda = Firecracker microVM).

Isolation layers:
- Network: function sits in isolated subnets; its security group only allows HTTPS to the
  S3 prefix list (presigned input URLs). No Internet, no VPC peers, no metadata service.
- Identity: the execution role has no data permissions; AWS credentials are removed from
  the child process environment; inputs arrive as short-lived presigned URLs for one user.
- Resources: per-run CPU-time / memory / file-size limits and a wall-clock timeout.
- Lifecycle: every run gets a fresh directory that is wiped afterwards; leftover processes are killed.
"""
import base64
import os
import pathlib
import resource
import shutil
import subprocess
import sys
import urllib.request
import uuid

MAX_OUTPUT_BYTES = 5 * 1024 * 1024
MAX_STDIO = 20000
SAFE_ENV = {"PATH": "/var/lang/bin:/usr/local/bin:/usr/bin:/bin", "HOME": "/tmp", "LANG": "C.UTF-8",
            "MPLBACKEND": "Agg", "PYTHONDONTWRITEBYTECODE": "1", "PYTHONPATH": os.environ.get("LAMBDA_TASK_ROOT", "/var/task")}


def _limits(timeout_s: int):
    def apply():
        os.setsid()
        resource.setrlimit(resource.RLIMIT_CPU, (timeout_s, timeout_s))
        resource.setrlimit(resource.RLIMIT_FSIZE, (200 * 1024 * 1024, 200 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))
    return apply


def handler(event, _ctx):
    run = pathlib.Path("/tmp") / f"run-{uuid.uuid4().hex}"
    work, out = run / "work", run / "out"
    work.mkdir(parents=True)
    out.mkdir()
    try:
        for f in event.get("inputs", [])[:10]:
            name = pathlib.Path(f["name"]).name
            with urllib.request.urlopen(f["url"], timeout=20) as r:
                (work / name).write_bytes(r.read(50 * 1024 * 1024))
        (run / "main.py").write_text(event["code"], encoding="utf-8")
        timeout_s = min(int(event.get("timeout_s", 60)), 240)
        env = dict(SAFE_ENV, OUTPUT_DIR=str(out), INPUT_DIR=str(work))
        try:
            p = subprocess.run([sys.executable, "-s", str(run / "main.py")], cwd=work, env=env, capture_output=True,
                               timeout=timeout_s, preexec_fn=_limits(timeout_s))
            code, so, se = p.returncode, p.stdout, p.stderr
        except subprocess.TimeoutExpired as e:
            code, so, se = -9, e.stdout or b"", (e.stderr or b"") + f"\n[timeout {timeout_s}s]".encode()
        files, total = [], 0
        for path in sorted(out.rglob("*")):
            if path.is_file():
                data = path.read_bytes()
                total += len(data)
                if total > MAX_OUTPUT_BYTES:
                    se += b"\n[output files truncated: 5 MB limit]"
                    break
                files.append({"name": path.name, "b64": base64.b64encode(data).decode()})
        return {"exit_code": code, "stdout": so.decode(errors="replace")[-MAX_STDIO:],
                "stderr": se.decode(errors="replace")[-MAX_STDIO:], "files": files}
    finally:
        try:  # kill anything the user code left running in the background
            subprocess.run(["pkill", "-9", "-f", str(run)], capture_output=True, timeout=5)
        except Exception:
            pass
        shutil.rmtree(run, ignore_errors=True)
