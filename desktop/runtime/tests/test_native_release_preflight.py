import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CHECK = ROOT / 'scripts' / 'verify-native-release.py'

class NativeReleasePreflightTests(unittest.TestCase):
    def test_missing_resource_fails_with_acquisition_instructions(self):
        with tempfile.TemporaryDirectory() as d:
            p = subprocess.run([sys.executable, str(CHECK), '--resource-root', d], text=True, capture_output=True)
        self.assertEqual(p.returncode, 2)
        self.assertIn('Acquire a verified relocatable CPython 3.11.x', p.stderr)

    def test_development_manifest_is_never_release_ready(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / 'native-manifest.json').write_text(json.dumps({'manifest_version':'1.0', 'portable': False, 'mode': 'development-external-python'}))
            p = subprocess.run([sys.executable, str(CHECK), '--resource-root', d], text=True, capture_output=True)
        self.assertEqual(p.returncode, 2)
        self.assertIn('not portable standalone', p.stderr)

if __name__ == '__main__':
    unittest.main()
