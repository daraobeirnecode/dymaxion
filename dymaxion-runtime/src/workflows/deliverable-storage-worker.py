#!/usr/bin/env python3
"""Internal dirfd-anchored sidecar publisher. No paths or secrets are emitted."""

from __future__ import annotations

import base64
import binascii
import errno
import hashlib
import json
import os
import secrets
import signal
import stat
import sys
from typing import Any

MAX_BYTES = 5 * 1024 * 1024
MAX_REQUEST_LINE = 8 * 1024 * 1024
UUID_RE = __import__("re").compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
SHA256_RE = __import__("re").compile(r"^[a-f0-9]{64}$")
COMPONENT_RE = __import__("re").compile(r"^[a-z0-9-]{1,80}$")
NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
DIRECTORY = getattr(os, "O_DIRECTORY", 0)
CLOEXEC = getattr(os, "O_CLOEXEC", 0)


class StorageRejected(RuntimeError):
    pass


def reject() -> None:
    raise StorageRejected("secure deliverable storage worker rejected the operation")


def send(message: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def read_message(limit: int) -> Any:
    line = sys.stdin.buffer.readline(limit + 1)
    if not line or len(line) > limit or not line.endswith(b"\n"):
        reject()
    try:
        return json.loads(line)
    except (UnicodeDecodeError, json.JSONDecodeError):
        reject()


def authorize(stage: str) -> None:
    send({"type": "authorize", "stage": stage})
    response = read_message(4096)
    if (
        not isinstance(response, dict)
        or response.get("type") != "authorization"
        or response.get("stage") != stage
        or response.get("allowed") is not True
        or set(response) != {"type", "stage", "allowed"}
    ):
        reject()


def same_identity(left: os.stat_result, right: os.stat_result) -> bool:
    return left.st_dev == right.st_dev and left.st_ino == right.st_ino


def validate_request(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {
        "type",
        "expectedRoot",
        "rootComponents",
        "components",
        "entry",
        "contentBase64",
        "expectedSha256",
        "expectedBytes",
    }:
        reject()
    root = value.get("expectedRoot")
    root_components = value.get("rootComponents")
    components = value.get("components")
    expected_bytes = value.get("expectedBytes")
    if (
        value.get("type") != "store"
        or not isinstance(root, dict)
        or set(root) != {"dev", "ino"}
        or not all(isinstance(root.get(key), str) and root[key].isdigit() for key in ("dev", "ino"))
        or not isinstance(root_components, list)
        or len(root_components) > 64
        or not all(valid_root_component(component) for component in root_components)
        or not isinstance(components, list)
        or len(components) != 4
        or components[0] != "projects"
        or not isinstance(components[1], str)
        or not UUID_RE.fullmatch(components[1])
        or components[2] != "deliverables"
        or not isinstance(components[3], str)
        or not SHA256_RE.fullmatch(components[3])
        or value.get("entry") not in {"change-ticket.md", "dependency-map.svg"}
        or not isinstance(value.get("expectedSha256"), str)
        or not SHA256_RE.fullmatch(value["expectedSha256"])
        or not isinstance(expected_bytes, int)
        or isinstance(expected_bytes, bool)
        or expected_bytes <= 0
        or expected_bytes > MAX_BYTES
        or not isinstance(value.get("contentBase64"), str)
        or len(value["contentBase64"]) > ((MAX_BYTES + 2) // 3) * 4
    ):
        reject()
    return value


def valid_root_component(value: Any) -> bool:
    if not isinstance(value, str) or value in {"", ".", ".."} or "/" in value or "\x00" in value:
        return False
    try:
        return len(value.encode("utf-8")) <= 255
    except UnicodeEncodeError:
        return False


def verify_root_attachment(
    retained_root_fd: int,
    root_components: list[str],
    expected_root: dict[str, str],
) -> None:
    current_fd = os.open("/", os.O_RDONLY | DIRECTORY | NOFOLLOW | CLOEXEC)
    try:
        for component in root_components:
            path_stat = os.stat(component, dir_fd=current_fd, follow_symlinks=False)
            if not stat.S_ISDIR(path_stat.st_mode):
                reject()
            child_fd = os.open(component, os.O_RDONLY | DIRECTORY | NOFOLLOW | CLOEXEC, dir_fd=current_fd)
            descriptor_stat = os.fstat(child_fd)
            post_open_stat = os.stat(component, dir_fd=current_fd, follow_symlinks=False)
            if (
                not stat.S_ISDIR(descriptor_stat.st_mode)
                or not same_identity(path_stat, descriptor_stat)
                or not same_identity(post_open_stat, descriptor_stat)
            ):
                os.close(child_fd)
                reject()
            os.close(current_fd)
            current_fd = child_fd

        namespace_root_stat = os.fstat(current_fd)
        retained_root_stat = os.fstat(retained_root_fd)
        if (
            not stat.S_ISDIR(namespace_root_stat.st_mode)
            or not same_identity(namespace_root_stat, retained_root_stat)
            or str(retained_root_stat.st_dev) != expected_root["dev"]
            or str(retained_root_stat.st_ino) != expected_root["ino"]
        ):
            reject()
    finally:
        os.close(current_fd)


def verify_chain(
    directory_fds: list[int],
    names: list[str],
    expected_root: dict[str, str],
    root_components: list[str],
) -> None:
    verify_root_attachment(directory_fds[0], root_components, expected_root)
    root_stat = os.fstat(directory_fds[0])
    if (
        not stat.S_ISDIR(root_stat.st_mode)
        or str(root_stat.st_dev) != expected_root["dev"]
        or str(root_stat.st_ino) != expected_root["ino"]
    ):
        reject()
    for index, name in enumerate(names):
        parent_fd = directory_fds[index]
        child_fd = directory_fds[index + 1]
        path_stat = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        descriptor_stat = os.fstat(child_fd)
        if not stat.S_ISDIR(path_stat.st_mode) or not same_identity(path_stat, descriptor_stat):
            reject()


def read_verified(directory_fd: int, name: str, expected_sha256: str, expected_bytes: int) -> bytes | None:
    try:
        path_stat = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(path_stat.st_mode) or path_stat.st_size != expected_bytes:
        reject()
    file_fd = os.open(name, os.O_RDONLY | NOFOLLOW | CLOEXEC, dir_fd=directory_fd)
    try:
        descriptor_stat = os.fstat(file_fd)
        post_open_stat = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if (
            not stat.S_ISREG(descriptor_stat.st_mode)
            or descriptor_stat.st_size != expected_bytes
            or not same_identity(path_stat, descriptor_stat)
            or not same_identity(post_open_stat, descriptor_stat)
        ):
            reject()
        chunks: list[bytes] = []
        remaining = expected_bytes + 1
        while remaining > 0:
            chunk = os.read(file_fd, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        content = b"".join(chunks)
        if len(content) != expected_bytes or hashlib.sha256(content).hexdigest() != expected_sha256:
            reject()
        return content
    finally:
        os.close(file_fd)


def enter_directory(
    directory_fds: list[int],
    names: list[str],
    component: str,
    expected_root: dict[str, str],
    root_components: list[str],
) -> None:
    if not COMPONENT_RE.fullmatch(component):
        reject()
    parent_fd = directory_fds[-1]
    try:
        path_stat = os.stat(component, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        authorize("mkdir")
        verify_chain(directory_fds, names, expected_root, root_components)
        try:
            os.mkdir(component, mode=0o700, dir_fd=parent_fd)
        except FileExistsError:
            pass
        path_stat = os.stat(component, dir_fd=parent_fd, follow_symlinks=False)
    if not stat.S_ISDIR(path_stat.st_mode):
        reject()
    child_fd = os.open(component, os.O_RDONLY | DIRECTORY | NOFOLLOW | CLOEXEC, dir_fd=parent_fd)
    descriptor_stat = os.fstat(child_fd)
    post_open_stat = os.stat(component, dir_fd=parent_fd, follow_symlinks=False)
    if (
        not stat.S_ISDIR(descriptor_stat.st_mode)
        or not same_identity(path_stat, descriptor_stat)
        or not same_identity(post_open_stat, descriptor_stat)
    ):
        os.close(child_fd)
        reject()
    directory_fds.append(child_fd)
    names.append(component)


def write_all(file_fd: int, content: bytes) -> None:
    offset = 0
    while offset < len(content):
        written = os.write(file_fd, content[offset:])
        if written <= 0:
            reject()
        offset += written


def store(request_value: Any) -> bool:
    request = validate_request(request_value)
    try:
        content = base64.b64decode(request["contentBase64"], validate=True)
    except (ValueError, binascii.Error):
        reject()
    if (
        len(content) != request["expectedBytes"]
        or hashlib.sha256(content).hexdigest() != request["expectedSha256"]
    ):
        reject()

    directory_fds: list[int] = []
    names: list[str] = []
    temp_name: str | None = None
    temp_fd: int | None = None
    target_created = False
    try:
        root_fd = os.open(".", os.O_RDONLY | DIRECTORY | NOFOLLOW | CLOEXEC)
        directory_fds.append(root_fd)
        verify_chain(directory_fds, names, request["expectedRoot"], request["rootComponents"])
        for component in request["components"]:
            enter_directory(
                directory_fds,
                names,
                component,
                request["expectedRoot"],
                request["rootComponents"],
            )

        target_fd = directory_fds[-1]
        existing = read_verified(target_fd, request["entry"], request["expectedSha256"], request["expectedBytes"])
        if existing is not None:
            return False

        authorize("temp-create")
        verify_chain(directory_fds, names, request["expectedRoot"], request["rootComponents"])
        temp_name = f".tmp-{os.getpid()}-{secrets.token_hex(16)}"
        temp_fd = os.open(
            temp_name,
            os.O_CREAT | os.O_EXCL | os.O_WRONLY | NOFOLLOW | CLOEXEC,
            0o600,
            dir_fd=target_fd,
        )
        write_all(temp_fd, content)
        os.fsync(temp_fd)
        approved_stat = os.fstat(temp_fd)
        if not stat.S_ISREG(approved_stat.st_mode) or approved_stat.st_size != request["expectedBytes"]:
            reject()

        authorize("hard-link")
        verify_chain(directory_fds, names, request["expectedRoot"], request["rootComponents"])
        temp_path_stat = os.stat(temp_name, dir_fd=target_fd, follow_symlinks=False)
        if not same_identity(temp_path_stat, approved_stat):
            reject()
        try:
            os.link(
                temp_name,
                request["entry"],
                src_dir_fd=target_fd,
                dst_dir_fd=target_fd,
                follow_symlinks=False,
            )
            target_created = True
        except FileExistsError:
            raced = read_verified(target_fd, request["entry"], request["expectedSha256"], request["expectedBytes"])
            if raced is None:
                reject()
            return False

        target_stat = os.stat(request["entry"], dir_fd=target_fd, follow_symlinks=False)
        if not same_identity(target_stat, approved_stat):
            reject()
        published = read_verified(target_fd, request["entry"], request["expectedSha256"], request["expectedBytes"])
        if published is None:
            reject()
        return True
    except BaseException:
        if target_created and directory_fds:
            try:
                os.unlink(request["entry"], dir_fd=directory_fds[-1])
            except OSError:
                pass
        raise
    finally:
        if temp_fd is not None:
            try:
                os.close(temp_fd)
            except OSError:
                pass
        if temp_name is not None and directory_fds:
            try:
                os.unlink(temp_name, dir_fd=directory_fds[-1])
            except OSError:
                pass
        for directory_fd in reversed(directory_fds):
            try:
                os.close(directory_fd)
            except OSError:
                pass


def terminate(_signum: int, _frame: Any) -> None:
    raise StorageRejected("worker terminated")


def main() -> int:
    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    try:
        request = read_message(MAX_REQUEST_LINE)
        created = store(request)
        send({"type": "result", "created": created})
        return 0
    except BaseException:
        try:
            send({"type": "error"})
        except BaseException:
            pass
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
