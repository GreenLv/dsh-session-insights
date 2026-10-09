#!/usr/bin/env python3
"""Wrap a verified, published npm Bundle in an Agensi skill ZIP without changing it."""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import tarfile
import zipfile


ROOT = Path(__file__).resolve().parents[1]
NAME = "dsh-session-insights"
VERSION = "0.5.2"


def build(tarball: Path, registry_metadata: Path, output_dir: Path) -> dict:
    metadata = json.loads(registry_metadata.read_text(encoding="utf-8"))
    if metadata.get("name") != NAME or metadata.get("version") != VERSION:
        raise ValueError("expected the published dsh-session-insights 0.5.2 metadata")
    raw = tarball.read_bytes()
    distribution = metadata["dist"]
    if hashlib.sha1(raw).hexdigest() != distribution["shasum"]:
        raise ValueError("npm SHA-1 mismatch")
    integrity = "sha512-" + base64.b64encode(hashlib.sha512(raw).digest()).decode("ascii")
    if integrity != distribution["integrity"]:
        raise ValueError("npm SHA-512 integrity mismatch")

    files: dict[str, bytes] = {}
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as archive:
        for member in archive.getmembers():
            path = PurePosixPath(member.name)
            if path.is_absolute() or ".." in path.parts or path.parts[:1] != ("package",):
                raise ValueError("unsafe package path")
            if member.isdir():
                continue
            if not member.isfile():
                raise ValueError("package links and special files are not supported")
            name = path.relative_to("package").as_posix()
            if name in files or member.size > 4 * 1024 * 1024:
                raise ValueError("duplicate or oversized package member")
            stream = archive.extractfile(member)
            if stream is None:
                raise ValueError("unreadable package member")
            files[name] = stream.read()
    if len(files) != distribution["fileCount"] or sum(map(len, files.values())) > 4 * 1024 * 1024:
        raise ValueError("unexpected package file count or total size")
    package = json.loads(files["package.json"])
    if package["name"] != NAME or package["version"] != VERSION or package["license"] != "MIT":
        raise ValueError("unexpected Bundle identity or license")
    if package.get("gitHead") != metadata.get("gitHead"):
        raise ValueError("Bundle source identity mismatch")
    for required in ("LICENSE", "README.md", "cordis.patch.yml", "plugin/lib/index.js"):
        if required not in files:
            raise ValueError(f"missing Bundle file: {required}")

    source_hashes = {name: hashlib.sha256(value).hexdigest() for name, value in files.items()}
    files["SKILL.md"] = (ROOT / "marketplace/agensi/SKILL.md").read_bytes()
    screenshot = "assets/screenshots/dashboard-overview-en.png"
    files[screenshot] = (ROOT / screenshot).read_bytes()
    output_dir.mkdir(parents=True, exist_ok=True)
    destination = output_dir / f"{NAME}-{VERSION}-agensi.zip"
    if destination.exists():
        raise FileExistsError(destination)
    with zipfile.ZipFile(destination, mode="x", compression=zipfile.ZIP_DEFLATED) as archive:
        # Put the marketplace entry first for uploaders that choose the first SKILL.md.
        for name in ["SKILL.md", *sorted(set(files) - {"SKILL.md"})]:
            info = zipfile.ZipInfo(f"{NAME}/{name}", date_time=(2026, 10, 9, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, files[name])
    with zipfile.ZipFile(destination) as archive:
        if archive.testzip() is not None:
            raise ValueError("ZIP CRC check failed")
        for name, expected in files.items():
            if archive.read(f"{NAME}/{name}") != expected:
                raise ValueError(f"ZIP readback mismatch: {name}")
    receipt = {
        "schema": "dsh-session-insights/agensi-package/1",
        "name": NAME,
        "version": VERSION,
        "gitHead": metadata["gitHead"],
        "source_tarball_url": distribution["tarball"],
        "source_tarball_sha256": hashlib.sha256(raw).hexdigest(),
        "source_file_sha256": source_hashes,
        "zip": destination.name,
        "zip_sha256": hashlib.sha256(destination.read_bytes()).hexdigest(),
        "zip_size_bytes": destination.stat().st_size,
        "file_count": len(files),
        "added_files": ["SKILL.md", screenshot],
        "published_bundle_files_unchanged": True,
    }
    (output_dir / "package-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    return receipt


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tarball", required=True, type=Path)
    parser.add_argument("--registry-metadata", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    arguments = parser.parse_args()
    receipt = build(arguments.tarball, arguments.registry_metadata, arguments.output_dir)
    print(json.dumps({k: receipt[k] for k in ("zip", "zip_sha256", "zip_size_bytes", "file_count", "published_bundle_files_unchanged")}))


if __name__ == "__main__":
    main()
