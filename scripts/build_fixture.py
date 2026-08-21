#!/usr/bin/env python3
"""Deterministically build and audit the synthetic compressed session fixture."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import zstandard


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "tests" / "fixtures" / "synthetic-session.jsonl"
TARGET = ROOT / "tests" / "fixtures" / "session.jsonl.zstd"


def payload() -> bytes:
    raw = SOURCE.read_bytes()
    for line_number, line in enumerate(raw.decode("utf-8").splitlines(), 1):
        value = json.loads(line)
        if not isinstance(value, dict) or not isinstance(value.get("type"), str):
            raise ValueError(f"invalid synthetic record at line {line_number}")
    text = raw.decode("utf-8")
    forbidden = ("/Users/", "api_key=", "Bearer ", "BEGIN PRIVATE KEY", "session_meta")
    hit = next((item for item in forbidden if item in text), None)
    if hit:
        raise ValueError(f"fixture source contains forbidden content: {hit}")
    if "synthetic" not in text.casefold():
        raise ValueError("fixture must identify itself as synthetic")
    return zstandard.ZstdCompressor(level=19, write_checksum=True, write_content_size=True).compress(raw)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    built = payload()
    if args.check:
        if not TARGET.is_file() or TARGET.read_bytes() != built:
            print("compressed fixture is stale", file=sys.stderr)
            return 1
    else:
        TARGET.write_bytes(built)
    decoded = zstandard.ZstdDecompressor().decompress(built)
    if decoded != SOURCE.read_bytes():
        raise ValueError("compressed fixture round-trip mismatch")
    print(hashlib.sha256(built).hexdigest())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
