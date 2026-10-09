from __future__ import annotations

import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).parents[1]
SPEC = importlib.util.spec_from_file_location("public_tree_audit", ROOT / "scripts" / "audit_public_tree.py")
AUDIT = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(AUDIT)

TINY_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082"
)


class PublicTreeAuditTests(unittest.TestCase):
    def test_current_tree_passes(self):
        result = AUDIT.audit(ROOT)
        self.assertEqual(result["status"], "pass", result["findings"])

    def test_marketplace_disclosure_exemption_is_exact_and_scoped(self):
        path = "marketplace/agensi/SKILL.md"
        disclosure = (
            "Unzipping the skill into Claude, Cursor, Codex or another agent does not "
            "install DSH or make its session services available."
        )
        self.assertEqual(AUDIT.scan_text(path, disclosure), [])
        for candidate_path, content in (
            (path, disclosure + "\nUse Codex session logs."),
            (path, disclosure.replace("does not", "does")),
            ("README.md", disclosure),
        ):
            with self.subTest(path=candidate_path, content=content):
                self.assertIn(
                    {"path": candidate_path, "rule": "legacy-product"},
                    AUDIT.scan_text(candidate_path, content),
                )
        self.assertIn(
            {"path": path, "rule": "private-user-path"},
            AUDIT.scan_text(path, disclosure + "\n/Users/synthetic-user/work"),
        )

    def test_declared_image_assets_pass_while_other_binaries_fail(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "assets").mkdir()
            (root / "assets" / "ok.png").write_bytes(TINY_PNG)
            (root / "assets" / "bad.png").write_bytes(b"\x00\x01\x02\xff\xfe not-utf8")
            (root / "elsewhere.bin").write_bytes(b"\xff\xfe\x00\x01")
            result = AUDIT.audit(root)
            findings = {item["path"]: item["rule"] for item in result["findings"]}
            self.assertNotIn("assets/ok.png", findings)
            self.assertEqual(findings.get("assets/bad.png"), "unexpected-binary")
            self.assertEqual(findings.get("elsewhere.bin"), "unexpected-binary")

    def test_negative_private_path_and_generated_cache(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "leak.txt").write_text("private path: /Users/synthetic-user/work", encoding="utf-8")
            cache = root / "__pycache__"
            cache.mkdir()
            (cache / "module.pyc").write_bytes(b"binary")
            result = AUDIT.audit(root)
            rules = {item["rule"] for item in result["findings"]}
            self.assertIn("private-user-path", rules)
            self.assertIn("generated-name", rules)

    def test_private_paths_across_platforms_and_anonymous_placeholders(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            examples = {
                "mac.txt": "/Users/synthetic-user/work",
                "linux.txt": "/home/synthetic-user/work",
                "windows.txt": r"C:\Users\synthetic-user\work",
                "windows-slashes.txt": "D:/Users/synthetic-user/work",
                "anonymous.txt": "<repository-root> <dsh-home> <acceptance-root>",
            }
            for name, value in examples.items():
                (root / name).write_text(value, encoding="utf-8")
            findings = AUDIT.audit(root)["findings"]
            leaked = {item["path"] for item in findings if item["rule"] == "private-user-path"}
            self.assertEqual(leaked, set(examples) - {"anonymous.txt"})

    def test_gitignored_generated_files_are_outside_public_tree(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            subprocess.run(["git", "init", "--quiet"], cwd=root, check=True)
            (root / ".gitignore").write_text(
                ".DS_Store\n__pycache__/\n*.py[cod]\n*.egg-info/\nbuild/\ndist/\n",
                encoding="utf-8",
            )
            (root / "safe.txt").write_text("synthetic public content", encoding="utf-8")
            for generated in (
                root / "__pycache__" / "module.pyc",
                root / "src" / "demo.egg-info" / "PKG-INFO",
                root / "build" / "artifact.txt",
            ):
                generated.parent.mkdir(parents=True, exist_ok=True)
                generated.write_bytes(b"ignored")
            (root / ".DS_Store").write_bytes(b"ignored")

            result = AUDIT.audit(root)

            self.assertEqual(result["status"], "pass", result["findings"])
            self.assertEqual(result["files_scanned"], 2)


if __name__ == "__main__":
    unittest.main()
