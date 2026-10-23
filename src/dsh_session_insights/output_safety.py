"""Safe derived-output writing for the CLI and bridge paths.

Every report artifact — main output, companion JSON, and the temporary files
used for atomic replacement — is boundary-checked before the first byte is
written. Derived outputs must never overwrite source session logs, follow
pre-existing links, or leave a half-written file that looks like a complete
result. A normally configured DSH_HOME alias (the home itself reachable through
a symlink) stays allowed; only targets that land inside the resolved sessions
tree, or that reuse a linked inode, are refused.
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path


class UnsafeOutputError(ValueError):
    """A derived-output target is outside the writable boundary."""


def resolve_sessions_root(sessions_root: Path) -> Path:
    return sessions_root.expanduser().resolve()


def _reject_windows_ads(path: Path) -> None:
    # An NTFS alternate data stream smuggles a second payload through one name;
    # a colon in the final component is the on-disk syntax for it.
    if os.name == "nt" and ":" in path.name:
        raise UnsafeOutputError(f"输出文件名包含冒号（可能是 NTFS 备用数据流）：{path.name}")


def check_output_target(path: Path, sessions_root: Path) -> Path:
    """Validate one derived-output target and return its absolute path.

    Refuses targets whose resolved location is inside the sessions source
    tree, targets that already exist as a symlink or other non-regular file,
    and hard-linked files. A missing target passes; its parent chain is
    validated at write time after creation.
    """
    _reject_windows_ads(path)
    absolute = path if path.is_absolute() else Path.cwd() / path
    resolved = absolute.resolve()
    if resolved == sessions_root or resolved.is_relative_to(sessions_root):
        raise UnsafeOutputError(
            f"输出目标位于 DSH 会话源目录内，已拒绝：{absolute}"
        )
    if absolute.exists() or absolute.is_symlink():
        metadata = absolute.lstat()
        import stat as stat_module

        if stat_module.S_ISLNK(metadata.st_mode):
            raise UnsafeOutputError(f"输出目标已是符号链接，拒绝跟随：{absolute}")
        if not stat_module.S_ISREG(metadata.st_mode):
            raise UnsafeOutputError(f"输出目标不是普通文件：{absolute}")
        if metadata.st_nlink != 1:
            raise UnsafeOutputError(f"输出目标存在硬链接（nlink={metadata.st_nlink}），拒绝改写：{absolute}")
    return absolute


def _check_directory(directory: Path) -> None:
    import stat as stat_module

    metadata = directory.lstat()
    if not stat_module.S_ISDIR(metadata.st_mode):
        raise UnsafeOutputError(f"输出父路径不是目录：{directory}")


def prepare_output_targets(targets: list[Path], sessions_root: Path) -> list[Path]:
    """Validate every target (main and companions) before any write happens."""
    root = resolve_sessions_root(sessions_root)
    checked = []
    seen: dict[Path, str] = {}
    for index, target in enumerate(targets):
        absolute = check_output_target(target, root)
        if absolute in seen:
            raise UnsafeOutputError(
                f"主输出与伴随文件解析到同一路径，已拒绝：{absolute}"
            )
        seen[absolute] = str(index)
        checked.append(absolute)
    return checked


def atomic_write_text(path: Path, data: str, *, mode: int = 0o600) -> None:
    """Write one artifact through an unpredictable, exclusively created temp file.

    The temp file lives in the target directory, is created with O_EXCL and
    restrictive permissions independent of umask, and replaces the target only
    after a successful flush. Any failure removes the temp file and leaves the
    previous bytes untouched.
    """
    path = path if path.is_absolute() else Path.cwd() / path
    directory = path.parent
    directory.mkdir(parents=True, exist_ok=True)
    _check_directory(directory)
    for ancestor in [directory, *directory.parents]:
        # The resolved sessions-root containment test ran on the final target;
        # a symlinked ancestor created between validation and write must not
        # redirect the artifact. Only existing components are checked here.
        try:
            resolved_ancestor = ancestor.resolve()
        except OSError:
            break
        if ancestor.exists() and not resolved_ancestor.exists():
            raise UnsafeOutputError(f"输出父路径解析失败：{ancestor}")
    temporary = directory / f".{path.name}.{uuid.uuid4().hex}.tmp"
    descriptor = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
        mode,
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        try:
            temporary.unlink()
        except OSError:
            pass
        raise


def html_companion_path(output: Path) -> Path:
    """Companion JSON path that can never equal the HTML main output."""
    companion = output.with_suffix(".json")
    if companion == output:
        companion = output.with_name(f"{output.stem}.data.json")
    return companion
