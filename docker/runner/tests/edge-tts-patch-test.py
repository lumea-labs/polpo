"""Offline guards for the temporary, pinned Edge TTS compatibility patch."""
import importlib.util
import pathlib
import tempfile
import unittest
import edge_tts.constants

spec = importlib.util.spec_from_file_location(
    "edge_patch", pathlib.Path(__file__).parent.parent / "patches" / "edge-tts-endpoint.py"
)
patch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patch)


class EndpointPatchTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = pathlib.Path(self.directory.name) / "constants.py"
        installed = pathlib.Path(edge_tts.constants.__file__).read_bytes()
        # Works before and after the image has applied the patch.
        self.original = installed.replace(patch.REPLACEMENT, patch.ORIGINAL)
        self.path.write_bytes(self.original)

    def test_moves_only_synthesis_preserving_voice_list_token_and_defaults(self):
        patch.apply("7.2.8", self.path)
        before, after = {}, {}
        exec(self.original, before)
        exec(self.path.read_bytes(), after)
        self.assertEqual(after["WSS_URL"], "wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1?Ocp-Apim-Subscription-Key=" + before["TRUSTED_CLIENT_TOKEN"])
        for key, value in before.items():
            if key not in ("WSS_URL", "__builtins__"):
                self.assertEqual(after[key], value, key)

    def test_reapplication_is_idempotent(self):
        patch.apply("7.2.8", self.path)
        first = self.path.read_bytes()
        patch.apply("7.2.8", self.path)
        self.assertEqual(self.path.read_bytes(), first)

    def test_rejects_different_package_version_without_writing(self):
        with self.assertRaisesRegex(RuntimeError, "version"):
            patch.apply("7.2.9", self.path)
        self.assertEqual(self.path.read_bytes(), self.original)

    def test_rejects_source_drift_without_writing(self):
        drift = self.original + b"\n# unexpected source change\n"
        self.path.write_bytes(drift)
        with self.assertRaisesRegex(RuntimeError, "source"):
            patch.apply("7.2.8", self.path)
        self.assertEqual(self.path.read_bytes(), drift)


if __name__ == "__main__":
    unittest.main()
