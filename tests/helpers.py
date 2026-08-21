from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

import zstandard


NOW = "2026-08-21T12:00:00Z"


def epoch_ms(value: str) -> int:
    return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)


def session_path(home: Path, index: int = 1, *, workspace: str = "--workspace-project-a--") -> Path:
    return home / "sessions" / workspace / f"session-synthetic-{index:03d}" / "session.jsonl.zstd"


def records(index: int = 1, *, cwd: str | None = "/workspace/project-a", secret: bool = True) -> list[dict]:
    stamp = f"2026-08-{10 + index:02d}T10:00:00Z"
    prompt = f"Implement synthetic feature {index}"
    if secret:
        prompt += " in /sensitive-home/person/project; api_key=sk-test-abcdefghijklmnopqrstuv"
    header = {
        "type": "session", "version": 0, "id": f"synthetic-{index}",
        "createdAt": epoch_ms(stamp), "agentPreset": "standard",
    }
    if cwd is not None:
        header["cwd"] = cwd
    return [
        header,
        {"type": "turn/start", "time": epoch_ms(stamp), "data": {"turn": 1}},
        {"type": "user/message", "time": epoch_ms(stamp), "data": {"content": [{"type": "text", "text": prompt}]}},
        {"type": "assistant/message", "time": epoch_ms(stamp), "data": {
            "turn": 1, "step": 1,
            "usage": {"inputTokens": 120, "outputTokens": 40, "reasoningTokens": 20, "cacheReadTokens": 300},
            "message": {"role": "assistant", "source": {"kind": "model", "provider": "synthetic-provider", "model": "synthetic-model"},
                        "content": [{"type": "text", "text": "Implemented the bounded change."}]},
        }},
        {"type": "tool/call", "time": epoch_ms(stamp), "data": {"turn": 1, "step": 1, "callId": f"call-{index}", "name": "bash", "arguments": json.dumps({"command": "python -m unittest"})}},
        {"type": "tool/result", "time": epoch_ms(stamp), "data": {"turn": 1, "step": 1, "callId": f"call-{index}",
            "message": {"source": {"kind": "tool", "callId": f"call-{index}"}, "content": [{"type": "tool-result", "toolCallId": f"call-{index}", "isError": False, "content": [{"type": "text", "text": "Ran synthetic tests: OK"}]}]}}},
        {"type": "user/message", "time": epoch_ms(stamp), "data": {"content": [{"type": "text", "text": "Keep the change narrow and report evidence."}]}},
        {"type": "session/title", "time": epoch_ms(stamp), "data": {"title": f"Synthetic task {index}", "source": {"kind": "provider"}}},
        {"type": "turn/end", "time": epoch_ms(stamp) + 3000, "data": {"turn": 1, "reason": {"kind": "completed"}}},
    ]


def write_session(home: Path, index: int = 1, *, cwd: str | None = "/workspace/project-a", workspace: str = "--workspace-project-a--", secret: bool = True) -> Path:
    path = session_path(home, index, workspace=workspace)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = "\n".join(json.dumps(item, ensure_ascii=False, sort_keys=True) for item in records(index, cwd=cwd, secret=secret)).encode("utf-8")
    path.write_bytes(zstandard.ZstdCompressor(level=3, write_checksum=True).compress(payload))
    return path
