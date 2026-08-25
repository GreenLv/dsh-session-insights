#!/usr/bin/env python3
"""Build an evidence-backed local insights report from DeepSeek Harness sessions."""

from __future__ import annotations

import argparse
import hashlib
import importlib
import importlib.resources
import json
import math
import os
import re
import statistics
import sys
import webbrowser
from collections import Counter, defaultdict
from dataclasses import dataclass, replace
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path, PureWindowsPath
from typing import Any, Iterable
from urllib.parse import urlsplit, urlunsplit


SCHEMA_VERSION = 1
SCHEMA_ID = "dsh-session-insights/1"
ANALYZER_VERSION = "0.2.2"
FAILURE_RULE_VERSION = "5.0.0"
DETERMINISTIC_CACHE_VERSION = 1
ROLE_NAMES = ("root_task", "task_subagent", "action_reviewer", "unknown_system_rollout")
DSH_KNOWN_RECORD_TYPES = {
    "session",
    "permission/preset",
    "sandbox/mode",
    "approval/policy",
    "session/end-seed",
    "agent/inbox/spliced",
    "turn/start",
    "turn/end",
    "step/start",
    "step/end",
    "user/message",
    "assistant/message",
    "assistant/chunk",
    "tool/call",
    "tool/result",
    "request/header",
    "request/context",
    "approval/asked",
    "approval/decided",
    "llm/retry",
    "llm/retry-started",
    "todo/write",
    "session/title",
    "session/title-llm-request",
    "plan/mode",
    "command/run",
    "command/done",
    "agent-preset/selected",
    "subagent/descriptor",
    "goal/change",
    "web/deepseek-search-llm-request",
    "reasoning-chunks",
    "tool-call-chunks",
    "text-chunks",
}
DSH_SENSITIVE_BLOCK_RE = re.compile(
    r"<(?P<tag>skill_content|system-reminder|available_skills)\b[^>]*>"
    r"(?:.*?</(?P=tag)>|.*)",
    re.IGNORECASE | re.DOTALL,
)
DSH_SANDBOX_DENIED_RE = re.compile(
    r"\[sandbox:\s*file access denied under\s+[^]]+\s+mode\]",
    re.IGNORECASE,
)
DSH_USER_REJECTED_RE = re.compile(
    r"user rejected escalating|approval (?:was )?rejected",
    re.IGNORECASE,
)
TOKEN_KEYS = (
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
)
TOKEN_KEYS_WITH_DERIVED = (*TOKEN_KEYS, "uncached_input_tokens")
SENSITIVE_BLOCK_RE = re.compile(
    r"<(?:environment_context|permissions instructions|skills_instructions|apps_instructions)\b[^>]*>.*?</(?:environment_context|permissions instructions|skills_instructions|apps_instructions)>",
    re.IGNORECASE | re.DOTALL,
)
FENCED_CODE_RE = re.compile(r"```.*?```", re.DOTALL)
EMAIL_RE = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE)
UUID_RE = re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b", re.IGNORECASE)
HOME_UNIX_RE = re.compile(r"/(?:Users|home)/[^/\s]+")
HOME_WINDOWS_RE = re.compile(r"\b[A-Za-z]:\\Users\\[^\\\s]+", re.IGNORECASE)
ABS_UNIX_PATH_RE = re.compile(r"(?<![:/\w])/(?:[^/\s]+/)+[^/\s,;:)\]]+")
ABS_WINDOWS_PATH_RE = re.compile(r"\b[A-Za-z]:\\(?:[^\\\s]+\\)+[^\\\s,;:)\]]+")
BEARER_RE = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{8,}")
NAMED_SECRET_RE = re.compile(
    r"(?i)\b(api[_-]?key|access[_-]?token|auth[_-]?token|secret|password)\b\s*[:=]\s*['\"]?[^\s'\",;]{4,}"
)
KNOWN_SECRET_RE = re.compile(
    r"\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b"
)
LONG_TOKEN_RE = re.compile(r"\b(?=[A-Za-z0-9+/=]{32,}\b)(?=[A-Za-z0-9+/=]*[A-Za-z])(?=[A-Za-z0-9+/=]*\d)[A-Za-z0-9+/=]+\b")
CORRECTION_RE = re.compile(
    r"(?:\b(?:no|not that|instead|wrong|stop|actually|rather than|misunderstood)\b|不要|不是这样|不对|错了|改为|重新|你误解|别这样)",
    re.IGNORECASE,
)
PERMISSION_RE = re.compile(
    r"(?:permission denied|operation not permitted|approval (?:required|denied)|not allowed|access denied|outside (?:the )?sandbox|sandbox(?:ed)? (?:denied|blocked|violation|restriction)|requires escalated permissions)",
    re.IGNORECASE,
)
EXIT_CODE_RE = re.compile(
    r"(?:exit[_ ]code|exited with code|process exited with code)\D{0,8}(-?\d+)",
    re.IGNORECASE,
)
RUNTIME_EXIT_LINE_RE = re.compile(r"^(?:Process exited with code|Exit code:|exit_code\s*[:=])\s*(-?\d+)\s*$", re.IGNORECASE)
RUNTIME_SUCCESS_LINE_RE = re.compile(r"^(?:Script completed|Command completed)$")
RUNTIME_FAILURE_LINE_RE = re.compile(r"^(?:Script failed|Command failed)$", re.IGNORECASE)
WALL_TIME_LINE_RE = re.compile(r"^Wall time\s+([0-9]+(?:\.[0-9]+)?)\s+seconds$", re.IGNORECASE)
TOOL_EVIDENCE_LINE_RE = re.compile(
    r"(?:^Ran\s+\d+\s+tests?\b|\b\d+\s+(?:passed|failed|errors?|skipped)\b|"
    r"\b(?:tests?|validation|doctor|smoke|audit|check)\b.{0,100}\b(?:passed|failed|success|complete)\b|"
    r"\b\d+\s+files? changed\b|^\[[^]\r\n]+\s+[0-9a-f]{7,40}\]|"
    r"^(?:HEAD|origin/main|remote/main)=|^(?:Script|Command) (?:completed|failed)$)",
    re.IGNORECASE,
)
TEXT_ERROR_RULES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("shell_syntax", re.compile(r"^(?:ParserError|SyntaxError)(?::.*)?$", re.IGNORECASE)),
    ("encoding_locale", re.compile(r"^Unicode(?:Encode|Decode|Translate)?Error(?::.*)?$", re.IGNORECASE)),
    ("other", re.compile(r"^Traceback \(most recent call last\):$")),
    ("missing_dependency", re.compile(r"^(?:ModuleNotFoundError|ImportError)(?::.*)?$", re.IGNORECASE)),
)
FAILURE_CAUSE_RULES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("permission_boundary", re.compile(r"(?:permission denied|operation not permitted|access is denied|outside (?:the )?sandbox|requires escalated permissions|EACCES)", re.IGNORECASE)),
    ("timeout", re.compile(r"(?:timed? out|timeout expired|TimeoutExpired)", re.IGNORECASE)),
    ("missing_dependency", re.compile(r"(?:ModuleNotFoundError|No module named|command not found|is not recognized as the name)", re.IGNORECASE)),
    ("encoding_locale", re.compile(r"(?:Unicode(?:Encode|Decode|Translate)?Error|codec can't encode|invalid utf-?8)", re.IGNORECASE)),
    ("shell_syntax", re.compile(r"(?:ParserError|SyntaxError|unexpected token|parse error)", re.IGNORECASE)),
    ("missing_path", re.compile(r"(?:cannot find path|no such file or directory|path does not exist|找不到路径)", re.IGNORECASE)),
    ("network_auth", re.compile(r"(?:authentication failed|permission denied \(publickey\)|could not resolve host|connection refused|proxy error|HTTP (?:401|403|407))", re.IGNORECASE)),
    ("test_validation", re.compile(r"(?:\bFAILED\b|tests? failed|validation failed|doctor.*failure)", re.IGNORECASE)),
)
USER_ACCEPTANCE_RE = re.compile(
    r"^\s*(?:验收通过|我接受(?:这个)?结果|结果可以|通过验收|accepted|i accept(?: this result)?|looks good)\s*[。.!！]?\s*$",
    re.IGNORECASE,
)
CONTENT_DUMP_COMMAND_RE = re.compile(
    r"(?:Get-Content|Select-String|\brg\b|\bgrep\b|\bcat\b|\btype\b|sed\s+-n\b|\bhead\b|\btail\b)",
    re.IGNORECASE,
)
DIAGNOSTIC_COMMAND_RE = re.compile(
    r"(?:\b(?:Test-Path|Get-Command|where\.exe|git\s+diff\s+--quiet|git\s+rev-parse|rg\b|grep\b|Select-String)\b)",
    re.IGNORECASE,
)
VERIFICATION_COMMAND_RE = re.compile(
    r"(?:\b(?:pytest|unittest)\b|\bpython(?:\.exe)?\b[^\r\n]{0,200}\b(?:test|validate|doctor|smoke|audit|check)[\w.-]*\.py\b|\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b|\b(?:validate|doctor|smoke|audit|check)[\w.-]*(?:\.py|\.ps1|\.sh)?\b)",
    re.IGNORECASE,
)
STATE_CHANGE_COMMAND_RE = re.compile(
    r"(?:\b(?:apply_patch|install|pip\s+install|npm\s+install|git\s+(?:pull|fetch|merge|rebase)|New-Item|Set-Content|Copy-Item|Move-Item|Remove-Item|mkdir|touch)\b)",
    re.IGNORECASE,
)
FILE_EXTENSION_RE = re.compile(r"(?i)(?:^|[\\/\s\"'])[^\s\"']+\.([a-z0-9]{1,10})(?=$|[\s\"',:;)}\]])")
COMMON_FILE_EXTENSIONS = {
    "bib", "c", "cc", "cpp", "css", "csv", "docx", "gradle", "go", "h", "hpp", "html", "java", "jpeg", "jpg",
    "js", "json", "jsonl", "jsx", "kt", "log", "md", "pdf", "png", "pptx", "properties", "ps1", "py", "rs", "sh",
    "sql", "svg", "swift", "tex", "toml", "ts", "tsx", "txt", "xml", "xlsx", "yaml", "yml", "zip", "zsh",
}
SKILL_MENTION_RE = re.compile(r"(?<![\w-])\$([a-z0-9]+(?:-[a-z0-9]+)+)(?![\w-])", re.IGNORECASE)

WORK_AREA_RULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("research_writing", ("paper", "manuscript", "reviewer", "latex", "abstract", "introduction", "论文", "稿件", "投稿", "审稿", "章节")),
    ("experiments_data", ("experiment", "dataset", "analysis", "metric", "csv", "benchmark", "实验", "数据", "分析", "指标", "结果")),
    ("skills_configuration", ("skill", "plugin", "mcp", "agents.md", "dsh", "config", "技能", "插件", "配置", "同步")),
    ("documents_presentations", ("docx", "document", "ppt", "slide", "pdf", "report", "文档", "报告", "幻灯片", "演示", "验收", "合同", "材料")),
    ("software_engineering", ("code", "bug", "test", "implement", "refactor", "build", "api", "代码", "实现", "修复", "测试", "重构", "开发")),
    ("web_sites", ("website", "html", "css", "jekyll", "frontend", "page", "网页", "网站", "前端", "页面", "主页")),
)


@dataclass(frozen=True)
class AnalysisConfig:
    dsh_home: Path
    since: datetime
    until: datetime
    project: str | None = None
    privacy_mode: str = "redacted"
    metrics_only: bool = False
    max_excerpts: int = 80
    max_excerpt_chars: int = 800
    generated_at: datetime | None = None
    semantic_capture: bool = False
    analysis_privacy_mode: str | None = None
    analysis_depth: str = "evidence"
    deterministic_cache: bool = True
    refresh_deterministic_cache: bool = False
    locale: str = "zh-CN"


def parse_datetime(value: str, *, end_of_day: bool = False) -> datetime:
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        parsed_date = date.fromisoformat(text)
        parsed = datetime.combine(parsed_date, time.max if end_of_day else time.min)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def parse_dsh_timestamp(value: Any) -> datetime | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        return datetime.fromtimestamp(value / 1000, tz=timezone.utc)
    except (OverflowError, OSError, ValueError):
        return None


def strip_dsh_sensitive_blocks(text: str) -> str:
    """Remove DSH-injected blocks, including unterminated openings."""
    value = text
    for _ in range(8):
        value, count = DSH_SENSITIVE_BLOCK_RE.subn(" [context omitted] ", value)
        if count == 0:
            return value
    return re.sub(
        r"<(?:skill_content|system-reminder|available_skills)\b[^>]*>.*",
        " [context omitted] ",
        value,
        flags=re.IGNORECASE | re.DOTALL,
    )


def dsh_project_key(cwd: str) -> str:
    """Mirror DSH's lossy human-readable project directory key."""
    if not cwd:
        return "_no-cwd"
    readable = ""
    separator_run = False
    for char in cwd:
        if char in "/\\:":
            if not separator_run:
                readable += "-"
            separator_run = True
        elif char != "~" and (char.isascii() and (char.isalnum() or char in "._-")):
            readable += char
            separator_run = False
        else:
            readable += "~" + format(ord(char), "04X").upper()
            separator_run = False
    body = readable.lstrip("-") or "root"
    return "--" + body[:251] + "--"


def decode_dsh_workspace_key(value: str | None) -> str | None:
    """Best-effort inverse of DSH's lossy projectKey.

    DSH collapses every separator run to a single ``-``, so literal hyphens in
    path components are not recoverable without the session header. Callers
    must prefer ``session.cwd``; this decoder is only a project-filter fallback.
    """
    if not value:
        return None
    body = value.strip()
    if body.startswith("--"):
        body = body[2:]
    if body.endswith("--"):
        body = body[:-2]
    if not body or body == "_no-cwd":
        return None
    parts = [part for part in body.split("-") if part]
    if not parts:
        return None
    if len(parts[0]) == 1:
        return parts[0] + ":/" + "/".join(parts[1:])
    return "/" + "/".join(parts)


def matches_dsh_project(cwd: str | None, workspace_key: str | None, requested: str | None) -> bool:
    if not requested:
        return True
    actuals: list[str] = []
    if cwd:
        actuals.append(cwd)
    if not cwd and workspace_key:
        decoded = decode_dsh_workspace_key(workspace_key)
        if decoded:
            actuals.append(decoded)
    for actual in actuals:
        if matches_project(actual, requested):
            return True
    if workspace_key and dsh_project_key(requested).casefold() == workspace_key.casefold():
        return True
    return False


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, math.ceil(fraction * len(ordered)) - 1))
    return float(ordered[index])


def safe_round(value: float, digits: int = 2) -> float:
    return round(value, digits)


def english_count(value: int | float, singular: str, plural: str | None = None) -> str:
    return f"{value} {singular if value == 1 else (plural or singular + 's')}"


def strip_url_queries(text: str) -> str:
    url_re = re.compile(r"https?://[^\s<>\]\[\)\(]+", re.IGNORECASE)

    def replace(match: re.Match[str]) -> str:
        raw = match.group(0)
        trailing = ""
        while raw and raw[-1] in ".,;:!?":
            trailing = raw[-1] + trailing
            raw = raw[:-1]
        parts = urlsplit(raw)
        if not parts.query and not parts.fragment:
            return raw + trailing
        return urlunsplit((parts.scheme, parts.netloc, parts.path, "<redacted-query>", "")) + trailing

    return url_re.sub(replace, text)


def redact_text(text: str, max_chars: int = 600) -> str:
    value = strip_dsh_sensitive_blocks(SENSITIVE_BLOCK_RE.sub(" [context omitted] ", text))
    value = FENCED_CODE_RE.sub(" [code omitted] ", value)
    value = strip_url_queries(value)
    value = BEARER_RE.sub("Bearer <redacted>", value)
    value = NAMED_SECRET_RE.sub(lambda match: f"{match.group(1)}=<redacted>", value)
    value = KNOWN_SECRET_RE.sub("<redacted-secret>", value)
    value = EMAIL_RE.sub("<redacted-email>", value)
    value = UUID_RE.sub("<id>", value)
    value = HOME_UNIX_RE.sub("~", value)
    value = HOME_WINDOWS_RE.sub("~", value)
    value = ABS_UNIX_PATH_RE.sub("<path>", value)
    value = ABS_WINDOWS_PATH_RE.sub("<path>", value)
    value = LONG_TOKEN_RE.sub("<redacted-token>", value)
    value = re.sub(r"\s+", " ", value).strip()
    if len(value) > max_chars:
        value = value[: max(0, max_chars - 1)].rstrip() + "…"
    return value


