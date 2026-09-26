from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

import zstandard


NOW = "2026-08-21T12:00:00Z"


def epoch_ms(value: str) -> int:
    return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)


def session_path(home: Path, index: int = 1, *, workspace: str = "--workspace-project-a--") -> Path:
    return home / "sessions" / workspace / f"session-synthetic-{index:03d}" / "session.v4.jsonl.zstd"


def records(index: int = 1, *, cwd: str | None = "/workspace/project-a", secret: bool = True) -> list[dict]:
    source = Path(__file__).parent / 'fixtures' / 'synthetic-session.jsonl'
    rows = [json.loads(line) for line in source.read_text().splitlines()]
    rows[0].update(id=f"synthetic-{index}", cwd=cwd)
    if cwd is None: rows[0].pop('cwd')
    rows[3]['data']['content'][0]['text'] = f"Implement synthetic feature {index}"
    if secret: rows[3]['data']['content'][0]['text'] += " in /sensitive-home/person/project; api_key=sk-test-abcdefghijklmnopqrstuv"
    return rows


def compress_dsh_generation(lines: list[str]) -> bytes:
    """Encode one session generation with DSH's frame layout.

    DSH asserts that the first Zstandard frame is independently decodable and
    holds exactly the header record, so the header line gets its own frame and
    every event row follows in a second one. A single-frame file is not a log a
    real host will open.
    """
    compressor = zstandard.ZstdCompressor(level=3, write_checksum=True)
    header, events = lines[0], lines[1:]
    encoded = compressor.compress((header + "\n").encode("utf-8"))
    if events:
        encoded += compressor.compress(("\n".join(events) + "\n").encode("utf-8"))
    return encoded


def write_session(home: Path, index: int = 1, *, cwd: str | None = "/workspace/project-a", workspace: str = "--workspace-project-a--", secret: bool = True) -> Path:
    path = session_path(home, index, workspace=workspace)
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [json.dumps(item, ensure_ascii=False, sort_keys=True) for item in records(index, cwd=cwd, secret=secret)]
    path.write_bytes(compress_dsh_generation(lines))
    return path
