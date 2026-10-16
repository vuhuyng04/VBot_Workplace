"""Build Lambda zips for arm64 (Graviton) without Docker: pip downloads manylinux wheels.

  dist/app.zip      FastAPI app + SPA + quote summary (API Lambda and agent-step Lambdas)
  dist/sandbox.zip  code sandbox with pandas, openpyxl, matplotlib, docx, pptx
Usage: .venv/Scripts/python scripts/build.py
"""
import pathlib
import shutil
import subprocess
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
DIST, BUILD = ROOT / "dist", ROOT / "build"
PIP = [sys.executable, "-m", "pip", "install", "--quiet", "--platform", "manylinux2014_aarch64",
       "--implementation", "cp", "--python-version", "3.12", "--only-binary=:all:", "--upgrade"]


def pip_into(req: pathlib.Path, target: pathlib.Path):
    subprocess.run(PIP + ["-r", str(req), "--target", str(target)], check=True)
    for junk in target.rglob("__pycache__"):  # keep *.dist-info: packages read their own metadata
        shutil.rmtree(junk, ignore_errors=True)


def zipdir(src: pathlib.Path, out: pathlib.Path, exec_files=("run.sh",)):
    out.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for f in sorted(src.rglob("*")):
            if f.is_file():
                info = zipfile.ZipInfo(str(f.relative_to(src)).replace("\\", "/"), date_time=(2026, 1, 1, 0, 0, 0))
                info.external_attr = (0o755 if f.name in exec_files else 0o644) << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                z.writestr(info, f.read_bytes())
    print(f"{out.name}: {out.stat().st_size / 1e6:.1f} MB")


def build_app():
    b = BUILD / "app"
    shutil.rmtree(b, ignore_errors=True)
    pip_into(ROOT / "app" / "requirements.txt", b)
    shutil.copytree(ROOT / "app" / "vbot", b / "vbot", ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copytree(ROOT / "web", b / "vbot" / "web")
    import hashlib  # cache-busting: asset URLs change whenever their content changes
    h = hashlib.md5(b"".join((ROOT / "web" / "assets" / f).read_bytes() for f in ("app.js", "style.css")), usedforsecurity=False).hexdigest()[:10]
    idx = b / "vbot" / "web" / "index.html"
    idx.write_text(idx.read_text(encoding="utf-8").replace("__BUILD__", h), encoding="utf-8")
    shutil.copytree(ROOT / "app" / "migrations", b / "migrations")
    shutil.copy(ROOT / "quote" / "prices.json", b / "vbot" / "prices.json")
    shutil.copy(ROOT / "quote" / "out" / "summary.json", b / "vbot" / "quote_summary.json")
    (b / "run.sh").write_bytes((ROOT / "app" / "run.sh").read_bytes().replace(b"\r\n", b"\n"))
    zipdir(b, DIST / "app.zip")


def build_sandbox():
    b = BUILD / "sandbox"
    shutil.rmtree(b, ignore_errors=True)
    pip_into(ROOT / "sandbox" / "requirements.txt", b)
    shutil.copy(ROOT / "sandbox" / "handler.py", b / "handler.py")
    zipdir(b, DIST / "sandbox.zip")


if __name__ == "__main__":
    which = sys.argv[1:] or ["app", "sandbox"]
    if "app" in which:
        build_app()
    if "sandbox" in which:
        build_sandbox()