def local_text(text: str, max_chars: int = 800) -> str:
    """Keep useful local context while always removing credential-like content."""
    value = strip_dsh_sensitive_blocks(SENSITIVE_BLOCK_RE.sub(" [context omitted] ", text))
    value = FENCED_CODE_RE.sub(" [code omitted] ", value)
    value = strip_url_queries(value)
    value = BEARER_RE.sub("Bearer <redacted>", value)
    value = NAMED_SECRET_RE.sub(lambda match: f"{match.group(1)}=<redacted>", value)
    value = KNOWN_SECRET_RE.sub("<redacted-secret>", value)
    value = LONG_TOKEN_RE.sub("<redacted-token>", value)
    value = re.sub(r"\s+", " ", value).strip()
    if len(value) > max_chars:
        value = value[: max(0, max_chars - 1)].rstrip() + "…"
    return value


def excerpt_text(text: str, config: AnalysisConfig, max_chars: int | None = None) -> str:
    limit = max_chars or config.max_excerpt_chars
    if config.privacy_mode == "redacted":
        return redact_text(text, limit)
    return local_text(text, limit)


def analysis_privacy(config: AnalysisConfig) -> str:
    return config.analysis_privacy_mode or config.privacy_mode


def analysis_text(text: str, config: AnalysisConfig, max_chars: int = 800) -> str:
    """Sanitize text for model analysis independently from report output privacy."""
    if analysis_privacy(config) == "redacted":
        return redact_text(text, max_chars)
    return local_text(text, max_chars)


def deterministic_cache_home(config: AnalysisConfig) -> Path:
    return session_source_root(config) / "insights" / "cache" / f"deterministic-{DETERMINISTIC_CACHE_VERSION}"


def cache_encode(value: Any) -> Any:
    if isinstance(value, datetime):
        return {"__cache_type__": "datetime", "value": value.isoformat()}
    if isinstance(value, Counter):
        return {
            "__cache_type__": "counter",
            "items": [[cache_encode(key), cache_encode(item)] for key, item in value.items()],
        }
    if isinstance(value, set):
        return {"__cache_type__": "set", "items": [cache_encode(item) for item in sorted(value, key=str)]}
    if isinstance(value, dict):
        if all(isinstance(key, str) for key in value):
            return {key: cache_encode(item) for key, item in value.items()}
        return {
            "__cache_type__": "mapping",
            "items": [[cache_encode(key), cache_encode(item)] for key, item in value.items()],
        }
    if isinstance(value, tuple):
        return {"__cache_type__": "tuple", "items": [cache_encode(item) for item in value]}
    if isinstance(value, list):
        return [cache_encode(item) for item in value]
    return value


def cache_decode(value: Any) -> Any:
    if isinstance(value, list):
        return [cache_decode(item) for item in value]
    if not isinstance(value, dict):
        return value
    cache_type = value.get("__cache_type__")
    if cache_type == "datetime":
        return parse_datetime(value["value"])
    if cache_type == "counter":
        return Counter({cache_decode(key): cache_decode(item) for key, item in value["items"]})
    if cache_type == "set":
        return set(cache_decode(item) for item in value["items"])
    if cache_type == "tuple":
        return tuple(cache_decode(item) for item in value["items"])
    if cache_type == "mapping":
        return {cache_decode(key): cache_decode(item) for key, item in value["items"]}
    return {key: cache_decode(item) for key, item in value.items()}


def deterministic_parser_contract(config: AnalysisConfig) -> dict[str, Any]:
    return {
        "version": DETERMINISTIC_CACHE_VERSION,
        "analyzer": ANALYZER_VERSION,
        "failure_rules": FAILURE_RULE_VERSION,
        "runtime": "dsh",
        "report_privacy": config.privacy_mode,
        "analysis_privacy": analysis_privacy(config),
        "analysis_depth": config.analysis_depth,
        "semantic_capture": config.semantic_capture,
        "max_excerpt_chars": config.max_excerpt_chars,
    }


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def apply_coverage_delta(coverage: dict[str, Any], delta: dict[str, Any]) -> None:
    for key, value in delta.items():
        if key == "unknown_record_types":
            coverage[key].update(value)
        else:
            coverage[key] += int(value)


def parse_coverage_state() -> dict[str, Any]:
    return {
        "skipped_outside_window": 0,
        "skipped_project": 0,
        "missing_metadata": 0,
        "unreadable_files": 0,
        "malformed_lines": 0,
        "partial_sessions": 0,
        "unknown_record_types": Counter(),
    }


def cached_parse_delta(coverage: dict[str, Any]) -> dict[str, Any]:
    return {
        "missing_metadata": int(coverage["missing_metadata"]),
        "unreadable_files": int(coverage["unreadable_files"]),
        "malformed_lines": int(coverage["malformed_lines"]),
        "unknown_record_types": Counter(coverage["unknown_record_types"]),
    }


def apply_cached_scope(session: dict[str, Any] | None, config: AnalysisConfig, coverage: dict[str, Any]) -> dict[str, Any] | None:
    if session is None:
        return None
    timestamp = session.get("timestamp")
    if not isinstance(timestamp, datetime) or timestamp < config.since or timestamp > config.until:
        coverage["skipped_outside_window"] += 1
        return None
    cwd = str(session.get("cwd") or "")
    project_matches = matches_dsh_project(cwd or None, session.get("workspace_key"), config.project)
    if not project_matches:
        coverage["skipped_project"] += 1
        return None
    if session["task_started"] > session["task_complete"] + session["aborted_turns"]:
        coverage["partial_sessions"] += 1
    return session


def classify_work_area(text: str) -> str:
    lowered = text.casefold()
    best_name = "general"
    best_score = 0
    for name, terms in WORK_AREA_RULES:
        score = sum(lowered.count(term.casefold()) for term in terms)
        if score > best_score:
            best_name = name
            best_score = score
    return best_name


def classify_session(session: dict[str, Any]) -> str:
    if len(session["turn_ids"]) <= 1 and session["tool_calls"] <= 2 and session["duration_ms"] < 2 * 60 * 1000:
        return "quick_check"
    if session["subagents"] > 0:
        return "multi_agent"
    if session["patches"] > 0:
        return "implementation"
    if session["web_searches"] > 0 or session["mcp_calls"] > 0:
        return "research"
    if session["tool_calls"] >= 10:
        return "tool_driven"
    return "conversation"


def is_insights_meta_analysis(session: dict[str, Any]) -> bool:
    if session.get("insights_command_seen"):
        return True
    mentions = {str(item).casefold() for item in session.get("skill_mentions", {})}
    if "dsh-session-insights" in mentions:
        return True
    first_prompt = str(session.get("first_prompt") or "").casefold()
    return "insights" in first_prompt and any(
        marker in first_prompt
        for marker in ("使用洞察", "semantic_insights", "analyze_dsh_sessions", "$dsh-session-insights")
    )


def extract_file_extensions(arguments: Any) -> Counter[str]:
    raw = arguments if isinstance(arguments, str) else json.dumps(arguments, ensure_ascii=False)
    result: Counter[str] = Counter()
    for extension in FILE_EXTENSION_RE.findall(raw):
        lowered = extension.casefold()
        if lowered in COMMON_FILE_EXTENSIONS:
            result[lowered] += 1
    return result


def project_label(cwd: str) -> str:
    value = cwd.strip().rstrip("/\\")
    if not value:
        return "unknown"
    if re.match(r"^[A-Za-z]:\\", value):
        label = PureWindowsPath(value).name
    else:
        label = Path(value).name
    original = label or value
    redacted = redact_text(original, 100)
    if redacted.startswith("<redacted-"):
        suffix = hashlib.sha256(original.encode("utf-8", errors="replace")).hexdigest()[:8]
        return f"project-{suffix}"
    return redacted


def normalize_path(value: str) -> str:
    normalized = value.replace("\\", "/").rstrip("/")
    return normalized.casefold() if re.match(r"^[A-Za-z]:/", normalized) else normalized


def matches_project(cwd: str, requested: str | None) -> bool:
    if not requested:
        return True
    actual = normalize_path(os.path.expanduser(cwd))
    target = normalize_path(os.path.expanduser(requested))
    return actual == target or actual.startswith(target + "/")


def iter_scalars(value: Any) -> Iterable[tuple[str | None, Any]]:
    if isinstance(value, dict):
        for key, item in value.items():
            if isinstance(item, (dict, list)):
                yield from iter_scalars(item)
            else:
                yield str(key), item
    elif isinstance(value, list):
        for item in value:
            yield from iter_scalars(item)
    else:
        yield None, value


def jsonish_arguments(arguments: Any) -> str:
    if isinstance(arguments, str):
        try:
            decoded = json.loads(arguments)
        except (json.JSONDecodeError, TypeError):
            return arguments
        return json.dumps(decoded, ensure_ascii=False, sort_keys=True)
    return json.dumps(arguments, ensure_ascii=False, sort_keys=True)


def classify_platform(cwd: str) -> str:
    if re.match(r"^[A-Za-z]:\\", cwd.strip()):
        return "windows"
    if cwd.strip().startswith("/"):
        return "macos" if cwd.strip().startswith("/Users/") else "posix_other"
    return "unknown"


def classify_rollout_role(meta: dict[str, Any]) -> tuple[str, str]:
    thread_source = str(meta.get("thread_source") or "").casefold()
    source = meta.get("source")
    if thread_source in {"user", "realtime_voice"}:
        return "root_task", "structured"
    if thread_source == "subagent" and isinstance(source, dict):
        subagent = source.get("subagent")
        if isinstance(subagent, dict):
            if isinstance(subagent.get("thread_spawn"), dict):
                return "task_subagent", "structured"
            if str(subagent.get("other") or "").casefold() == "guardian":
                return "action_reviewer", "structured"
    source_text = json.dumps(source, ensure_ascii=False, sort_keys=True) if not isinstance(source, str) else source
    if thread_source == "subagent" and "guardian" in source_text.casefold():
        return "action_reviewer", "heuristic"
    if thread_source == "subagent" and meta.get("parent_thread_id"):
        return "task_subagent", "heuristic"
    if not thread_source and not meta.get("parent_thread_id"):
        return "root_task", "heuristic"
    return "unknown_system_rollout", "structured" if thread_source else "heuristic"


def stable_identifier(value: str, config: AnalysisConfig, prefix: str) -> str:
    if config.privacy_mode == "local" and not config.metrics_only:
        return value
    digest = hashlib.sha256(value.encode("utf-8", errors="replace")).hexdigest()[:12]
    return f"{prefix}-{digest}"


def output_text(value: Any) -> str:
    parts: list[str] = []

    def visit(item: Any, parent_key: str | None = None) -> None:
        if isinstance(item, dict):
            block_type = str(item.get("type") or "").casefold()
            if block_type in {"image", "audio", "input_image", "input_audio"}:
                return
            for key, child in item.items():
                lowered = str(key).casefold()
                if lowered in {"data", "image_url", "audio_url", "authorization", "token", "credential"}:
                    continue
                visit(child, lowered)
        elif isinstance(item, list):
            for child in item:
                visit(child, parent_key)
        elif isinstance(item, str) and parent_key in {None, "text", "message", "output", "content"}:
            if item.startswith("data:") or (len(item) > 512 and LONG_TOKEN_RE.fullmatch(item.strip())):
                return
            parts.append(item)

    visit(value)
    return "\n".join(parts)


def structured_outcome(value: Any) -> tuple[str, int | None]:
    success_seen = False
    exit_code: int | None = None
    for key, scalar in iter_scalars(value):
        lowered_key = (key or "").casefold()
        if lowered_key in {"exit_code", "exitcode", "returncode"}:
            try:
                current = int(scalar)
            except (TypeError, ValueError):
                continue
            exit_code = current if exit_code is None else exit_code
            if current != 0:
                return "failure", current
            success_seen = True
        elif lowered_key in {"success", "ok"}:
            if scalar is False:
                return "failure", exit_code
            if scalar is True:
                success_seen = True
        elif lowered_key in {"is_error", "iserror"} and scalar is True:
            return "failure", exit_code
        elif lowered_key == "status":
            status = str(scalar).casefold()
            if status in {"failed", "failure", "error", "denied"}:
                return "failure", exit_code
            if status in {"completed", "complete", "success", "succeeded", "ok", "passed"}:
                success_seen = True
    return ("success" if success_seen else "unknown"), exit_code


def analyze_tool_output(value: Any, call: dict[str, Any]) -> dict[str, Any]:
    outcome, exit_code = structured_outcome(value)
    text = output_text(value)
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    runtime_exit_codes = [int(match.group(1)) for line in lines if (match := RUNTIME_EXIT_LINE_RE.fullmatch(line))]
    if runtime_exit_codes:
        exit_code = next((code for code in runtime_exit_codes if code != 0), runtime_exit_codes[-1])
        outcome = "failure" if exit_code != 0 else "success"
    elif any(RUNTIME_FAILURE_LINE_RE.fullmatch(line) for line in lines):
        outcome = "failure"
    elif any(RUNTIME_SUCCESS_LINE_RE.fullmatch(line) for line in lines):
        outcome = "success"
    diagnostic_nonzero = outcome == "failure" and bool(call.get("diagnostic"))
    structured_failure = outcome == "failure" and not diagnostic_nonzero
    text_signal = False
    text_signal_cause: str | None = None
    if outcome != "failure" and not call.get("content_dump"):
        for line in lines:
            for cause, pattern in TEXT_ERROR_RULES:
                if pattern.fullmatch(line):
                    text_signal = True
                    text_signal_cause = cause
                    break
            if text_signal:
                break
    cause = None
    if structured_failure or text_signal:
        for candidate, pattern in FAILURE_CAUSE_RULES:
            if pattern.search(text):
                cause = candidate
                break
        cause = cause or text_signal_cause or "other"
    wall_seconds = 0.0
    for line in lines:
        match = WALL_TIME_LINE_RE.fullmatch(line)
        if match:
            wall_seconds = max(wall_seconds, float(match.group(1)))
    for key, scalar in iter_scalars(value):
        if (key or "").casefold() in {"wall_time_seconds", "elapsed_seconds", "duration_seconds"}:
            try:
                wall_seconds = max(wall_seconds, float(scalar))
            except (TypeError, ValueError):
                pass
    return {
        "outcome": outcome,
        "exit_code": exit_code,
        "structured_failure": structured_failure,
        "text_error_signal": text_signal,
        "diagnostic_nonzero": diagnostic_nonzero,
        "cause": cause,
        "wall_seconds": wall_seconds,
        "rule_version": FAILURE_RULE_VERSION,
        "confidence": "high" if structured_failure or diagnostic_nonzero else ("medium" if text_signal else "none"),
    }


def canonical_tool_name(name: str) -> str:
    return name.rsplit("__", 1)[-1].rsplit(".", 1)[-1]


def mcp_server_name(tool_name: str) -> str | None:
    """Derive the MCP server / plugin name from a namespaced tool name."""
    lowered = tool_name.casefold()
    if "mcp__" in lowered:
        parts = tool_name.split("__")
        return parts[1] if len(parts) > 1 else parts[0]
    if lowered.startswith("mcp"):
        return derived_mcp_server_after_prefix(tool_name)
    return None


def derived_mcp_server_after_prefix(tool_name: str) -> str:
    return tool_name[3:].split("_")[0] or tool_name


def skill_name(arguments: Any) -> str:
    """Extract the skill name from a skill tool call, with a stable fallback bucket."""
    decoded = arguments
    if isinstance(arguments, str):
        try:
            decoded = json.loads(arguments)
        except (json.JSONDecodeError, TypeError):
            decoded = arguments
    if isinstance(decoded, dict):
        value = decoded.get("name")
    elif isinstance(decoded, str):
        match = re.search(r'"name"\s*:\s*"([^"]+)"', decoded)
        value = match.group(1) if match else None
    else:
        value = None
    if isinstance(value, str) and value.strip():
        return value.strip()
    return "skill"


