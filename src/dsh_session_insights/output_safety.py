"""Safe derived-output writing for the CLI, semantic renderer, and bridge.

Every report artifact — main output, companion JSON, and the temporary files
used for atomic replacement — is boundary-checked before the first byte is
written, on the *undereferenced* path so link evidence cannot be lost to an
early resolve(). Derived outputs must never overwrite source session logs,
follow pre-existing links (in the target or any ancestor component), or leave
a half-written file that looks like a complete result. A normally configured
DSH_HOME alias (the home itself reachable through a symlink) stays allowed;
targets inside the resolved sessions tree, or that reuse a linked inode, are
refused.
"""

from __future__ import annotations

import os
import io
import sys
import uuid
from pathlib import Path


def configure_cli_text_streams() -> None:
    """Give CLI pipes the same UTF-8 contract as report files.

    Windows consoles already support Unicode, but redirected streams may use
    a legacy code page. Call only at CLI entry, never at library import time.
    Keep invalid output strict; error diagnostics can escape a bad surrogate.
    Embedded callers may provide StringIO or another non-reconfigurable stream.
    """
    for stream, errors in ((sys.stdout, "strict"), (sys.stderr, "backslashreplace")):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            try:
                reconfigure(encoding="utf-8", errors=errors)
            except (io.UnsupportedOperation, NotImplementedError):
                pass


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

    Checks run on the undereferenced path: an existing final symlink is
    rejected even though a later resolve() would hide it. Ancestors are
    validated separately (validate_output_ancestors) because the file may not
    exist yet.
    """
    _reject_windows_ads(path)
    absolute = path if path.is_absolute() else Path.cwd() / path
    resolved = absolute.resolve()
    if resolved == sessions_root or resolved.is_relative_to(sessions_root):
        raise UnsafeOutputError(
            f"输出目标位于 DSH 会话源目录内，已拒绝：{absolute}"
        )
    # Undereferenced final-component check: lstat, never stat through the link.
    if absolute.is_symlink():
        raise UnsafeOutputError(f"输出目标已是符号链接，拒绝跟随：{absolute}")
    if absolute.exists():
        import stat as stat_module

        metadata = absolute.lstat()
        if not stat_module.S_ISREG(metadata.st_mode):
            raise UnsafeOutputError(f"输出目标不是普通文件：{absolute}")
        if metadata.st_nlink != 1:
            raise UnsafeOutputError(f"输出目标存在硬链接（nlink={metadata.st_nlink}），拒绝改写：{absolute}")
    return absolute


def _is_os_managed(link_path: Path, metadata: object) -> bool:
    """Whether a symlink ancestor is an OS-managed prefix alias (e.g. /var).

    macOS and some Linux layouts alias system prefixes through root-owned
    symlinks. Those are allowed because they are not user-writable redirects;
    anything owned by the current user (or group-writable) is treated as a
    redirect and refused.
    """
    import stat as stat_module

    try:
        owner = metadata.st_uid
    except AttributeError:
        return False
    if owner == 0:
        return True
    # Group-writable with the wheel/admin group is the macOS admin layout.
    if metadata.st_mode & stat_module.S_IWGRP and metadata.st_gid == 0:
        return True
    return False


def validate_output_ancestors(path: Path) -> None:
    """Reject user-reachable redirect links in any ancestor component.

    A symlink ancestor that is owned by the current user could redirect the
    write to a location the caller did not name; it is refused. OS-managed
    prefix aliases (root-owned, e.g. macOS ``/var -> /private/var``) are
    allowed — they are not user-writable, and every containment check binds
    to the fully resolved location regardless. All resolved (real) ancestors
    must be real directories without links or special files. The final
    component keeps its undereferenced check in check_output_target and
    atomic_write_text.
    """
    absolute = path if path.is_absolute() else Path.cwd() / path
    resolved = absolute.resolve()
    import stat as stat_module

    for ancestor in [absolute, *absolute.parents]:
        if not ancestor.exists() and not ancestor.is_symlink():
            continue  # created later by the writer
        try:
            metadata = ancestor.lstat()
        except OSError as exc:
            raise UnsafeOutputError(f"输出路径组件不可检查：{ancestor}") from exc
        if stat_module.S_ISLNK(metadata.st_mode):
            if not _is_os_managed(ancestor, metadata):
                raise UnsafeOutputError(f"输出路径包含符号链接组件，拒绝跟随：{ancestor}")
            continue
        if ancestor != absolute and not stat_module.S_ISDIR(metadata.st_mode):
            raise UnsafeOutputError(f"输出路径的父组件不是目录：{ancestor}")
    # The real (resolved) chain must also be link-free up to the root: a link
    # planted at the resolved location is a redirect regardless of aliases.
    for ancestor in [resolved, *resolved.parents]:
        if not ancestor.exists():
            continue
        try:
            metadata = ancestor.lstat()
        except OSError:
            continue
        if stat_module.S_ISLNK(metadata.st_mode) and not _is_os_managed(ancestor, metadata):
            raise UnsafeOutputError(f"输出路径包含符号链接组件，拒绝跟随：{ancestor}")
        if ancestor != resolved and not stat_module.S_ISDIR(metadata.st_mode):
            raise UnsafeOutputError(f"输出路径的父组件不是目录：{ancestor}")


def prepare_output_targets(targets: list[Path], sessions_root: Path) -> list[Path]:
    """Validate every target (main and companions) before any write happens."""
    root = resolve_sessions_root(sessions_root)
    checked = []
    seen: dict[Path, str] = {}
    for index, target in enumerate(targets):
        absolute = check_output_target(target, root)
        validate_output_ancestors(absolute)
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
    after a successful flush. Ancestors are re-validated at write time, so a
    link created between validation and write is still refused. Any failure
    removes the temp file and leaves the previous bytes untouched.
    """
    path = path if path.is_absolute() else Path.cwd() / path
    validate_output_ancestors(path)
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise UnsafeOutputError(f"写入目标已存在且不是可安全替换的普通文件：{path}")
    directory = path.parent
    directory.mkdir(parents=True, exist_ok=True)
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
        # The rename re-checks the undereferenced target: a link placed after
        # validation must not be replaced-through; refuse instead.
        if path.is_symlink():
            raise UnsafeOutputError(f"写入目标在校验后变为符号链接，拒绝替换：{path}")
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
