from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).parents[1]
SPEC = importlib.util.spec_from_file_location("public_tree_audit", ROOT / "scripts" / "audit_public_tree.py")
AUDIT = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(AUDIT)


class PublicTreeAuditTests(unittest.TestCase):
    def test_current_tree_passes(self):
        result = AUDIT.audit(ROOT)
        self.assertEqual(result["status"], "pass", result["findings"])

    def test_negative_private_path_and_generated_cache(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "leak.txt").write_text("private path: /Users/lgr59/work")
            cache = root / "__pycache__"
            cache.mkdir()
            (cache / "module.pyc").write_bytes(b"binary")
            result = AUDIT.audit(root)
            rules = {item["rule"] for item in result["findings"]}
            self.assertIn("private-user-path", rules)
            self.assertIn("generated-name", rules)


if __name__ == "__main__":
    unittest.main()