def call_fingerprint(name: str, arguments: Any) -> str:
    decoded = arguments
    if isinstance(arguments, str):
        try:
            decoded = json.loads(arguments)
        except (json.JSONDecodeError, TypeError):
            decoded = arguments
    if isinstance(decoded, dict):
        transport_only = {"sandbox_permissions", "justification", "prefix_rule", "yield_time_ms", "max_output_tokens"}
        decoded = {key: value for key, value in decoded.items() if key not in transport_only}
    raw = decoded if isinstance(decoded, str) else json.dumps(decoded, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256((name + "\0" + raw).encode("utf-8", errors="replace")).hexdigest()


def call_approval_mode(arguments: Any) -> str:
    decoded = arguments
    if isinstance(arguments, str):
        try:
            decoded = json.loads(arguments)
        except (json.JSONDecodeError, TypeError):
            return "default"
    if not isinstance(decoded, dict):
        return "default"
    return str(decoded.get("sandbox_permissions") or "default")


def contains_git_commit(arguments: Any) -> bool:
    raw = arguments if isinstance(arguments, str) else json.dumps(arguments, ensure_ascii=False)
    return bool(re.search(r"(?:^|[\s;|&])git\s+commit(?:\s|$)", raw))


def message_text(payload: dict[str, Any]) -> str:
    value = payload.get("message")
    if isinstance(value, str):
        return value
    content = payload.get("content")
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for item in content:
        if isinstance(item, dict) and isinstance(item.get("text"), str):
            parts.append(item["text"])
    return "\n".join(parts)


def session_source_root(config: AnalysisConfig) -> Path:
    return config.dsh_home


def new_session(meta: dict[str, Any], timestamp: datetime, path: Path, config: AnalysisConfig) -> dict[str, Any]:
    cwd = str(meta.get("cwd") or "unknown")
    rollout_id = str(meta.get("id") or path.stem)
    session_id = str(meta.get("session_id") or "")
    parent_thread_id = str(meta.get("parent_thread_id") or "")
    family_id = session_id or parent_thread_id or rollout_id
    role, classification_basis = classify_rollout_role(meta)
    try:
        rollout_file = path.relative_to(session_source_root(config) / "sessions").as_posix()
    except ValueError:
        rollout_file = path.name
    return {
        "rollout_id": rollout_id,
        "family_id": family_id,
        "parent_thread_id": parent_thread_id,
        "thread_source": str(meta.get("thread_source") or ""),
        "originator": str(meta.get("originator") or ""),
        "role": role,
        "classification_basis": classification_basis,
        "rollout_file": rollout_file,
        "session_header_records": 1,
        "insights_command_seen": False,
        "timestamp": timestamp,
        "observed_start": timestamp,
        "observed_end": timestamp,
        "project": project_label(cwd),
        "cwd": cwd,
        "platform": classify_platform(cwd),
        "turn_ids": set(),
        "task_started": 0,
        "task_complete": 0,
        "duration_ms": 0,
        "user_messages": 0,
        "assistant_messages": 0,
        "prompt_lengths": [],
        "topic_text_parts": [],
        "first_prompt": "",
        "correction_messages": 0,
        "clarification_requests": 0,
        "tool_calls": 0,
        "tool_counts": Counter(),
        "tool_failures": 0,
        "text_error_signals": 0,
        "diagnostic_nonzero": 0,
        "failure_causes": Counter(),
        "failure_confidence": Counter(),
        "failure_tools": Counter(),
        "permission_blocks": 0,
        "patches": 0,
        "failed_patches": 0,
        "subagents": 0,
        "web_searches": 0,
        "mcp_calls": 0,
        "skill_calls": 0,
        "skill_counts": Counter(),
        "mcp_server_counts": Counter(),
        "web_search_events": 0,
        "mcp_call_events": 0,
        "aborted_turns": 0,
        "git_commits": 0,
        "tokens": {key: 0 for key in TOKEN_KEYS},
        "calls": {},
        "call_sequence": 0,
        "state_epoch": 0,
        "last_failed_calls": {},
        "fingerprint_counts": Counter(),
        "failed_fingerprints": Counter(),
        "repeated_retries": 0,
        "unchanged_retries": 0,
        "state_change_retries": 0,
        "polling_retries": 0,
        "tool_run_seconds": 0.0,
        "wait_seconds": 0.0,
        "verification_successes": 0,
        "verification_failures": 0,
        "verification_kinds": Counter(),
        "accepted_evidence": 0,
        "file_extensions": Counter(),
        "skill_mentions": Counter(),
        "assistant_latency_seconds": [],
        "user_response_seconds": [],
        "last_user_at": None,
        "last_agent_at": None,
        "awaiting_agent": False,
        "work_area": "general",
        "session_type": "conversation",
        "excerpt_candidates": [],
        "semantic_messages": [],
        "semantic_message_digests": set(),
        "meta_analysis": False,
        "usage_by_step": {},
        "provider_models": Counter(),
        "provider_title": "",
        "fallback_title": "",
        "turn_started_at": {},
        "llm_retries": 0,
        "denied_approvals": 0,
        "approval_requests": {},
        "rejected_approval_call_ids": set(),
    }


def add_semantic_message(
    session: dict[str, Any],
    role: str,
    raw: str,
    config: AnalysisConfig,
    *,
    record_identity: str = "",
) -> None:
    """Capture bounded, sanitized conversation text only for semantic preparation."""
    if not config.semantic_capture or config.metrics_only or config.privacy_mode == "metrics":
        return
    if role not in {"user", "assistant"} or not raw:
        return
    cleaned = strip_dsh_sensitive_blocks(SENSITIVE_BLOCK_RE.sub("", raw))
    cleaned = analysis_text(cleaned, config, 12000)
    if not cleaned or cleaned in {"[context omitted]", "[code omitted]"}:
        return
    digest = hashlib.sha256(f"{role}\0{cleaned}".encode("utf-8")).hexdigest()
    if digest in session["semantic_message_digests"]:
        return
    session["semantic_message_digests"].add(digest)
    session["semantic_messages"].append(
        {
            "id": f"message-{digest[:16]}",
            "role": role,
            "text": cleaned,
            "record_identity": record_identity,
        }
    )


def tool_evidence_summary(value: Any, call: dict[str, Any], analysis: dict[str, Any], config: AnalysisConfig) -> str:
    facts = [f"工具 {call.get('tool', 'unknown')}", f"结果 {analysis['outcome']}"]
    if analysis.get("exit_code") is not None:
        facts.append(f"退出码 {analysis['exit_code']}")
    if analysis.get("cause"):
        facts.append(f"原因 {analysis['cause']}")
    if call.get("verification"):
        facts.append("验证命令")
    if call.get("state_change"):
        facts.append("状态变更")
    if call.get("git_commit") and analysis["outcome"] == "success":
        facts.append("Git 提交成功")
    if not call.get("content_dump"):
        lines = [line.strip() for line in output_text(value).splitlines() if line.strip()]
        selected = [line for line in lines if TOOL_EVIDENCE_LINE_RE.search(line)][:3]
        if not selected and analysis.get("cause"):
            selected = [line for line in lines if any(pattern.search(line) for _, pattern in FAILURE_CAUSE_RULES)][:1]
        if selected:
            facts.append("；".join(selected))
    return analysis_text("；".join(facts), config, 700)


def add_semantic_tool_evidence(
    session: dict[str, Any],
    value: Any,
    call: dict[str, Any],
    analysis: dict[str, Any],
    config: AnalysisConfig,
    *,
    record_identity: str,
) -> None:
    if (
        not config.semantic_capture
        or config.metrics_only
        or analysis_privacy(config) == "metrics"
        or config.analysis_depth != "evidence"
    ):
        return
    if not (call.get("verification") or call.get("state_change") or analysis.get("outcome") == "failure" or call.get("git_commit")):
        return
    summary = tool_evidence_summary(value, call, analysis, config)
    if not summary:
        return
    digest = hashlib.sha256(f"tool\0{record_identity}\0{summary}".encode("utf-8")).hexdigest()
    if digest in session["semantic_message_digests"]:
        return
    session["semantic_message_digests"].add(digest)
    session["semantic_messages"].append(
        {
            "id": f"tool-{digest[:16]}",
            "role": "tool",
            "text": summary,
            "record_identity": record_identity,
            "tool_facts": {
                "tool": call.get("tool", "unknown"),
                "outcome": analysis.get("outcome", "unknown"),
                "exit_code": analysis.get("exit_code"),
                "cause": analysis.get("cause"),
                "verification": bool(call.get("verification")),
                "state_change": bool(call.get("state_change")),
                "git_commit": bool(call.get("git_commit")),
            },
        }
    )


def add_excerpt_candidate(session: dict[str, Any], kind: str, raw: str, config: AnalysisConfig) -> None:
    if config.metrics_only or config.privacy_mode == "metrics" or not raw:
        return
    sanitized = excerpt_text(raw, config)
    if not sanitized or sanitized in {"[context omitted]", "[code omitted]"}:
        return
    session["excerpt_candidates"].append({"kind": kind, "text": sanitized})


def update_token_maxima(session: dict[str, Any], payload: dict[str, Any]) -> None:
    info = payload.get("info")
    if not isinstance(info, dict):
        return
    usage = info.get("total_token_usage")
    if not isinstance(usage, dict):
        return
    for key in TOKEN_KEYS:
        value = usage.get(key)
        if isinstance(value, (int, float)) and value >= 0:
            session["tokens"][key] = max(session["tokens"][key], int(value))


def process_event(
    session: dict[str, Any],
    payload: dict[str, Any],
    config: AnalysisConfig,
    record_timestamp: datetime | None = None,
) -> None:
    event_type = str(payload.get("type") or "")
    turn_id = payload.get("turn_id")
    if isinstance(turn_id, str) and event_type in {"task_started", "task_complete", "turn_aborted"}:
        session["turn_ids"].add(turn_id)
    if event_type == "task_started":
        session["task_started"] += 1
    elif event_type == "task_complete":
        session["task_complete"] += 1
        duration = payload.get("duration_ms")
        if isinstance(duration, (int, float)) and duration >= 0:
            session["duration_ms"] += int(duration)
    elif event_type == "token_count":
        update_token_maxima(session, payload)
    elif event_type == "user_message":
        raw = message_text(payload)
        cleaned = strip_dsh_sensitive_blocks(SENSITIVE_BLOCK_RE.sub("", raw))
        session["user_messages"] += 1
        session["prompt_lengths"].append(len(cleaned.strip()))
        if not session["first_prompt"]:
            session["first_prompt"] = cleaned
        safe_topic_text = local_text(cleaned, 5000)
        if len(" ".join(session["topic_text_parts"])) < 50000:
            session["topic_text_parts"].append(safe_topic_text)
        for mention in SKILL_MENTION_RE.findall(safe_topic_text):
            if "-" in mention:
                session["skill_mentions"][mention.casefold()] += 1
        if session["user_messages"] > 1 and USER_ACCEPTANCE_RE.fullmatch(cleaned.strip()):
            session["accepted_evidence"] += 1
        if record_timestamp is not None:
            last_agent = session.get("last_agent_at")
            if isinstance(last_agent, datetime) and record_timestamp >= last_agent:
                session["user_response_seconds"].append((record_timestamp - last_agent).total_seconds())
            session["last_user_at"] = record_timestamp
            session["awaiting_agent"] = True
        is_correction = session["user_messages"] > 1 and bool(CORRECTION_RE.search(cleaned))
        if is_correction:
            session["correction_messages"] += 1
            add_excerpt_candidate(session, "correction", cleaned, config)
        elif session["user_messages"] == 1:
            add_excerpt_candidate(session, "prompt", cleaned, config)
        elif session["user_messages"] <= 4:
            add_excerpt_candidate(session, "follow_up", cleaned, config)
        add_semantic_message(session, "user", cleaned, config, record_identity=str(turn_id or ""))
    elif event_type == "agent_message":
        session["assistant_messages"] += 1
        add_semantic_message(
            session,
            "assistant",
            message_text(payload),
            config,
            record_identity=str(turn_id or ""),
        )
        if record_timestamp is not None:
            last_user = session.get("last_user_at")
            if session.get("awaiting_agent") and isinstance(last_user, datetime) and record_timestamp >= last_user:
                session["assistant_latency_seconds"].append((record_timestamp - last_user).total_seconds())
                session["awaiting_agent"] = False
            session["last_agent_at"] = record_timestamp
    elif event_type == "patch_apply_end":
        session["patches"] += 1
        if payload.get("success") is False or str(payload.get("status", "")).casefold() in {"failed", "error"}:
            session["failed_patches"] += 1
    elif event_type == "turn_aborted":
        session["aborted_turns"] += 1
    elif event_type == "web_search_end":
        session["web_search_events"] += 1
    elif event_type == "mcp_tool_call_end":
        session["mcp_call_events"] += 1


def process_call(
    session: dict[str, Any],
    payload: dict[str, Any],
    *,
    canonical_name: str | None = None,
) -> None:
    raw_name = str(payload.get("name") or "unknown")
    name = canonical_name or canonical_tool_name(raw_name)
    call_id = str(payload.get("call_id") or payload.get("id") or "")
    arguments = payload.get("arguments", payload.get("input", ""))
    arguments_text = jsonish_arguments(arguments)
    fingerprint = call_fingerprint(name, arguments)
    approval_mode = call_approval_mode(arguments)
    session["call_sequence"] += 1
    session["tool_calls"] += 1
    session["tool_counts"][name] += 1
    session["fingerprint_counts"][fingerprint] += 1
    session["file_extensions"].update(extract_file_extensions(arguments))
    lowered = name.casefold()
    if lowered == "request_user_input":
        session["clarification_requests"] += 1
    if lowered in {"spawn_agent", "create_agent"}:
        session["subagents"] += 1
    if "web" in lowered and any(term in lowered for term in ("run", "search", "query")):
        session["web_searches"] += 1
    if lowered.startswith("mcp") or "mcp__" in raw_name.casefold():
        session["mcp_calls"] += 1
        server = mcp_server_name(name) or mcp_server_name(raw_name) or name
        session["mcp_server_counts"][server] += 1
    if lowered == "skill":
        session["skill_calls"] += 1
        session["skill_counts"][skill_name(arguments)] += 1
    polling = lowered in {"wait", "wait_agent", "wait_threads", "write_stdin"}
    prior_failure = session["last_failed_calls"].get(fingerprint)
    if polling and session["fingerprint_counts"][fingerprint] > 1:
        session["polling_retries"] += 1
    elif prior_failure:
        if approval_mode != prior_failure.get("approval_mode", "default") or session["state_epoch"] > prior_failure["state_epoch"]:
            session["state_change_retries"] += 1
        else:
            session["unchanged_retries"] += 1
    if call_id:
        session["calls"][call_id] = {
            "tool": name,
            "fingerprint": fingerprint,
            "git_commit": contains_git_commit(arguments),
            "arguments_text": arguments_text,
            "content_dump": bool(CONTENT_DUMP_COMMAND_RE.search(arguments_text)),
            "diagnostic": bool(DIAGNOSTIC_COMMAND_RE.search(arguments_text)),
            "verification": bool(VERIFICATION_COMMAND_RE.search(arguments_text)),
            "state_change": lowered in {"apply_patch", "request_user_input"} or bool(STATE_CHANGE_COMMAND_RE.search(arguments_text)),
            "polling": polling,
            "sequence": session["call_sequence"],
            "approval_mode": approval_mode,
        }


def process_call_output(
    session: dict[str, Any],
    payload: dict[str, Any],
    config: AnalysisConfig,
    *,
    cause_override: str | None = None,
) -> None:
    call_id = str(payload.get("call_id") or "")
    call = session["calls"].get(
        call_id,
        {
            "tool": "unknown",
            "fingerprint": None,
            "git_commit": False,
            "content_dump": False,
            "diagnostic": False,
            "verification": False,
            "state_change": False,
            "polling": False,
            "sequence": session["call_sequence"],
        },
    )
    analysis = analyze_tool_output(payload.get("output"), call)
    if cause_override and analysis["structured_failure"]:
        analysis["cause"] = cause_override
    if analysis["structured_failure"]:
        session["tool_failures"] += 1
        session["failure_tools"][call["tool"]] += 1
        if call.get("fingerprint"):
            session["failed_fingerprints"][call["fingerprint"]] += 1
            session["last_failed_calls"][call["fingerprint"]] = {
                "state_epoch": session["state_epoch"],
                "sequence": call.get("sequence", 0),
                "approval_mode": call.get("approval_mode", "default"),
            }
    if analysis["text_error_signal"]:
        session["text_error_signals"] += 1
    if analysis["diagnostic_nonzero"]:
        session["diagnostic_nonzero"] += 1
    if analysis["cause"]:
        session["failure_causes"][analysis["cause"]] += 1
        session["failure_confidence"][analysis["confidence"]] += 1
    if call.get("verification"):
        if analysis["outcome"] == "success" and not analysis["text_error_signal"]:
            session["verification_successes"] += 1
            session["verification_kinds"][call["tool"]] += 1
        elif analysis["structured_failure"] or analysis["text_error_signal"]:
            session["verification_failures"] += 1
    if analysis["outcome"] == "success" and call.get("state_change"):
        session["state_epoch"] += 1
    session["tool_run_seconds"] += analysis["wall_seconds"]
    if call.get("polling"):
        session["wait_seconds"] += analysis["wall_seconds"]
    if analysis["outcome"] == "success" and call.get("git_commit"):
        session["git_commits"] += 1
    if (
        analysis["cause"] == "permission_boundary"
        and analysis["structured_failure"]
        and not call.get("approval_rejected")
    ):
        session["permission_blocks"] += 1
    add_semantic_tool_evidence(
        session,
        payload.get("output"),
        call,
        analysis,
        config,
        record_identity=call_id or f"sequence-{call.get('sequence', 0)}",
    )


def process_response(session: dict[str, Any], payload: dict[str, Any], config: AnalysisConfig) -> None:
    response_type = str(payload.get("type") or "")
    if response_type in {"function_call", "custom_tool_call", "web_search_call", "tool_search_call"}:
        process_call(session, payload)
    elif response_type in {"function_call_output", "custom_tool_call_output", "tool_search_output"}:
        process_call_output(session, payload, config)
    elif response_type == "message":
        role = str(payload.get("role") or "")
        if role in {"user", "assistant"}:
            add_semantic_message(
                session,
                role,
                message_text(payload),
                config,
                record_identity=str(payload.get("id") or ""),
            )


_zstandard_module: Any = None


def get_zstandard() -> Any:
    """Lazily import the only non-standard runtime dependency."""
    global _zstandard_module
    if _zstandard_module is None:
        try:
            _zstandard_module = importlib.import_module("zstandard")
        except ImportError as exc:
            raise ValueError(
                "DSH 会话分析需要 zstandard；请先安装本项目（例如 python -m pip install .）。"
            ) from exc
    return _zstandard_module


def read_dsh_jsonl_lines(path: Path) -> list[str] | None:
    zstandard = get_zstandard()
    try:
        with path.open("rb") as handle:
            raw = zstandard.ZstdDecompressor().stream_reader(handle).read()
        return raw.decode("utf-8", errors="replace").splitlines()
    except OSError:
        return None
    except Exception as exc:
        if exc.__class__.__module__.startswith("zstandard"):
            return None
        raise


def dsh_content_text(value: Any) -> str:
    if not isinstance(value, dict):
        return ""
    content = value.get("content")
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for item in content:
        if isinstance(item, dict) and isinstance(item.get("text"), str):
            parts.append(item["text"])
    return "\n".join(parts)


def canonical_dsh_tool_name(name: str) -> str:
    value = str(name or "unknown")
    if value.casefold().startswith("mcp__zotero__"):
        return "mcp__zotero"
    return value


def dsh_tool_call_id(data: dict[str, Any]) -> str:
    call_id = str(data.get("callId") or "")
    if call_id:
        return call_id
    message = data.get("message")
    if isinstance(message, dict):
        source = message.get("source")
        if isinstance(source, dict) and source.get("callId"):
            return str(source["callId"])
        content = message.get("content")
        if isinstance(content, list):
            for item in content:
                if isinstance(item, dict) and item.get("toolCallId"):
                    return str(item["toolCallId"])
    return ""


def dsh_value_has_is_error(value: Any) -> bool:
    for key, scalar in iter_scalars(value):
        if (key or "").casefold() in {"is_error", "iserror"} and scalar is True:
            return True
    return False


def dsh_value_has_explicit_success(value: Any) -> bool:
    keys = [(key or "").casefold() for key, _ in iter_scalars(value)]
    if not any(key in {"is_error", "iserror"} for key in keys):
        return False
    return not dsh_value_has_is_error(value)


def record_dsh_usage(
    session: dict[str, Any],
    turn: Any,
    step: Any,
    usage: Any,
    source: str,
) -> None:
    if not isinstance(usage, dict):
        return
    key = (str(turn or ""), str(step or ""))
    existing = session["usage_by_step"].get(key)
    if source == "message" or existing is None or existing.get("source") != "message":
        session["usage_by_step"][key] = {"source": source, "usage": dict(usage)}


def finalize_dsh_tokens(session: dict[str, Any]) -> None:
    """Align DSH tokens with the native token-meter projection.

    Native DSH projects each deduplicated (turn,step) usage sample as:
    usage.inputTokens -> uncachedInputTokens and usage.cacheReadTokens ->
    cacheReadTokens (both summed per step). usage.outputTokens already includes
    reasoning as an output subdivision, so reasoningTokens is reported as a
    breakdown and must not be added to total_tokens again.
    """
    tokens = {key: 0 for key in (*TOKEN_KEYS, "uncached_input_tokens")}
    cache_write_tokens = 0
    for entry in session["usage_by_step"].values():
        usage = entry.get("usage")
        if not isinstance(usage, dict):
            continue
        for source_key, target_key in (
            ("inputTokens", "uncached_input_tokens"),
            ("outputTokens", "output_tokens"),
            ("reasoningTokens", "reasoning_output_tokens"),
            ("cacheReadTokens", "cached_input_tokens"),
        ):
            value = usage.get(source_key)
            if isinstance(value, (int, float)) and value >= 0:
                tokens[target_key] += int(value)
        cache_write = usage.get("cacheWriteTokens")
        if isinstance(cache_write, (int, float)) and cache_write >= 0:
            cache_write_tokens += int(cache_write)
    tokens["input_tokens"] = tokens["uncached_input_tokens"] + tokens["cached_input_tokens"]
    tokens["cache_write_tokens"] = cache_write_tokens
    tokens["total_tokens"] = (
        tokens["uncached_input_tokens"]
        + tokens["cached_input_tokens"]
        + tokens["output_tokens"]
        + cache_write_tokens
    )
    session["tokens"] = tokens


def new_dsh_session(
    header: dict[str, Any],
    workspace_key: str | None,
    timestamp: datetime,
    path: Path,
    config: AnalysisConfig,
) -> dict[str, Any]:
    rollout_id = str(header.get("id") or path.parent.name or path.stem)
    parent_session = str(header.get("parentSession") or "")
    cwd = str(
        header.get("cwd")
        or decode_dsh_workspace_key(workspace_key)
        or "unknown"
    )
    origin = str(header.get("origin") or "")
    if origin == "subagent":
        thread_source = "subagent"
        source: object = {
            "subagent": {
                "thread_spawn": {
                    "parent_thread_id": parent_session,
                    "depth": header.get("delegationDepth", 1),
                }
            }
        }
        family_session_id = parent_session or rollout_id
    else:
        thread_source = "user"
        source = "dsh"
        family_session_id = rollout_id
    meta: dict[str, Any] = {
        "cwd": cwd,
        "id": rollout_id,
        "session_id": family_session_id,
        "parent_thread_id": parent_session,
        "thread_source": thread_source,
        "originator": str(header.get("agentPreset") or "DeepSeek Harness"),
        "source": source,
    }
    session = new_session(meta, timestamp, path, config)
    session["workspace_key"] = workspace_key
    session["session_header_records"] = 1
    return session


def process_dsh_record(
    session: dict[str, Any],
    record_type: str,
    data: dict[str, Any],
    config: AnalysisConfig,
    record_timestamp: datetime | None,
) -> None:
    if record_type == "turn/start":
        turn = data.get("turn")
        if turn is not None:
            turn_key = str(turn)
            session["turn_ids"].add(turn_key)
            session["task_started"] += 1
            if record_timestamp is not None:
                session["turn_started_at"][turn_key] = record_timestamp
        return
    if record_type == "turn/end":
        turn = data.get("turn")
        if turn is not None:
            turn_key = str(turn)
            start = session["turn_started_at"].get(turn_key)
            if isinstance(start, datetime) and record_timestamp is not None:
                elapsed_ms = max(0, int((record_timestamp - start).total_seconds() * 1000))
                session["duration_ms"] += elapsed_ms
            session["turn_started_at"].pop(turn_key, None)
            reason = data.get("reason")
            kind = str(reason.get("kind") or "") if isinstance(reason, dict) else ""
            if kind == "completed":
                session["task_complete"] += 1
            elif kind in {"aborted", "interrupted", "error"}:
                session["aborted_turns"] += 1
            else:
                session["task_complete"] += 1
        return
    if record_type == "user/message":
        payload: dict[str, Any] = {"type": "user_message"}
        if isinstance(data.get("content"), list):
            payload["content"] = data["content"]
        elif isinstance(data.get("message"), str):
            payload["message"] = data["message"]
        process_event(session, payload, config, record_timestamp)
        return
    if record_type == "assistant/message":
        process_event(session, {"type": "agent_message"}, config, record_timestamp)
        message = data.get("message")
        if isinstance(message, dict):
            add_semantic_message(
                session,
                "assistant",
                dsh_content_text(message),
                config,
                record_identity=f"{data.get('turn', '')}:{data.get('step', '')}",
            )
        usage = data.get("usage")
        if not isinstance(usage, dict) and isinstance(message, dict):
            usage = message.get("usage")
        record_dsh_usage(session, data.get("turn"), data.get("step"), usage, "message")
        if isinstance(message, dict):
            source = message.get("source")
            if isinstance(source, dict):
                provider = source.get("provider")
                model = source.get("model")
                if provider and model:
                    session["provider_models"][(str(provider), str(model))] += 1
        return
    if record_type == "assistant/chunk":
        chunk = data.get("chunk")
        if isinstance(chunk, dict) and str(chunk.get("type") or "") == "usage":
            record_dsh_usage(
                session,
                data.get("turn"),
                data.get("step"),
                chunk.get("usage"),
                "chunk",
            )
        return
    if record_type == "command/run":
        if str(data.get("name") or "").casefold() == "session-insights":
            session["insights_command_seen"] = True
        return
    if record_type == "tool/call":
        name = str(data.get("name") or "unknown")
        call_id = str(data.get("callId") or "")
        payload = {
            "type": "function_call",
            "name": name,
            "call_id": call_id,
            "arguments": data.get("arguments", data.get("input", "")),
        }
        process_call(session, payload, canonical_name=canonical_dsh_tool_name(name))
        call = session["calls"].get(call_id)
        if isinstance(call, dict) and call_id in session["rejected_approval_call_ids"]:
            call["approval_rejected"] = True
        lowered = name.casefold()
        if lowered in {"subagent", "workflow"}:
            session["subagents"] += 1
        return
    if record_type == "tool/result":
        call_id = dsh_tool_call_id(data)
        message = data.get("message")
        output_value: Any = message if isinstance(message, dict) else data
        error_object = data.get("error")
        error_present = isinstance(error_object, dict) and bool(error_object)
        text = output_text(output_value)
        sandbox_denied = bool(DSH_SANDBOX_DENIED_RE.search(text))
        user_rejected = bool(DSH_USER_REJECTED_RE.search(text))
        analysis_input: dict[str, Any] = {"message": output_value}
        if error_present:
            analysis_input["error"] = error_object
        explicit_success = dsh_value_has_explicit_success(output_value)
        if explicit_success and not error_present and not sandbox_denied and not user_rejected:
            analysis_input["success"] = True
        analysis_input["isError"] = (
            dsh_value_has_is_error(output_value)
            or error_present
            or sandbox_denied
            or user_rejected
        )
        cause_override = None
        if sandbox_denied or user_rejected or (
            isinstance(error_object, dict) and error_object.get("code") == "FS_SANDBOX_DENIED"
        ):
            cause_override = "permission_boundary"
        process_call_output(
            session,
            {"call_id": call_id, "output": analysis_input},
            config,
            cause_override=cause_override,
        )
        return
    if record_type == "request/header":
        header = data.get("header")
        if isinstance(header, dict):
            header_config = header.get("config")
            if isinstance(header_config, dict):
                provider = header_config.get("provider")
                model = header_config.get("model")
                if provider and model:
                    session["provider_models"][(str(provider), str(model))] += 1
        # request/header contains system prompts; deliberately never excerpt it.
        return
    if record_type == "request/context":
        provider = data.get("provider")
        model = data.get("model")
        if provider and model:
            session["provider_models"][(str(provider), str(model))] += 1
        return
    if record_type == "approval/asked":
        approval_id = str(data.get("id") or "")
        if approval_id:
            session["approval_requests"][approval_id] = data
        return
    if record_type == "approval/decided":
        outcome = str(data.get("outcome") or "").casefold()
        if outcome in {"rejected", "denied"}:
            session["denied_approvals"] += 1
            session["permission_blocks"] += 1
            request = session["approval_requests"].get(str(data.get("id") or ""))
            if isinstance(request, dict):
                call_id = str(request.get("callId") or "")
                if call_id:
                    session["rejected_approval_call_ids"].add(call_id)
                    call = session["calls"].get(call_id)
                    if isinstance(call, dict):
                        call["approval_rejected"] = True
        return
    if record_type == "llm/retry":
        session["llm_retries"] += 1
        session["failure_causes"]["llm_retry"] += 1
        return
    if record_type == "session/title":
        title = data.get("title")
        if not isinstance(title, str) or not title:
            return
        source = data.get("source")
        kind = str(source.get("kind") or "") if isinstance(source, dict) else ""
        if kind == "provider":
            session["provider_title"] = title
        elif not session["fallback_title"]:
            session["fallback_title"] = title
        return
    # Remaining known DSH record types are parsed as structural no-ops:
    # permission/preset, sandbox/mode, approval/policy, agent/inbox/spliced,
    # todo/write, step/start, step/end, session/end-seed, and aggregate chunks.


def finalize_dsh_session(session: dict[str, Any], coverage: dict[str, Any]) -> dict[str, Any]:
    finalize_dsh_tokens(session)
    session["repeated_retries"] = (
        session["unchanged_retries"] + session["state_change_retries"] + session["polling_retries"]
    )
    session["web_searches"] = max(session["web_searches"], session["web_search_events"])
    session["mcp_calls"] = max(session["mcp_calls"], session["mcp_call_events"])
    if session["task_started"] > session["task_complete"] + session["aborted_turns"]:
        coverage["partial_sessions"] += 1
    session["complexity_score"] = session_complexity(session)
    session["work_area"] = classify_work_area(" ".join(session["topic_text_parts"]))
    session["session_type"] = classify_session(session)
    session["meta_analysis"] = is_insights_meta_analysis(session)
    return session


def parse_dsh_session_file(
    path: Path,
    config: AnalysisConfig,
    coverage: dict[str, Any],
) -> dict[str, Any] | None:
    lines = read_dsh_jsonl_lines(path)
    if lines is None:
        coverage["unreadable_files"] += 1
        return None
    records: list[Any] = []
    for line in lines:
        if not line.strip():
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            coverage["malformed_lines"] += 1
    return parse_dsh_session_records(
        records,
        config,
        coverage,
        source_path=path,
        workspace_key=path.parent.parent.name,
    )


def parse_dsh_session_records(
    records: Iterable[Any],
    config: AnalysisConfig,
    coverage: dict[str, Any],
    *,
    source_path: Path,
    workspace_key: str,
) -> dict[str, Any] | None:
    """Parse one replay-validated DSH record stream without writing it to disk."""
    session: dict[str, Any] | None = None
    buffered: list[tuple[dict[str, Any], datetime | None]] = []
    for record in records:
        if not isinstance(record, dict):
            coverage["malformed_lines"] += 1
            continue
        record_type = str(record.get("type") or "")
        if record_type not in DSH_KNOWN_RECORD_TYPES:
            coverage["unknown_record_types"][record_type or "<missing>"] += 1
            continue
        record_timestamp = parse_dsh_timestamp(record.get("time"))
        if session is None:
            if record_type != "session":
                if len(buffered) < 50:
                    buffered.append((record, record_timestamp))
                continue
            header = record
            timestamp = parse_dsh_timestamp(header.get("createdAt"))
            if timestamp is None:
                timestamp = next(
                    (pending_time for _, pending_time in buffered if pending_time is not None),
                    None,
                )
            if timestamp is None:
                coverage["missing_metadata"] += 1
                return None
            if timestamp < config.since or timestamp > config.until:
                coverage["skipped_outside_window"] += 1
                return None
            cwd = str(header.get("cwd") or "")
            if not matches_dsh_project(cwd or None, workspace_key, config.project):
                coverage["skipped_project"] += 1
                return None
            session = new_dsh_session(header, workspace_key, timestamp, source_path, config)
            for pending, pending_time in buffered:
                if pending_time is not None:
                    session["observed_start"] = min(session["observed_start"], pending_time)
                    session["observed_end"] = max(session["observed_end"], pending_time)
                pending_data = pending.get("data")
                if isinstance(pending_data, dict):
                    process_dsh_record(session, pending["type"], pending_data, config, pending_time)
            buffered.clear()
            continue
        if record_type == "session":
            session["session_header_records"] += 1
            continue
        data = record.get("data")
        if not isinstance(data, dict):
            coverage["malformed_lines"] += 1
            continue
        if record_timestamp is not None:
            session["observed_start"] = min(session["observed_start"], record_timestamp)
            session["observed_end"] = max(session["observed_end"], record_timestamp)
        process_dsh_record(session, record_type, data, config, record_timestamp)
    if session is None:
        coverage["missing_metadata"] += 1
        return None
    return finalize_dsh_session(session, coverage)


def session_complexity(session: dict[str, Any]) -> float:
    duration_minutes = session["duration_ms"] / 60000
    return safe_round(
        len(session["turn_ids"]) * 2
        + min(session["tool_calls"], 50)
        + session["patches"] * 4
        + session["subagents"] * 6
        + min(duration_minutes, 120) / 5,
        1,
    )


def session_status(session: dict[str, Any]) -> str:
    if session["task_started"] > session["task_complete"] + session["aborted_turns"]:
        return "partial"
    if session["aborted_turns"] > 0:
        return "aborted"
    return "completed"


def token_view(tokens: dict[str, int]) -> dict[str, int]:
    result = {key: int(tokens.get(key, 0)) for key in TOKEN_KEYS}
    result["uncached_input_tokens"] = max(0, result["input_tokens"] - result["cached_input_tokens"])
    if "cache_write_tokens" in tokens:
        result["cache_write_tokens"] = int(tokens.get("cache_write_tokens", 0))
    return result


def completion_view(session: dict[str, Any]) -> dict[str, str]:
    status = session_status(session)
    return {
        "log_completed": "yes" if status == "completed" else "no",
        "verified_completed": (
            "yes"
            if session["verification_successes"] > 0
            else ("no" if session["verification_failures"] > 0 else "unknown")
        ),
        "accepted": "yes" if session["accepted_evidence"] > 0 else "unknown",
    }


def session_public_view(session: dict[str, Any], config: AnalysisConfig) -> dict[str, Any]:
    status = session_status(session)
    title_source = "prompt"
    if config.metrics_only or config.privacy_mode == "metrics":
        title = "Content omitted" if config.locale == "en" else "内容已省略"
        title_source = "omitted"
    else:
        if session.get("provider_title"):
            raw_title = session["provider_title"]
            title_source = "provider"
        elif session.get("fallback_title"):
            raw_title = session["fallback_title"]
            title_source = "fallback"
        else:
            raw_title = session.get("first_prompt", "")
        title = excerpt_text(raw_title, config, 140) if raw_title else ("No usable title" if config.locale == "en" else "未提供可用标题")
    provider, model = (None, None)
    if session.get("provider_models"):
        provider, model = session["provider_models"].most_common(1)[0][0]
    view = {
        "rollout_id": stable_identifier(session["rollout_id"], config, "rollout"),
        "task_family_id": stable_identifier(session["family_id"], config, "task"),
        "rollout_file": (
            session["rollout_file"]
            if config.privacy_mode == "local" and not config.metrics_only
            else stable_identifier(session["rollout_file"], config, "file")
        ),
        "role": session["role"],
        "classification_basis": session["classification_basis"],
        "platform": session["platform"],
        "session_header_records": session["session_header_records"],
        "project": session["project"],
        "date": session["timestamp"].date().isoformat(),
        "start_hour_local": session["timestamp"].astimezone().hour,
        "weekday": session["timestamp"].astimezone().weekday(),
        "observed_minutes": safe_round((session["observed_end"] - session["observed_start"]).total_seconds() / 60, 1),
        "status": status,
        "title": title,
        "work_area": session["work_area"],
        "session_type": session["session_type"],
        "meta_analysis": bool(session.get("meta_analysis")),
        "complexity_score": session["complexity_score"],
        "turns": len(session["turn_ids"]),
        "active_minutes": safe_round(session["duration_ms"] / 60000, 1),
        "user_messages": session["user_messages"],
        "assistant_messages": session["assistant_messages"],
        "median_prompt_chars": int(statistics.median(session["prompt_lengths"])) if session["prompt_lengths"] else 0,
        "correction_messages": session["correction_messages"],
        "clarification_requests": session["clarification_requests"],
        "tool_calls": session["tool_calls"],
        "tool_failures": session["tool_failures"],
        "text_error_signals": session["text_error_signals"],
        "diagnostic_nonzero": session["diagnostic_nonzero"],
        "failure_causes": dict(sorted(session["failure_causes"].items())),
        "failure_rule_version": FAILURE_RULE_VERSION,
        "patches": session["patches"],
        "failed_patches": session["failed_patches"],
        "subagents": session["subagents"],
        "web_searches": session["web_searches"],
        "mcp_calls": session["mcp_calls"],
        "skill_calls": session["skill_calls"],
        "aborted_turns": session["aborted_turns"],
        "permission_blocks": session["permission_blocks"],
        "repeated_retries": session["repeated_retries"],
        "unchanged_retries": session["unchanged_retries"],
        "state_change_retries": session["state_change_retries"],
        "polling_retries": session["polling_retries"],
        "git_commits": session["git_commits"],
        "completion": completion_view(session),
        "verification": {
            "successes": session["verification_successes"],
            "failures": session["verification_failures"],
            "kinds": dict(sorted(session["verification_kinds"].items())),
        },
        "timing": {
            "observed_wall_seconds": max(0.0, (session["observed_end"] - session["observed_start"]).total_seconds()),
            "active_seconds": session["duration_ms"] / 1000,
            "tool_run_seconds": safe_round(session["tool_run_seconds"]),
            "wait_seconds": safe_round(session["wait_seconds"]),
            "measurement": {
                "observed_wall_seconds": "measured",
                "active_seconds": "proxy",
                "tool_run_seconds": "proxy",
                "wait_seconds": "proxy",
            },
        },
        "median_assistant_latency_seconds": safe_round(statistics.median(session["assistant_latency_seconds"])) if session["assistant_latency_seconds"] else 0,
        "median_user_response_seconds": safe_round(statistics.median(session["user_response_seconds"])) if session["user_response_seconds"] else 0,
        "tokens": token_view(session["tokens"]),
        "top_tools": [name for name, _ in session["tool_counts"].most_common(5)],
        "file_extensions": [name for name, _ in session["file_extensions"].most_common(5)],
        "skill_mentions": [name for name, _ in session["skill_mentions"].most_common(5)],
    }
    view["title_source"] = title_source
    view["provider"] = provider
    view["model"] = model
    view["llm_retries"] = session["llm_retries"]
    view["denied_approvals"] = session["denied_approvals"]
    return view


def select_excerpts(sessions: list[dict[str, Any]], config: AnalysisConfig) -> list[dict[str, Any]]:
    if config.metrics_only or config.max_excerpts <= 0:
        return []
    friction_order = sorted(
        sessions,
        key=lambda item: (
            item["tool_failures"] + item["aborted_turns"] + item["permission_blocks"] > 0,
            item["complexity_score"],
            item["timestamp"],
        ),
        reverse=True,
    )
    complexity_order = sorted(sessions, key=lambda item: item["complexity_score"], reverse=True)
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    session_counts: Counter[int] = Counter()
    project_counts: Counter[str] = Counter()
    project_limit = max(2, math.ceil(config.max_excerpts / 4))

    def add(session: dict[str, Any], candidate: dict[str, str]) -> bool:
        session_key = id(session)
        if session_counts[session_key] >= 2 or project_counts[session["project"]] >= project_limit:
            return False
        digest = hashlib.sha256(candidate["text"].encode("utf-8")).hexdigest()
        if digest in seen:
            return False
        seen.add(digest)
        session_counts[session_key] += 1
        project_counts[session["project"]] += 1
        result.append(
            {
                "kind": candidate["kind"],
                "project": session["project"],
                "date": session["timestamp"].date().isoformat(),
                "status": session_status(session),
                "work_area": session["work_area"],
                "role": session["role"],
                "platform": session["platform"],
                "task_family_id": stable_identifier(session["family_id"], config, "task"),
                "text": candidate["text"],
            }
        )
        return True

    for session in complexity_order:
        prompt = next((item for item in session["excerpt_candidates"] if item["kind"] == "prompt"), None)
        if prompt:
            add(session, prompt)
        if len(result) >= min(5, config.max_excerpts):
            break
    for session in friction_order:
        for candidate in session["excerpt_candidates"]:
            if candidate["kind"] == "correction":
                add(session, candidate)
            if len(result) >= config.max_excerpts:
                return result
    for session in complexity_order:
        for candidate in session["excerpt_candidates"]:
            add(session, candidate)
            if len(result) >= config.max_excerpts:
                return result
    return result


def concurrency_metrics(sessions: list[dict[str, Any]]) -> dict[str, int]:
    intervals = [
        (session["observed_start"], session["observed_end"])
        for session in sessions
        if session["observed_end"] > session["observed_start"]
    ]
    overlapping: set[int] = set()
    overlap_pairs = 0
    for left in range(len(intervals)):
        for right in range(left + 1, len(intervals)):
            if max(intervals[left][0], intervals[right][0]) < min(intervals[left][1], intervals[right][1]):
                overlapping.update((left, right))
                overlap_pairs += 1
    events = sorted(
        [(start, 1) for start, _ in intervals] + [(end, -1) for _, end in intervals],
        key=lambda item: (item[0], item[1]),
    )
    active = 0
    maximum = 0
    for _, delta in events:
        active += delta
        maximum = max(maximum, active)
    return {"overlapping_sessions": len(overlapping), "overlap_pairs": overlap_pairs, "max_concurrent": maximum}


def aggregate_tokens(sessions: list[dict[str, Any]]) -> dict[str, int]:
    totals = {key: sum(int(session["tokens"].get(key, 0)) for session in sessions) for key in TOKEN_KEYS}
    totals["uncached_input_tokens"] = max(0, totals["input_tokens"] - totals["cached_input_tokens"])
    if any("cache_write_tokens" in session["tokens"] for session in sessions):
        totals["cache_write_tokens"] = sum(
            int(session["tokens"].get("cache_write_tokens", 0)) for session in sessions
        )
    return totals


def family_completion(members: list[dict[str, Any]]) -> dict[str, str]:
    root = next((member for member in members if member["role"] == "root_task"), None)
    root_completion = completion_view(root) if root else None
    return {
        "log_completed": root_completion["log_completed"] if root_completion else "unknown",
        "verified_completed": (
            "yes"
            if any(member["verification_successes"] > 0 for member in members)
            else ("no" if any(member["verification_failures"] > 0 for member in members) else "unknown")
        ),
        "accepted": "yes" if root and root["accepted_evidence"] > 0 else "unknown",
    }


def build_task_families(
    sessions: list[dict[str, Any]],
    public_by_rollout: dict[str, dict[str, Any]],
    config: AnalysisConfig,
) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for session in sessions:
        grouped[session["family_id"]].append(session)
    families: list[dict[str, Any]] = []
    for family_id, members in grouped.items():
        ordered = sorted(members, key=lambda item: (item["timestamp"], item["rollout_id"]))
        role_counts = Counter(member["role"] for member in ordered)
        role_tokens = {
            role: aggregate_tokens([member for member in ordered if member["role"] == role])
            for role in ROLE_NAMES
            if role_counts[role]
        }
        root = next((member for member in ordered if member["role"] == "root_task"), ordered[0])
        observed_start = min(member["observed_start"] for member in ordered)
        observed_end = max(member["observed_end"] for member in ordered)
        assistant_latencies = [value for member in ordered for value in member["assistant_latency_seconds"]]
        family_view = {
            "task_family_id": stable_identifier(family_id, config, "task"),
            "root_rollout_id": (
                stable_identifier(root["rollout_id"], config, "rollout")
                if root["role"] == "root_task"
                else None
            ),
            "date": root["timestamp"].date().isoformat(),
            "project": root["project"],
            "platform": root["platform"],
            "title": public_by_rollout[root["rollout_id"]]["title"],
            "work_area": root["work_area"],
            "meta_analysis": any(bool(member.get("meta_analysis")) for member in ordered),
            "user_messages": sum(member["user_messages"] for member in ordered),
            "correction_messages": sum(member["correction_messages"] for member in ordered),
            "complexity_score": safe_round(sum(member["complexity_score"] for member in ordered)),
            "rollout_count": len(ordered),
            "rollout_ids": [stable_identifier(member["rollout_id"], config, "rollout") for member in ordered],
            "role_counts": dict(sorted(role_counts.items())),
            "role_token_totals": role_tokens,
            "tokens": aggregate_tokens(ordered),
            "tool_calls": sum(member["tool_calls"] for member in ordered),
            "structured_failures": sum(member["tool_failures"] for member in ordered),
            "text_error_signals": sum(member["text_error_signals"] for member in ordered),
            "diagnostic_nonzero": sum(member["diagnostic_nonzero"] for member in ordered),
            "failure_causes": dict(sum((member["failure_causes"] for member in ordered), Counter())),
            "retry_classification": {
                "unchanged": sum(member["unchanged_retries"] for member in ordered),
                "after_state_change": sum(member["state_change_retries"] for member in ordered),
                "polling": sum(member["polling_retries"] for member in ordered),
            },
            "completion": family_completion(ordered),
            "timing": {
                "first_response_seconds": safe_round(assistant_latencies[0]) if assistant_latencies else 0,
                "median_response_seconds": safe_round(statistics.median(assistant_latencies)) if assistant_latencies else 0,
                "p90_response_seconds": safe_round(percentile(assistant_latencies, 0.9)) if assistant_latencies else 0,
                "observed_wall_seconds": safe_round((observed_end - observed_start).total_seconds()),
                "active_seconds": safe_round(sum(member["duration_ms"] for member in ordered) / 1000),
                "tool_run_seconds": safe_round(sum(member["tool_run_seconds"] for member in ordered)),
                "wait_seconds": safe_round(sum(member["wait_seconds"] for member in ordered)),
                "action_reviewer_active_seconds_proxy": safe_round(
                    sum(member["duration_ms"] for member in ordered if member["role"] == "action_reviewer") / 1000
                ),
                "measurement": {
                    "first_response_seconds": "measured",
                    "median_response_seconds": "measured",
                    "p90_response_seconds": "measured",
                    "observed_wall_seconds": "measured",
                    "active_seconds": "proxy",
                    "tool_run_seconds": "proxy",
                    "wait_seconds": "proxy",
                    "action_reviewer_active_seconds_proxy": "proxy",
                },
            },
            "classification_basis": (
                "structured" if all(member["classification_basis"] == "structured" for member in ordered) else "heuristic"
            ),
        }
        families.append(family_view)
    return sorted(families, key=lambda item: (item["date"], item["task_family_id"]), reverse=True)


def build_recommendations(
    totals: dict[str, Any],
    interaction_metrics: dict[str, Any],
    coverage: dict[str, Any],
    projects: list[dict[str, Any]],
    locale: str = "zh-CN",
) -> list[dict[str, Any]]:
    if locale == "en":
        return build_recommendations_en(totals, interaction_metrics, coverage, projects)
    recommendations: list[dict[str, Any]] = []

    def add(feature: str, title: str, why: str, evidence: str, action: str, prompt: str, priority: str) -> None:
        recommendation_id = "rec-" + hashlib.sha256(
            f"{feature}\0{title}".encode("utf-8")
        ).hexdigest()[:12]
        recommendations.append(
            {
                "id": recommendation_id,
                "feature": feature,
                "title": title,
                "why": why,
                "evidence": evidence,
                "action": action,
                "copy_prompt": prompt,
                "priority": priority,
            }
        )

    if totals["tool_failures"] or totals["unchanged_retries"]:
        add(
            "验证检查点",
            "把失败恢复写进任务契约",
            "工具失败本身未必严重，但失败后重复执行会放大时间成本，并使长任务难以恢复。",
            f"检测到 {totals['tool_failures']} 次结构化工具失败，其中无相关状态变化的原样重试 {totals['unchanged_retries']} 次；状态变化后重试和轮询分别计量。",
            "要求代理在重试前先诊断原因、记录已完成状态，并从最近检查点继续。",
            "执行这个任务时，请在每个阶段结束后记录已完成项、产物和验证结果。工具失败时先诊断原因，不要原样重复调用；从最近的已验证检查点恢复。",
            "high",
        )
    if totals["permission_blocks"]:
        add(
            "权限规划",
            "在开工时声明授权边界",
            "长任务中途才遇到权限阻塞，会打断连续执行并增加人工往返。",
            f"{totals['permission_blocks']} 次权限阻塞分布在分析范围内。",
            "在提示词开头明确可读、可写、可运行和必须确认的操作，并让代理先汇总可能需要的授权。",
            "开始前先列出本任务需要读取、写入、运行和可能升级权限的操作。对同类安全命令集中请求最小范围授权；未经授权不要扩大范围。",
            "high",
        )
    if interaction_metrics["correction_rate_per_user_message"] >= 0.12:
        add(
            "AGENTS.md / 任务契约",
            "固定范围、证据和完成标准",
            "高频纠正类消息通常说明代理需要反复校准范围、表达或验证标准；该指标是启发式信号，不等同于错误率。",
            f"检测到 {interaction_metrics['correction_like_messages']} 条纠正倾向消息，占用户消息约 {interaction_metrics['correction_rate_per_user_message']:.0%}。",
            "把长期偏好放入项目级 AGENTS.md，把本次范围、禁止项和完成标准写进首条提示。",
            "先复述任务契约：目标、可编辑范围、禁止修改项、证据要求、验证方式和完成标准。确认无冲突后再执行；发现范围歧义时保持原状态并说明假设。",
            "high",
        )
    unfinished = coverage["partial_sessions"] + totals["aborted_turns"]
    if unfinished or interaction_metrics["long_running_sessions"]:
        add(
            "长任务编排",
            "为长任务设置阶段性可交付物",
            "长任务若只在最后产出结果，中止或上下文切换会让已完成工作难以复用。",
            f"有 {interaction_metrics['long_running_sessions']} 个长时会话；未完成会话 {coverage['partial_sessions']} 个，中止轮次 {totals['aborted_turns']} 个。",
            "按审计、实现、验证、交付拆成可恢复阶段，并在每阶段保存小型状态摘要。",
            "把任务拆成四个可恢复阶段：审计、实现、验证、交付。每阶段结束时输出状态摘要和下一步入口；即使会话中止，也能在新任务中从摘要继续。",
            "medium",
        )
    if totals["patches"] >= 20 and interaction_metrics["multi_agent_sessions"] <= max(2, totals["sessions"] // 20):
        add(
            "多代理验证",
            "把独立验证留给并行代理",
            "高密度修改由同一执行链自检时，容易沿用相同假设；独立验证适合复杂、可并行且风险较高的任务。",
            f"共应用 {totals['patches']} 次补丁，但只有 {interaction_metrics['multi_agent_sessions']} 个会话使用多代理。",
            "在大型跨文件修改后，并行安排结构检查、测试验证和范围审计；小任务无需强行委派。",
            "完成主要修改后，请用相互独立的验证任务检查：1）测试与运行结果；2）跨文件引用和一致性；3）是否超出用户授权范围。只汇总有证据的问题。",
            "medium",
        )
    if projects and projects[0]["sessions"] >= 5:
        dominant = projects[0]
        add(
            "可复用 Skill",
            "把高频项目流程封装成可重复入口",
            "重复项目最适合沉淀固定的输入、步骤、边界和验证协议，减少每次重新解释。",
            f"项目 {dominant['project']} 有 {dominant['sessions']} 个会话、{dominant['tool_calls']} 次工具调用。",
            "选择一个高频、稳定且可验证的工作流，提炼为 skill 或项目脚本；保留人工判断环节。",
            f"请分析项目 {dominant['project']} 中重复出现的工作流，提取稳定输入、执行步骤、禁止项、验证命令和失败恢复策略，并判断哪些部分适合做成可复用 skill。",
            "medium",
        )
    return recommendations[:6]


def build_recommendations_en(
    totals: dict[str, Any],
    interaction_metrics: dict[str, Any],
    coverage: dict[str, Any],
    projects: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    recommendations: list[dict[str, Any]] = []

    def add(feature: str, title: str, why: str, evidence: str, action: str, prompt: str, priority: str) -> None:
        recommendation_id = "rec-" + hashlib.sha256(f"{feature}\0{title}".encode()).hexdigest()[:12]
        recommendations.append({
            "id": recommendation_id, "feature": feature, "title": title, "why": why,
            "evidence": evidence, "action": action, "copy_prompt": prompt, "priority": priority,
        })

    if totals["tool_failures"] or totals["unchanged_retries"]:
        add(
            "Verification checkpoints", "Put failure recovery in the task contract",
            "Tool failures are recoverable, but unchanged retries amplify time cost and make long tasks harder to resume.",
            f"Observed {totals['tool_failures']} structured tool failures and {totals['unchanged_retries']} unchanged retries; retries after state changes and explicit polling are counted separately.",
            "Require diagnosis and a saved checkpoint before retrying.",
            "At the end of each phase, record completed work, artifacts, and validation. Diagnose a tool failure before retrying and resume from the latest verified checkpoint.", "high",
        )
    if totals["permission_blocks"]:
        add(
            "Permission planning", "State authorization boundaries at the start",
            "Late permission blocks interrupt execution and add avoidable user round trips.",
            f"Observed {totals['permission_blocks']} permission blocks in the analysis window.",
            "State readable, writable, runnable, and approval-required actions in the initial task contract.",
            "Before starting, list the reads, writes, commands, and possible permission escalations. Batch only closely related safe approvals and do not broaden scope without authorization.", "high",
        )
    if interaction_metrics["correction_rate_per_user_message"] >= 0.12:
        add(
            "AGENTS.md / task contract", "Fix scope, evidence, and completion criteria",
            "Frequent correction-like messages suggest repeated recalibration; this is a heuristic signal, not an error rate.",
            f"Observed {interaction_metrics['correction_like_messages']} correction-like messages, about {interaction_metrics['correction_rate_per_user_message']:.0%} of user messages.",
            "Keep durable preferences in AGENTS.md and state this task's scope, prohibitions, and completion criteria in the first prompt.",
            "Restate the task contract first: objective, editable scope, prohibited changes, required evidence, validation, and completion criteria. Preserve state and explain assumptions when scope is ambiguous.", "high",
        )
    unfinished = coverage["partial_sessions"] + totals["aborted_turns"]
    if unfinished or interaction_metrics["long_running_sessions"]:
        add(
            "Long-task orchestration", "Give long tasks recoverable phase deliverables",
            "When a long task produces only a final result, interruption or context switching makes completed work hard to reuse.",
            f"Observed {interaction_metrics['long_running_sessions']} long sessions, {coverage['partial_sessions']} partial sessions, and {totals['aborted_turns']} aborted turns.",
            "Split work into audit, implementation, validation, and delivery phases with a small state handoff after each.",
            "Split this task into four recoverable phases: audit, implementation, validation, and delivery. End each phase with a state summary and exact resume point.", "medium",
        )
    if totals["patches"] >= 20 and interaction_metrics["multi_agent_sessions"] <= max(2, totals["sessions"] // 20):
        add(
            "Independent validation", "Reserve parallel reviewers for complex changes",
            "A single execution chain may reuse the same assumptions when checking a high-density change.",
            f"Observed {totals['patches']} patches and {interaction_metrics['multi_agent_sessions']} multi-agent sessions.",
            "For large cross-file changes, independently check tests, references, and authorization scope; do not delegate small tasks by default.",
            "After the main change, independently verify: tests and runtime evidence; cross-file consistency; and whether the result stayed inside the authorized scope. Report only evidence-backed findings.", "medium",
        )
    if projects and projects[0]["sessions"] >= 5:
        dominant = projects[0]
        add(
            "Reusable Skill", "Turn a frequent project workflow into a repeatable entry point",
            "Repeated project work is a good candidate for stable inputs, steps, boundaries, and verification rules.",
            f"Project {dominant['project']} has {dominant['sessions']} sessions and {dominant['tool_calls']} tool calls.",
            "Choose one frequent, stable, verifiable workflow and extract it into a Skill or project script while preserving human judgment.",
            f"Analyze recurring workflows in project {dominant['project']}. Extract stable inputs, steps, prohibitions, validation commands, and recovery behavior, then identify what belongs in a reusable Skill.", "medium",
        )
    return recommendations[:6]


def build_insight_narrative(
    sessions: list[dict[str, Any]],
    session_summaries: list[dict[str, Any]],
    totals: dict[str, Any],
    coverage: dict[str, Any],
    projects: list[dict[str, Any]],
    interaction_metrics: dict[str, Any],
    recommendations: list[dict[str, Any]],
    locale: str = "zh-CN",
) -> dict[str, Any]:
    if locale == "en":
        return build_insight_narrative_en(
            sessions, session_summaries, totals, coverage, projects, interaction_metrics, recommendations
        )
    completed = [row for row in session_summaries if row["status"] == "completed"]
    completed_complex = [row for row in completed if row["complexity_score"] >= 40]
    dominant = projects[0] if projects else None
    completion_rate = len(completed) / max(1, len(session_summaries))
    top_failure = totals["tool_failures"]
    quick_win = recommendations[0]["title"] if recommendations else "继续保持当前验证节奏"

    if dominant:
        strength = (
            f"工作明显集中在 {dominant['project']}：{dominant['sessions']} 个会话、"
            f"{dominant['active_hours']} 小时和 {dominant['tool_calls']} 次工具调用。"
        )
    else:
        strength = "当前范围内没有足够的项目数据来识别稳定工作重心。"
    blocker = (
        f"主要可量化摩擦是 {top_failure} 次结构化工具失败、{totals['unchanged_retries']} 次无状态变化的原样重试、"
        f"{totals['permission_blocks']} 次权限阻塞；这些信号需要结合具体会话判断。"
    )
    ambition = (
        f"已有 {len(completed_complex)} 个高复杂度会话完成，{interaction_metrics['long_running_sessions']} 个会话持续超过 30 分钟。"
        "下一步适合把高频长流程升级为带检查点、独立验证和失败恢复的端到端工作流。"
    )

    wins: list[dict[str, str]] = []
    if dominant:
        wins.append(
            {
                "title": "形成稳定的核心工作域",
                "description": strength,
                "evidence": f"该项目占全部会话的 {dominant['sessions'] / max(1, totals['sessions']):.0%}。",
            }
        )
    wins.append(
        {
            "title": "复杂任务具备持续执行能力",
            "description": f"{len(completed_complex)} 个复杂度不低于 40 的会话达到完成状态；总体完成状态占比约 {completion_rate:.0%}。",
            "evidence": "完成状态表示日志中未检测到未结束或中止标记，不代表产物质量已经人工验收。",
        }
    )
    if totals["patches"]:
        wins.append(
            {
                "title": "从讨论进入了实质修改",
                "description": f"分析范围内记录到 {totals['patches']} 次补丁和 {totals['git_commits']} 次提交。",
                "evidence": f"补丁失败信号为 {totals['failed_patches']} 次；仍应以测试和产物检查判断修改质量。",
            }
        )

    horizon = [
        {
            "title": "可恢复的端到端工作流",
            "possible": "把审计、实现、验证和交付连接成一个带状态摘要与检查点的流程，减少长会话中断后的重复劳动。",
            "starting_point": "先为最常见项目流程定义每一阶段的输入、完成条件和恢复入口。",
        },
        {
            "title": "证据驱动的主动质量检查",
            "possible": "在完成前自动核对测试、跨文件引用、产物结构和授权范围，把问题从运行后返工提前到交付前。",
            "starting_point": "给高风险任务增加独立验证清单，并要求每个结论链接到日志、测试或产物证据。",
        },
        {
            "title": "从高频会话提炼自更新 Skill",
            "possible": "将重复提示和人工纠正沉淀为稳定的工作流契约，同时保留会随项目变化的参数。",
            "starting_point": "每月复查高频纠正和失败恢复模式，只更新确有重复证据的 skill 规则。",
        },
    ]
    return {
        "glance": [
            {"label": "做得好的地方", "text": strength},
            {"label": "主要阻碍", "text": blocker},
            {"label": "快速见效", "text": quick_win},
            {"label": "值得推进的工作流", "text": ambition},
        ],
        "wins": wins,
        "horizon": horizon,
    }


def build_insight_narrative_en(
    sessions: list[dict[str, Any]],
    session_summaries: list[dict[str, Any]],
    totals: dict[str, Any],
    coverage: dict[str, Any],
    projects: list[dict[str, Any]],
    interaction_metrics: dict[str, Any],
    recommendations: list[dict[str, Any]],
) -> dict[str, Any]:
    completed = [row for row in session_summaries if row["status"] == "completed"]
    completed_complex = [row for row in completed if row["complexity_score"] >= 40]
    dominant = projects[0] if projects else None
    completion_rate = len(completed) / max(1, len(session_summaries))
    quick_win = recommendations[0]["title"] if recommendations else "Keep the current verification rhythm"
    strength = (
        f"Work is concentrated in {dominant['project']}: {english_count(dominant['sessions'], 'session')}, "
        f"{english_count(dominant['active_hours'], 'active hour')}, and {english_count(dominant['tool_calls'], 'tool call')}."
        if dominant else "There is not enough project data in this range to identify a stable center of work."
    )
    blocker = (
        f"The main measurable friction is {english_count(totals['tool_failures'], 'structured tool failure')}, "
        f"{english_count(totals['unchanged_retries'], 'unchanged retry', 'unchanged retries')}, and "
        f"{english_count(totals['permission_blocks'], 'permission block')}; inspect individual sessions before drawing causal conclusions."
    )
    ambition = (
        f"{english_count(len(completed_complex), 'high-complexity session')} reached a completed log state, and "
        f"{english_count(interaction_metrics['long_running_sessions'], 'session')} lasted more than 30 minutes. "
        "The next step is to make frequent long workflows checkpointed, independently verified, and recoverable."
    )
    wins = []
    if dominant:
        wins.append({"title": "A stable core work area is emerging", "description": strength, "evidence": f"This project accounts for {dominant['sessions'] / max(1, totals['sessions']):.0%} of sessions."})
    wins.append({
        "title": "Complex tasks sustain execution",
        "description": f"{english_count(len(completed_complex), 'session')} with complexity at least 40 reached completed log state; the overall completed-log share is about {completion_rate:.0%}.",
        "evidence": "Completed log state means no unfinished or aborted marker was detected; it is not human acceptance or a quality judgment.",
    })
    if totals["patches"]:
        wins.append({
            "title": "Work moved from discussion into concrete changes",
            "description": f"The range contains {english_count(totals['patches'], 'patch', 'patches')} and {english_count(totals['git_commits'], 'commit')}.",
            "evidence": f"There were {english_count(totals['failed_patches'], 'patch-failure signal')}; tests and artifact inspection still determine change quality.",
        })
    horizon = [
        {"title": "Recoverable end-to-end workflows", "possible": "Connect audit, implementation, validation, and delivery with checkpoints and small state summaries.", "starting_point": "Define inputs, completion criteria, and resume points for each phase of the most common workflow."},
        {"title": "Evidence-driven proactive quality checks", "possible": "Check tests, references, artifact structure, and authorization scope before delivery.", "starting_point": "Add an independent validation checklist to high-risk tasks and require each conclusion to cite logs, tests, or artifacts."},
        {"title": "Self-updating Skills from frequent sessions", "possible": "Turn repeated prompts and corrections into stable workflow contracts while leaving project-specific details parameterized.", "starting_point": "Review frequent corrections and recovery patterns monthly, and update Skill rules only when evidence repeats."},
    ]
    return {
        "glance": [
            {"label": "What is working", "text": strength}, {"label": "Main blocker", "text": blocker},
            {"label": "Quick win", "text": quick_win}, {"label": "Workflow worth advancing", "text": ambition},
        ],
        "wins": wins,
        "horizon": horizon,
    }


def build_provider_stats(sessions: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    model_session_ids: dict[tuple[str, str], set[str]] = defaultdict(set)
    provider_session_ids: dict[str, set[str]] = defaultdict(set)
    for session in sessions:
        session_id = str(session.get("rollout_id") or id(session))
        for provider, model in session["provider_models"]:
            model_session_ids[(provider, model)].add(session_id)
            provider_session_ids[provider].add(session_id)
    provider_models = [
        {"provider": provider, "model": model, "sessions": len(session_ids)}
        for (provider, model), session_ids in sorted(model_session_ids.items())
    ]
    by_provider: dict[str, dict[str, int]] = defaultdict(dict)
    for (provider, model), session_ids in model_session_ids.items():
        by_provider[provider][model] = len(session_ids)
    providers = [
        {
            "provider": provider,
            "sessions": len(provider_session_ids[provider]),
            "models": [
                {"model": model, "sessions": count}
                for model, count in sorted(by_provider[provider].items())
            ],
        }
        for provider in sorted(by_provider)
    ]
    return providers, provider_models


def parse_with_deterministic_cache(
    path: Path,
    config: AnalysisConfig,
    coverage: dict[str, Any],
    parse_file: Any,
) -> dict[str, Any] | None:
    if not config.deterministic_cache:
        coverage["deterministic_cache"]["disabled"] += 1
        return parse_file(path, config, coverage)
    try:
        source_digest = file_sha256(path)
    except OSError:
        coverage["deterministic_cache"]["misses"] += 1
        return parse_file(path, config, coverage)
    contract = deterministic_parser_contract(config)
    fingerprint = hashlib.sha256(
        json.dumps(
            {"source_sha256": source_digest, "contract": contract},
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    path_key = hashlib.sha256(str(path.resolve()).encode("utf-8", errors="replace")).hexdigest()
    cache_dir = deterministic_cache_home(config)
    cache_path = cache_dir / f"{path_key}.json"
    if not config.refresh_deterministic_cache and cache_path.is_file():
        try:
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
            if (
                cached.get("cache_version") == DETERMINISTIC_CACHE_VERSION
                and cached.get("fingerprint") == fingerprint
            ):
                delta = cache_decode(cached.get("coverage_delta", {}))
                session = cache_decode(cached.get("session"))
                if not isinstance(delta, dict) or (session is not None and not isinstance(session, dict)):
                    raise ValueError("invalid deterministic cache payload")
                apply_coverage_delta(coverage, delta)
                coverage["deterministic_cache"]["hits"] += 1
                return apply_cached_scope(session, config, coverage)
            coverage["deterministic_cache"]["invalidations"] += 1
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            coverage["deterministic_cache"]["invalidations"] += 1
    elif config.refresh_deterministic_cache and cache_path.is_file():
        coverage["deterministic_cache"]["invalidations"] += 1
    parse_config = replace(
        config,
        since=datetime.min.replace(tzinfo=timezone.utc),
        until=datetime.max.replace(tzinfo=timezone.utc),
        project=None,
    )
    parse_coverage = parse_coverage_state()
    session = parse_file(path, parse_config, parse_coverage)
    delta = cached_parse_delta(parse_coverage)
    apply_coverage_delta(coverage, delta)
    coverage["deterministic_cache"]["misses"] += 1
    cache_session = None
    if session is not None:
        cache_session = dict(session)
        cache_session["first_prompt"] = local_text(str(session.get("first_prompt") or ""), 12000)
        cache_session["provider_title"] = local_text(str(session.get("provider_title") or ""), 12000)
        cache_session["fallback_title"] = local_text(str(session.get("fallback_title") or ""), 12000)
        for transient_key in ("calls", "last_failed_calls", "approval_requests", "semantic_message_digests"):
            cache_session[transient_key] = {} if transient_key != "semantic_message_digests" else set()
    payload = {
        "cache_version": DETERMINISTIC_CACHE_VERSION,
        "fingerprint": fingerprint,
        "source_sha256": source_digest,
        "contract": contract,
        "coverage_delta": cache_encode(delta),
        "session": cache_encode(cache_session),
    }
    temporary = cache_path.with_name(f".{cache_path.name}.{os.getpid()}.tmp")
    try:
        cache_dir.mkdir(parents=True, exist_ok=True)
        temporary.write_text(json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
        temporary.replace(cache_path)
    except OSError:
        coverage["deterministic_cache"]["write_errors"] += 1
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
    return apply_cached_scope(session, config, coverage)


def build_report(
    config: AnalysisConfig,
    *,
    include_internal_sessions: bool = False,
    session_snapshots: Iterable[dict[str, Any]] | None = None,
) -> dict[str, Any] | tuple[dict[str, Any], list[dict[str, Any]]]:
    snapshots = list(session_snapshots) if session_snapshots is not None else None
    if snapshots is None:
        get_zstandard()
    sessions_root = session_source_root(config) / "sessions"
    paths = sorted(sessions_root.rglob("session.jsonl.zstd")) if snapshots is None and sessions_root.is_dir() else []
    parse_file = parse_dsh_session_file
    coverage: dict[str, Any] = {
        "files_scanned": len(paths) if snapshots is None else len(snapshots),
        "sessions_analyzed": 0,
        "skipped_outside_window": 0,
        "skipped_project": 0,
        "missing_metadata": 0,
        "unreadable_files": 0,
        "malformed_lines": 0,
        "partial_sessions": 0,
        "unknown_record_types": Counter(),
        "deterministic_cache": {"enabled": config.deterministic_cache, "hits": 0, "misses": 0, "invalidations": 0, "disabled": 0, "write_errors": 0},
        "since": config.since.isoformat().replace("+00:00", "Z"),
        "until": config.until.isoformat().replace("+00:00", "Z"),
    }
    sessions: list[dict[str, Any]] = []
    if snapshots is None:
        for path in paths:
            parsed = parse_with_deterministic_cache(path, config, coverage, parse_file)
            if parsed is not None:
                sessions.append(parsed)
    else:
        coverage["deterministic_cache"]["enabled"] = False
        for index, snapshot in enumerate(snapshots):
            if not isinstance(snapshot, dict):
                coverage["malformed_lines"] += 1
                continue
            header = snapshot.get("session")
            events = snapshot.get("events")
            if not isinstance(header, dict) or not isinstance(events, list):
                coverage["malformed_lines"] += 1
                continue
            session_id = str(header.get("id") or f"stream-{index:06d}")
            synthetic_path = sessions_root / "session-query" / session_id / "session.jsonl"
            records = [{"type": "session", **header}]
            records.extend(events)
            parsed = parse_dsh_session_records(
                records,
                config,
                coverage,
                source_path=synthetic_path,
                workspace_key="session-query",
            )
            coverage["deterministic_cache"]["disabled"] += 1
            if parsed is not None:
                sessions.append(parsed)
    coverage["sessions_analyzed"] = len(sessions)
    coverage["unknown_record_types"] = dict(sorted(coverage["unknown_record_types"].items()))

    total_tokens = aggregate_tokens(sessions)
    totals = {
        "sessions": len(sessions),
        "turns": sum(len(session["turn_ids"]) for session in sessions),
        "user_messages": sum(session["user_messages"] for session in sessions),
        "assistant_messages": sum(session["assistant_messages"] for session in sessions),
        "active_hours": safe_round(sum(session["duration_ms"] for session in sessions) / 3600000),
        "tool_calls": sum(session["tool_calls"] for session in sessions),
        "tool_failures": sum(session["tool_failures"] for session in sessions),
        "structured_failures": sum(session["tool_failures"] for session in sessions),
        "text_error_signals": sum(session["text_error_signals"] for session in sessions),
        "diagnostic_nonzero": sum(session["diagnostic_nonzero"] for session in sessions),
        "patches": sum(session["patches"] for session in sessions),
        "failed_patches": sum(session["failed_patches"] for session in sessions),
        "subagents": sum(session["subagents"] for session in sessions),
        "web_searches": sum(session["web_searches"] for session in sessions),
        "mcp_calls": sum(session["mcp_calls"] for session in sessions),
        "aborted_turns": sum(session["aborted_turns"] for session in sessions),
        "permission_blocks": sum(session["permission_blocks"] for session in sessions),
        "repeated_retries": sum(session["repeated_retries"] for session in sessions),
        "unchanged_retries": sum(session["unchanged_retries"] for session in sessions),
        "state_change_retries": sum(session["state_change_retries"] for session in sessions),
        "polling_retries": sum(session["polling_retries"] for session in sessions),
        "git_commits": sum(session["git_commits"] for session in sessions),
        "tokens": total_tokens,
    }
    totals["llm_retries"] = sum(session["llm_retries"] for session in sessions)
    totals["denied_approvals"] = sum(session["denied_approvals"] for session in sessions)

    project_map: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for session in sessions:
        project_map[session["project"]].append(session)
    projects = []
    for label, project_sessions in project_map.items():
        project_tools = Counter()
        for session in project_sessions:
            project_tools.update(session["tool_counts"])
        projects.append(
            {
                "project": label,
                "sessions": len(project_sessions),
                "turns": sum(len(item["turn_ids"]) for item in project_sessions),
                "active_hours": safe_round(sum(item["duration_ms"] for item in project_sessions) / 3600000),
                "tool_calls": sum(item["tool_calls"] for item in project_sessions),
                "tool_failures": sum(item["tool_failures"] for item in project_sessions),
                "total_tokens": sum(item["tokens"]["total_tokens"] for item in project_sessions),
                "top_tools": [name for name, _ in project_tools.most_common(5)],
            }
        )
    projects.sort(key=lambda item: (item["sessions"], item["tool_calls"]), reverse=True)

    prompts = [length for session in sessions for length in session["prompt_lengths"]]
    turns = [len(session["turn_ids"]) for session in sessions]
    assistant_latencies = [value for session in sessions for value in session["assistant_latency_seconds"]]
    user_responses = [value for session in sessions for value in session["user_response_seconds"]]
    concurrency = concurrency_metrics(sessions)
    interaction_metrics = {
        "average_turns_per_session": safe_round(statistics.mean(turns) if turns else 0.0),
        "median_turns_per_session": safe_round(statistics.median(turns) if turns else 0.0),
        "median_prompt_chars": int(statistics.median(prompts)) if prompts else 0,
        "p90_prompt_chars": int(percentile([float(value) for value in prompts], 0.9)) if prompts else 0,
        "correction_like_messages": sum(session["correction_messages"] for session in sessions),
        "correction_rate_per_user_message": safe_round(
            sum(session["correction_messages"] for session in sessions) / max(1, totals["user_messages"])
        ),
        "clarification_requests": sum(session["clarification_requests"] for session in sessions),
        "aborted_turn_rate": safe_round(totals["aborted_turns"] / max(1, totals["turns"])),
        "tool_calls_per_turn": safe_round(totals["tool_calls"] / max(1, totals["turns"])),
        "multi_agent_sessions": sum(1 for session in sessions if session["subagents"] > 0),
        "long_running_sessions": sum(1 for session in sessions if session["duration_ms"] >= 30 * 60 * 1000),
        "quick_check_sessions": sum(1 for session in sessions if session["session_type"] == "quick_check"),
        "median_assistant_latency_seconds": safe_round(statistics.median(assistant_latencies)) if assistant_latencies else 0,
        "median_user_response_seconds": safe_round(statistics.median(user_responses)) if user_responses else 0,
        **concurrency,
    }

    failure_tools = Counter()
    for session in sessions:
        failure_tools.update(session["failure_tools"])
    friction_signals = [
        {
            "signal": "tool_failures",
            "count": totals["tool_failures"],
            "affected_sessions": sum(1 for session in sessions if session["tool_failures"] > 0),
            "top_tools": [name for name, _ in failure_tools.most_common(5)],
        },
        {
            "signal": "aborted_turns",
            "count": totals["aborted_turns"],
            "affected_sessions": sum(1 for session in sessions if session["aborted_turns"] > 0),
        },
        {
            "signal": "repeated_retries_after_failure",
            "count": totals["unchanged_retries"],
            "affected_sessions": sum(1 for session in sessions if session["unchanged_retries"] > 0),
        },
        {
            "signal": "retries_after_state_change",
            "count": totals["state_change_retries"],
            "affected_sessions": sum(1 for session in sessions if session["state_change_retries"] > 0),
        },
        {
            "signal": "polling_retries",
            "count": totals["polling_retries"],
            "affected_sessions": sum(1 for session in sessions if session["polling_retries"] > 0),
        },
        {
            "signal": "permission_blocks",
            "count": totals["permission_blocks"],
            "affected_sessions": sum(1 for session in sessions if session["permission_blocks"] > 0),
        },
        {
            "signal": "failed_patches",
            "count": totals["failed_patches"],
            "affected_sessions": sum(1 for session in sessions if session["failed_patches"] > 0),
        },
    ]
    friction_signals.extend(
        [
            {
                "signal": "llm_retries",
                "count": totals["llm_retries"],
                "affected_sessions": sum(1 for session in sessions if session["llm_retries"] > 0),
            },
            {
                "signal": "denied_approvals",
                "count": totals["denied_approvals"],
                "affected_sessions": sum(1 for session in sessions if session["denied_approvals"] > 0),
            },
        ]
    )
    friction_signals = [item for item in friction_signals if item["count"] > 0]

    session_summaries = [session_public_view(session, config) for session in sessions]
    public_by_rollout = {session["rollout_id"]: public for session, public in zip(sessions, session_summaries)}
    task_families = build_task_families(sessions, public_by_rollout, config)
    coverage["heuristic_role_rollouts"] = sum(
        1 for session in sessions if session["classification_basis"] == "heuristic"
    )
    coverage["unknown_system_rollouts"] = sum(
        1 for session in sessions if session["role"] == "unknown_system_rollout"
    )
    coverage["task_families_without_root"] = sum(
        1 for family in task_families if family["root_rollout_id"] is None
    )
    role_metrics = []
    all_token_total = max(1, total_tokens["total_tokens"])
    for role in ROLE_NAMES:
        role_sessions = [session for session in sessions if session["role"] == role]
        if not role_sessions:
            continue
        role_token_totals = aggregate_tokens(role_sessions)
        role_metrics.append(
            {
                "role": role,
                "rollouts": len(role_sessions),
                "task_families": len({session["family_id"] for session in role_sessions}),
                "tokens": role_token_totals,
                "total_token_share": safe_round(role_token_totals["total_tokens"] / all_token_total, 4),
                "tool_calls": sum(session["tool_calls"] for session in role_sessions),
                "structured_failures": sum(session["tool_failures"] for session in role_sessions),
            }
        )
    platform_metrics = []
    for platform in sorted({session["platform"] for session in sessions}):
        platform_sessions = [session for session in sessions if session["platform"] == platform]
        platform_tokens = aggregate_tokens(platform_sessions)
        platform_metrics.append(
            {
                "platform": platform,
                "rollouts": len(platform_sessions),
                "task_families": len({session["family_id"] for session in platform_sessions}),
                "tokens": platform_tokens,
                "total_token_share": safe_round(platform_tokens["total_tokens"] / all_token_total, 4),
                "tool_calls": sum(session["tool_calls"] for session in platform_sessions),
                "structured_failures": sum(session["tool_failures"] for session in platform_sessions),
            }
        )
    workflow_candidates = sorted(session_summaries, key=lambda item: item["complexity_score"], reverse=True)[:5]
    area_map: dict[str, list[dict[str, Any]]] = defaultdict(list)
    type_counter: Counter[str] = Counter()
    tool_counter: Counter[str] = Counter()
    extension_counter: Counter[str] = Counter()
    skill_counter: Counter[str] = Counter()
    hour_counter: Counter[int] = Counter()
    weekday_counter: Counter[int] = Counter()
    skill_usage_counter: Counter[str] = Counter()
    plugin_usage_counter: Counter[str] = Counter()
    for session, public in zip(sessions, session_summaries):
        area_map[public["work_area"]].append(public)
        type_counter[public["session_type"]] += 1
        tool_counter.update(session["tool_counts"])
        extension_counter.update(session["file_extensions"])
        skill_counter.update(session["skill_mentions"])
        skill_usage_counter.update(session["skill_counts"])
        plugin_usage_counter.update(session["mcp_server_counts"])
        hour_counter[public["start_hour_local"]] += 1
        weekday_counter[public["weekday"]] += 1
    work_areas = []
    for name, rows in area_map.items():
        examples: list[str] = []
        for row in sorted(rows, key=lambda item: item["complexity_score"], reverse=True):
            title = row["title"]
            if title not in {"未提供可用标题", "内容已省略"} and title not in examples:
                examples.append(title)
            if len(examples) >= 3:
                break
        work_areas.append(
            {
                "area": name,
                "sessions": len(rows),
                "turns": sum(row["turns"] for row in rows),
                "active_hours": safe_round(sum(row["active_minutes"] for row in rows) / 60),
                "tool_calls": sum(row["tool_calls"] for row in rows),
                "examples": examples,
            }
        )
    work_areas.sort(key=lambda item: (item["sessions"], item["tool_calls"]), reverse=True)
    usage_profile = {
        "session_types": [{"type": name, "count": count} for name, count in type_counter.most_common()],
        "top_tools": [{"tool": name, "count": count} for name, count in tool_counter.most_common(12)],
        "file_types": [{"extension": name, "count": count} for name, count in extension_counter.most_common(12)],
        "skill_mentions": [{"skill": name, "count": count} for name, count in skill_counter.most_common(12)],
        "skill_usage": [{"skill": name, "count": count} for name, count in skill_usage_counter.most_common(10)],
        "plugin_usage": [{"name": name, "count": count} for name, count in plugin_usage_counter.most_common(10)],
        "hours_local": [{"hour": hour, "count": hour_counter.get(hour, 0)} for hour in range(24)],
        "weekdays": [{"weekday": day, "count": weekday_counter.get(day, 0)} for day in range(7)],
    }
    recommendations = build_recommendations(totals, interaction_metrics, coverage, projects, config.locale)
    narrative = build_insight_narrative(
        sessions,
        session_summaries,
        totals,
        coverage,
        projects,
        interaction_metrics,
        recommendations,
        config.locale,
    )
    warnings = []
    def warning(zh: str, en: str) -> None:
        warnings.append(en if config.locale == "en" else zh)
    if not paths and snapshots is None:
        warning("在解析后的 DSH_HOME 下未找到 DSH 会话文件（session.jsonl.zstd）。", "No DSH session files (session.jsonl.zstd) were found under the resolved DSH_HOME.")
    if 0 < len(sessions) < 5:
        warning("有效会话少于 5 个；请将行为结论视为小样本快照。", "Fewer than five sessions are in scope; treat behavioral conclusions as a small-sample snapshot.")
    if coverage["malformed_lines"] or coverage["unknown_record_types"] or coverage["unreadable_files"]:
        warning("存在损坏行、未知记录类型或不可读文件；形成明确结论前请先检查覆盖情况。", "Malformed lines, unknown record types, or unreadable files were observed; inspect coverage before drawing firm conclusions.")
    if coverage["partial_sessions"]:
        warning(f"有 {coverage['partial_sessions']} 个 rollout 含未结束任务标记；这不自动等于整个任务族失败。", f"{coverage['partial_sessions']} rollouts contain unfinished-task markers; this does not automatically mean their task families failed.")
    if coverage["heuristic_role_rollouts"] or coverage["unknown_system_rollouts"]:
        warning("部分 rollout 使用启发式角色分类或未映射到已知角色；已保守降级并记录 classification_basis。", "Some rollouts use heuristic role classification or do not map to a known role; they were conservatively downgraded with classification_basis recorded.")
    if coverage["deterministic_cache"].get("write_errors"):
        warning("确定性解析缓存不可写；本次分析已完成，但后续运行可能无法复用这些解析结果。", "The deterministic parse cache was not writable; this run completed, but later runs may not reuse its parsed results.")

    report = {
        "schema": SCHEMA_ID,
        "schema_version": SCHEMA_VERSION,
        "analyzer_version": ANALYZER_VERSION,
        "product": "dsh-session-insights",
        "runtime": "dsh",
        "generated_at": (config.generated_at or config.until).isoformat().replace("+00:00", "Z"),
        "scope": {
            "runtime": "dsh",
            "project": project_label(config.project) if config.project else None,
            "privacy_mode": "metrics_only" if config.metrics_only or config.privacy_mode == "metrics" else ("redacted_sample" if config.privacy_mode == "redacted" else "local_content"),
            "analysis_privacy_mode": analysis_privacy(config),
            "analysis_depth": config.analysis_depth,
            "locale": config.locale,
            "max_excerpts": 0 if config.metrics_only or config.privacy_mode == "metrics" else config.max_excerpts,
        },
        "coverage": coverage,
        "totals": totals,
        "measurement_contract": {
            "tokens": (
                "DSH usage is deduplicated per (turn,step); usage.inputTokens maps to "
                "uncached_input_tokens and cacheReadTokens/cacheWriteTokens are summed per step; "
                "outputTokens already includes reasoningTokens as a subdivision and total is "
                "uncached+cacheRead+cacheWrite+output; not billing or quota"
            ),
            "cached_input_tokens": "measured but not equivalent to free or ordinary input",
            "timing": "wall time measured where timestamps exist; active/tool/wait/reviewer fields are proxies unless noted",
            "causality": "savings and recommendations require measured, proxy, or inferred labels",
            "failure_rule_version": FAILURE_RULE_VERSION,
            "patches": "not_applicable",
        },
        "task_family_totals": {
            "task_families": len(task_families),
            "rollouts": len(sessions),
            "root_tasks": sum(1 for session in sessions if session["role"] == "root_task"),
            "verified_completed": sum(1 for family in task_families if family["completion"]["verified_completed"] == "yes"),
            "accepted": sum(1 for family in task_families if family["completion"]["accepted"] == "yes"),
        },
        "role_metrics": role_metrics,
        "platform_metrics": platform_metrics,
        "projects": projects,
        "work_areas": work_areas,
        "usage_profile": usage_profile,
        "interaction_metrics": interaction_metrics,
        "friction_signals": friction_signals,
        "narrative": narrative,
        "recommendations": recommendations,
        "visualization_capabilities": {
            "time_comparison": "selected_range_halves",
            "work_area_drilldown": True,
            "recommendation_tracking": "browser_local_storage",
        },
        "workflow_candidates": workflow_candidates,
        "rollout_summaries": session_summaries,
        "task_families": task_families,
        "session_summaries": session_summaries,
        "excerpts": select_excerpts(sessions, config),
        "warnings": warnings,
    }
    providers, provider_models = build_provider_stats(sessions)
    report["providers"] = providers
    report["provider_models"] = provider_models
    if include_internal_sessions:
        return report, sessions
    return report


def render_markdown(report: dict[str, Any]) -> str:
    coverage = report["coverage"]
    totals = report["totals"]
    metrics = report["interaction_metrics"]
    privacy_labels = {"local_content": "本地丰富内容（自动去密钥）", "redacted_sample": "脱敏抽样", "metrics_only": "仅结构指标"}
    area_labels = {
        "research_writing": "研究与论文写作", "experiments_data": "实验与数据分析",
        "skills_configuration": "Skill、插件与配置", "documents_presentations": "文档、报告与演示",
        "software_engineering": "软件工程", "web_sites": "网站与前端", "general": "其他工作",
    }
    type_labels = {
        "quick_check": "快速检查", "multi_agent": "多代理协作", "implementation": "实现与修改",
        "research": "研究与检索", "tool_driven": "工具驱动任务", "conversation": "讨论与规划",
    }
    runtime_name = "DSH"
    token_note = (
        "Token 口径：按 (turn,step) 去重后与 DSH 原生 token-meter 投影一致；"
        "inputTokens 计入非缓存输入，cacheRead/cacheWrite 逐 step 求和，"
        "outputTokens 已含 reasoningTokens 细分，total 不再重复累加 reasoning。"
        "缓存输入不等于免费或普通输入，且不得据此推导账单或配额。"
    )
    lines = [
        f"# {runtime_name} 使用洞察", "", f"分析时段：{coverage['since']} 至 {coverage['until']}",
        f"内容模式：{privacy_labels.get(report['scope']['privacy_mode'], report['scope']['privacy_mode'])}",
        f"分析器：{report['analyzer_version']}；Schema：v{report['schema_version']}",
        token_note,
        "", "## 一眼看懂", "",
    ]
    lines.extend(f"- **{item['label']}**：{item['text']}" for item in report.get("narrative", {}).get("glance", []))
    lines.extend([
        "", "## 覆盖情况", "", f"- 扫描文件：{coverage['files_scanned']}",
        f"- 纳入 rollout：{coverage['sessions_analyzed']}",
        f"- 归并任务族：{report['task_family_totals']['task_families']}",
        f"- 因时间范围跳过：{coverage['skipped_outside_window']}",
        f"- 因项目筛选跳过：{coverage['skipped_project']}", f"- 损坏行：{coverage['malformed_lines']}",
        f"- 未完成会话：{coverage['partial_sessions']}", "", "## 概览", "",
        f"- rollout：{totals['sessions']}", f"- 轮次数：{totals['turns']}", f"- 活跃小时（proxy）：{totals['active_hours']}",
        f"- 工具调用：{totals['tool_calls']}（结构化失败 {totals['structured_failures']}；文本错误信号 {totals['text_error_signals']}；诊断性非零 {totals['diagnostic_nonzero']}）",
        f"- 日志原始 Token：输入 {totals['tokens']['input_tokens']}；缓存输入 {totals['tokens']['cached_input_tokens']}；非缓存输入 {totals['tokens']['uncached_input_tokens']}；输出 {totals['tokens']['output_tokens']}；总计 {totals['tokens']['total_tokens']}",
        f"- 已验证完成任务族：{report['task_family_totals']['verified_completed']}；明确接受任务族：{report['task_family_totals']['accepted']}",
        f"- 补丁：{totals['patches']}（失败 {totals['failed_patches']}）",
        f"- 子代理：{totals['subagents']}", "", "## 你的工作内容", "",
    ])
    if report.get("work_areas"):
        for area in report["work_areas"]:
            lines.append(
                f"- **{area_labels.get(area['area'], area['area'])}**：{area['sessions']} 个会话，{area['turns']} 轮，"
                f"活跃 {area['active_hours']} 小时，{area['tool_calls']} 次工具调用"
            )
            if area.get("examples"):
                lines.append(f"  - 代表任务：{'；'.join(area['examples'][:3])}")
    else:
        lines.append("- 没有足够内容用于归纳工作领域。")
    lines.extend([
        "", f"## 如何使用 {runtime_name}", "", f"- 平均每会话轮次：{metrics['average_turns_per_session']}",
        f"- 提示词字符中位数：{metrics['median_prompt_chars']}", f"- 纠正倾向消息：{metrics['correction_like_messages']}",
        f"- 澄清请求：{metrics['clarification_requests']}", f"- 多代理会话：{metrics['multi_agent_sessions']}",
        f"- 快速检查会话：{metrics['quick_check_sessions']}",
        f"- 首次助手响应中位数：{metrics['median_assistant_latency_seconds']} 秒",
        f"- 同时活跃会话峰值：{metrics['max_concurrent']}", "", "### 会话类型", "",
    ])
    lines.extend(
        f"- {type_labels.get(item['type'], item['type'])}：{item['count']} 个会话"
        for item in report.get("usage_profile", {}).get("session_types", [])
    )
    lines.extend(["", "## 任务族与角色", ""])
    for role in report.get("role_metrics", []):
        lines.append(
            f"- {role['role']}：{role['rollouts']} 个 rollout，{role['task_families']} 个任务族，"
            f"日志 Token 占比 {role['total_token_share']:.1%}"
        )
    lines.extend(["", "## 可验证亮点", ""])
    wins = report.get("narrative", {}).get("wins", [])
    lines.extend(f"- **{win['title']}**：{win['description']}（{win['evidence']}）" for win in wins)
    if not wins:
        lines.append("- 暂无足够证据形成亮点归纳。")
    lines.extend(["", "## 哪里受阻", ""])
    signal_names = {
        "tool_failures": "工具调用失败", "aborted_turns": "中止轮次",
        "repeated_retries_after_failure": "无状态变化的原样重试", "retries_after_state_change": "状态变化后合理重试",
        "polling_retries": "明确轮询/等待", "permission_blocks": "权限阻塞", "failed_patches": "补丁失败",
        "llm_retries": "LLM 请求重试", "denied_approvals": "用户拒绝的权限提升",
    }
    if report["friction_signals"]:
        for signal in report["friction_signals"]:
            lines.append(
                f"- {signal_names.get(signal['signal'], signal['signal'])}：{signal['count']} 次，"
                f"涉及 {signal['affected_sessions']} 个会话"
            )
    else:
        lines.append("- 未检测到受支持的摩擦信号。")
    lines.extend(["", f"## 建议尝试的 {runtime_name} 工作方式", ""])
    if report.get("recommendations"):
        for item in report["recommendations"]:
            lines.extend([
                f"### {item['title']}", "", f"- 对应能力：{item['feature']}", f"- 原因：{item['why']}",
                f"- 证据：{item['evidence']}", f"- 建议：{item['action']}", f"- 可复制提示词：`{item['copy_prompt']}`", "",
            ])
    else:
        lines.append("- 当前范围内没有达到阈值的针对性建议。")
    lines.extend(["", "## 值得推进的新工作流", ""])
    for item in report.get("narrative", {}).get("horizon", []):
        lines.append(f"- **{item['title']}**：{item['possible']} 起步方式：{item['starting_point']}")
    lines.extend(["", "## 代表性工作流", ""])
    if report["workflow_candidates"]:
        for workflow in report["workflow_candidates"]:
            lines.append(
                f"- **{workflow['title']}** — {workflow['project']}（{workflow['date']}）：复杂度 {workflow['complexity_score']}，"
                f"{workflow['turns']} 轮，{workflow['tool_calls']} 次工具调用"
            )
    else:
        lines.append("- 没有符合条件的工作流。")
    if report["excerpts"]:
        evidence_title = "本地内容证据" if report["scope"]["privacy_mode"] == "local_content" else "脱敏证据片段"
        lines.extend(["", f"## {evidence_title}", ""])
        for excerpt in report["excerpts"]:
            kind = {"prompt": "提示词", "follow_up": "后续要求", "correction": "纠正"}.get(excerpt["kind"], excerpt["kind"])
            lines.append(f"- [{kind}] {excerpt['project']} {excerpt['date']}：{excerpt['text']}")
    if report["warnings"]:
        lines.extend(["", "## 注意事项", ""])
        lines.extend(f"- {warning}" for warning in report["warnings"])
    return "\n".join(lines) + "\n"


def render_html(report: dict[str, Any]) -> str:
    template = importlib.resources.files("dsh_session_insights.assets").joinpath("dashboard.html").read_text(encoding="utf-8")
    locale = str(report.get("scope", {}).get("locale", "zh-CN"))
    template = template.replace('<html lang="zh-CN">', f'<html lang="{locale}">')
    safe_json = json.dumps(report, ensure_ascii=False, separators=(",", ":"))
    safe_json = safe_json.replace("&", "\\u0026").replace("<", "\\u003c").replace(">", "\\u003e")
    return template.replace("__DSH_SESSION_INSIGHTS_DATA__", safe_json)


def default_html_output(config: AnalysisConfig) -> Path:
    generated_at = config.generated_at or datetime.now(timezone.utc)
    stamp = generated_at.astimezone(timezone.utc).strftime("%Y%m%d-%H%M%S")
    return session_source_root(config) / "insights" / "reports" / f"dsh-session-insights-{stamp}.html"


def resolve_config(args: argparse.Namespace) -> AnalysisConfig:
    now = parse_datetime(args.now) if args.now else datetime.now(timezone.utc)
    until = parse_datetime(args.until, end_of_day=True) if args.until else now
    if args.since:
        since = parse_datetime(args.since)
    else:
        days = 30 if args.days is None else args.days
        if days <= 0:
            raise ValueError("--days must be positive")
        since = until - timedelta(days=days)
    if since > until:
        raise ValueError("analysis start must not be after the end")
    if args.max_excerpts < 0:
        raise ValueError("--max-excerpts must not be negative")
    dsh_home = args.dsh_home or Path(os.environ.get("DSH_HOME", Path.home() / ".dsh"))
    privacy_mode = "metrics" if args.metrics_only else args.privacy
    analysis_privacy_mode = "metrics" if privacy_mode == "metrics" else (args.analysis_privacy or privacy_mode)
    return AnalysisConfig(
        dsh_home=dsh_home.expanduser(),
        since=since,
        until=until,
        project=args.project,
        privacy_mode=privacy_mode,
        metrics_only=privacy_mode == "metrics",
        max_excerpts=args.max_excerpts,
        generated_at=now,
        analysis_privacy_mode=analysis_privacy_mode,
        analysis_depth=args.analysis_depth,
        deterministic_cache=not args.no_deterministic_cache,
        refresh_deterministic_cache=args.refresh_deterministic_cache,
        locale=args.locale,
    )


def make_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dsh-home", type=Path, help="DSH state root; defaults to DSH_HOME or ~/.dsh")
    window = parser.add_mutually_exclusive_group()
    window.add_argument("--days", type=int, help="rolling window in days; defaults to 30 unless --since is used")
    window.add_argument("--since", help="inclusive ISO date or timestamp")
    parser.add_argument("--until", help="inclusive ISO date or timestamp; defaults to now")
    parser.add_argument("--project", help="include sessions whose cwd is this path or a descendant")
    parser.add_argument(
        "--privacy",
        choices=("local", "redacted", "metrics"),
        default="redacted",
        help="content mode: redacted anonymizes paths and identity; local keeps useful local text while scrubbing credentials; metrics omits excerpts",
    )
    parser.add_argument("--metrics-only", action="store_true", help="deprecated alias for --privacy metrics")
    parser.add_argument(
        "--analysis-privacy",
        choices=("local", "redacted", "metrics"),
        help="semantic input privacy; defaults to --privacy and is forced to metrics when report privacy is metrics",
    )
    parser.add_argument(
        "--analysis-depth", choices=("conversation", "evidence"), default="evidence",
        help="evidence adds bounded sanitized verification/state-change/failure tool facts to conversation text",
    )
    parser.add_argument("--refresh-deterministic-cache", action="store_true", help="reparse every source file and replace deterministic cache entries")
    parser.add_argument("--no-deterministic-cache", action="store_true", help="disable deterministic per-source-file parse cache")
    parser.add_argument("--max-excerpts", type=int, default=80, help="maximum local or redacted excerpts (default: 80)")
    parser.add_argument("--locale", choices=("zh-CN", "en"), default="zh-CN", help="report language")
    parser.add_argument("--format", choices=("json", "markdown", "html"), default="json")
    parser.add_argument("--output", type=Path, help="write output to a file instead of stdout")
    parser.add_argument("--open", action="store_true", help="open an HTML report in the default browser")
    parser.add_argument("--now", help=argparse.SUPPRESS)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = make_parser()
    args = parser.parse_args(argv)
    try:
        config = resolve_config(args)
        report = build_report(config)
    except (OSError, ValueError) as exc:
        parser.error(str(exc))
    if args.open and args.format != "html":
        parser.error("--open requires --format html")
    if args.format == "markdown":
        rendered = render_markdown(report)
    elif args.format == "html":
        rendered = render_html(report)
    else:
        rendered = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    output = args.output.expanduser() if args.output else None
    if args.format == "html" and args.open and output is None:
        output = default_html_output(config)
    if output:
        output = output.resolve()
        sessions_root = (session_source_root(config) / "sessions").expanduser().resolve()
        if output.is_relative_to(sessions_root):
            parser.error("--output 不能写入 DSH 会话源目录")
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(rendered, encoding="utf-8")
        print(output)
        if args.format == "html":
            companion = output.with_suffix(".json")
            if companion == output:
                companion = output.with_name(f"{output.stem}.data.json")
            companion.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            print(companion)
        if args.open and not webbrowser.open_new_tab(output.resolve().as_uri()):
            print(f"warning: browser did not report a successful open; report remains at {output}", file=sys.stderr)
    else:
        sys.stdout.write(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
