#!/usr/bin/env python3
"""Deterministically build and audit the synthetic compressed session fixture."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import sys
from pathlib import Path

import zstandard


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "tests" / "fixtures" / "synthetic-session.jsonl"
TARGET = ROOT / "tests" / "fixtures" / "session.jsonl.zstd"


def compress_generation(lines: list[str]) -> bytes:
    """Encode one session generation the way DSH writes it.

    DSH requires the first Zstandard frame to be independently decodable and to
    contain exactly the header record: persistence asserts
    `plaintext.indexOf(0x0a) === plaintext.length - 1` on that frame and rejects
    the artifact otherwise. Every event row therefore goes into a second frame.
    A single-frame file is readable by tolerant readers but is not a log a real
    host will open.
    """
    compressor = zstandard.ZstdCompressor(level=19, write_checksum=True, write_content_size=True)
    header, events = lines[0], lines[1:]
    encoded = compressor.compress((header + "\n").encode("utf-8"))
    if events:
        encoded += compressor.compress(("\n".join(events) + "\n").encode("utf-8"))
    return encoded


def decode_generation(data: bytes) -> bytes:
    """Decode every frame of one generation, not only the first."""
    return zstandard.ZstdDecompressor().stream_reader(io.BytesIO(data)).read()


def assert_header_frame(data: bytes) -> None:
    """Fail closed when the first frame is not exactly one header line."""
    frames = frames_of(data)
    if not frames:
        raise ValueError("compressed fixture has no Zstandard frame")
    first = zstandard.ZstdDecompressor().decompressobj().decompress(
        data[frames[0] : frames[1] if len(frames) > 1 else len(data)]
    )
    if not first or first.count(b"\n") != 1 or not first.endswith(b"\n"):
        raise ValueError("first Zstandard frame is not exactly one header line")


def frames_of(data: bytes) -> list[int]:
    """Offsets of every Zstandard frame magic in `data`."""
    magic = b"\x28\xb5\x2f\xfd"
    offsets: list[int] = []
    index = 0
    while index + 4 <= len(data):
        if data[index : index + 4] == magic:
            offsets.append(index)
            index += 4
        else:
            index += 1
    return offsets


def payload() -> bytes:
    text = SOURCE.read_text(encoding="utf-8")
    lines = text.splitlines()
    for line_number, line in enumerate(lines, 1):
        value = json.loads(line)
        if not isinstance(value, dict) or not isinstance(value.get("type"), str):
            raise ValueError(f"invalid synthetic record at line {line_number}")
    forbidden = ("/Users/", "api_key=", "Bearer ", "BEGIN PRIVATE KEY", "session_meta")
    hit = next((item for item in forbidden if item in text), None)
    if hit:
        raise ValueError(f"fixture source contains forbidden content: {hit}")
    if "synthetic" not in text.casefold():
        raise ValueError("fixture must identify itself as synthetic")
    if not lines or json.loads(lines[0]).get("type") != "session":
        raise ValueError("fixture source must start with the session header record")
    return compress_generation(lines)


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
    # The header-frame rule is part of the contract, so verify it rather than
    # only checking that the bytes round-trip.
    assert_header_frame(built)
    expected = ("\n".join(SOURCE.read_text(encoding="utf-8").splitlines()) + "\n").encode("utf-8")
    if decode_generation(built) != expected:
        raise ValueError("compressed fixture round-trip mismatch")
    print(hashlib.sha256(built).hexdigest())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
