"""Offline regressions for real service timing conversion and audio decoding."""
import importlib.util
import copy
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("generate_audio", ROOT / "scripts/generate-audio.py")
audio = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audio)


class AlignmentTests(unittest.TestCase):
    def sample_raw_alignment(self):
        return {"schema_version": 1, "tool": "edge-tts", "version": "7.3.1", "recording_id": "R001",
                "boundary": "SentenceBoundary", "time_unit": "100ns",
                "events": [{"type": "SentenceBoundary", "offset": 1000000, "duration": 5000000, "text": "测试。"}]}

    def test_cached_raw_alignment_rejects_wrong_provenance_fields(self):
        self.assertTrue(hasattr(audio, "validate_raw_alignment"), "Cached raw alignment needs provenance validation")
        mutations = {"schema_version": [2, True], "tool": ["other-tool"], "version": ["0.0.0"],
                     "recording_id": ["R008"], "boundary": ["WordBoundary"], "time_unit": ["ms"]}
        for key, values in mutations.items():
            for value in values:
                with self.subTest(field=key, value=value):
                    raw = self.sample_raw_alignment()
                    raw[key] = value
                    with self.assertRaises(ValueError):
                        audio.validate_raw_alignment(raw, "R001", "7.3.1")
        raw = self.sample_raw_alignment()
        self.assertEqual(audio.validate_raw_alignment(raw, "R001", "7.3.1"), raw["events"])

    def test_cached_raw_alignment_rejects_wrong_event_types(self):
        self.assertTrue(hasattr(audio, "validate_raw_alignment"), "Cached raw events need type validation")
        for value in ("WordBoundary", "audio", None):
            with self.subTest(event_type=value):
                raw = self.sample_raw_alignment()
                raw["events"][0]["type"] = value
                with self.assertRaises(ValueError):
                    audio.validate_raw_alignment(raw, "R001", "7.3.1")

    def test_cached_raw_alignment_rejects_missing_or_malformed_fields(self):
        self.assertTrue(hasattr(audio, "validate_raw_alignment"), "Raw cache needs schema validation")
        for key in self.sample_raw_alignment():
            with self.subTest(missing=key):
                raw = self.sample_raw_alignment()
                del raw[key]
                with self.assertRaises(ValueError):
                    audio.validate_raw_alignment(raw, "R001", "7.3.1")
        for events in ([], {}, [None], [{"type": "SentenceBoundary"}]):
            with self.subTest(events=events):
                raw = self.sample_raw_alignment()
                raw["events"] = events
                with self.assertRaises(ValueError):
                    audio.validate_raw_alignment(raw, "R001", "7.3.1")

    def test_invalid_cached_provenance_reaches_rebuild_path_without_network(self):
        original_read_text = Path.read_text
        invalid_path = ROOT / "audio/R001.boundaries.json"

        def tampered_read_text(path, *args, **kwargs):
            contents = original_read_text(path, *args, **kwargs)
            if path == invalid_path:
                raw = json.loads(contents)
                raw["tool"] = "tampered-tool"
                return json.dumps(raw)
            return contents

        # The sentinel raises while evaluating synthesize(), before an async
        # coroutine or event loop can be created. No actual sidecar is changed.
        with patch.object(Path, "read_text", tampered_read_text), \
                patch.object(audio, "synthesize", new=Mock(side_effect=ValueError("cache rejected before network"))) as synthesis, \
                patch.object(audio.asyncio, "run", side_effect=AssertionError("No network or event loop in this test")):
            with self.assertRaisesRegex(ValueError, "cache rejected before network"):
                audio.generate(ROOT / "data/tts-manifest.json", False)
            synthesis.assert_called_once()

    def test_manifest_rejects_wrong_hotel_and_timezone_before_publication(self):
        manifest = json.loads((ROOT / "data/tts-manifest.json").read_text(encoding="utf-8"))
        for key, value in (("hotel", "Other Hotel"), ("time_zone", "UTC"),
                           ("voice", ""), ("rate", "fast"), ("schema_version", True)):
            with self.subTest(field=key):
                changed = copy.deepcopy(manifest)
                changed[key] = value
                with self.assertRaises(ValueError):
                    audio.validate_manifest(changed)

    def test_publication_restores_prior_bytes_after_later_replace_failure(self):
        self.assertTrue(hasattr(audio, "publish_files"), "Publication needs rollback on ordinary failures")
        cache = ROOT / ".cache/audio-tests"
        cache.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=cache) as folder:
            root = Path(folder)
            stage, output = root / "stage", root / "output"
            stage.mkdir()
            output.mkdir()
            sources = [stage / f"{name}.txt" for name in ("changed", "created", "failed")]
            destinations = [output / source.name for source in sources]
            for source in sources:
                source.write_bytes(b"new " + source.name.encode())
            destinations[0].write_bytes(b"old first file")
            destinations[2].write_bytes(b"old last file")
            unrelated = output / "unrelated.txt"
            unrelated.write_bytes(b"do not touch")
            original_replace = Path.replace

            def fail_later(source, destination):
                if source == sources[2]:
                    raise OSError("injected later replacement failure")
                return original_replace(source, destination)

            with patch.object(Path, "replace", fail_later):
                with self.assertRaisesRegex(OSError, "injected"):
                    audio.publish_files(list(zip(sources, destinations)), stage / "backups")
            self.assertEqual(destinations[0].read_bytes(), b"old first file")
            self.assertFalse(destinations[1].exists())
            self.assertEqual(destinations[2].read_bytes(), b"old last file")
            self.assertEqual(unrelated.read_bytes(), b"do not touch")

    def test_publication_preflights_all_sources_before_replacing_any_file(self):
        self.assertTrue(hasattr(audio, "publish_files"), "Publication needs preflight")
        cache = ROOT / ".cache/audio-tests"
        cache.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=cache) as folder:
            root = Path(folder)
            source, destination = root / "source", root / "destination"
            source.write_bytes(b"new")
            destination.write_bytes(b"old")
            with self.assertRaises(OSError):
                audio.publish_files([(source, destination), (root / "missing", root / "second")], root / "backups")
            self.assertEqual(source.read_bytes(), b"new")
            self.assertEqual(destination.read_bytes(), b"old")

    def test_fully_cached_generation_does_not_create_event_loop(self):
        manifest_path = ROOT / "data/tts-manifest.json"
        if not manifest_path.exists() or not (ROOT / "data/audio-metadata.json").exists():
            self.skipTest("Requires generated demo fixture files")
        with patch.object(audio.asyncio, "run", side_effect=AssertionError("Cached generation must be offline")):
            result = audio.generate(manifest_path, False)
            self.assertEqual(result["cached_count"], 8)
            self.assertEqual(result["generated_count"], 0)

    def test_rounds_service_ticks_outward_and_restores_punctuation(self):
        text = "您好，欢迎。请出示证件！"
        events = [
            {"type": "SentenceBoundary", "offset": 125001, "duration": 12500000, "text": "您好欢迎"},
            {"type": "SentenceBoundary", "offset": 15000000, "duration": 20000001, "text": "请出示证件"},
        ]
        self.assertEqual(audio.boundary_segments(text, events, 4000), [
            {"start_ms": 12, "end_ms": 1263, "text": "您好，欢迎。"},
            {"start_ms": 1500, "end_ms": 3501, "text": "请出示证件！"},
        ])

    def test_refuses_unmatched_service_text(self):
        with self.assertRaisesRegex(ValueError, "text"):
            audio.boundary_segments("真实台词。", [{"type": "SentenceBoundary", "offset": 0, "duration": 1, "text": "别的台词"}], 1000)

    def test_refuses_missing_boundary_instead_of_inventing_offsets(self):
        with self.assertRaisesRegex(ValueError, "text"):
            audio.boundary_segments("真实台词。", [], 1000)

    def test_refuses_boundary_outside_real_audio(self):
        with self.assertRaisesRegex(ValueError, "duration"):
            audio.boundary_segments("测试", [{"type": "SentenceBoundary", "offset": 0, "duration": 11000000, "text": "测试"}], 1000)

    def test_refuses_fake_or_overlapping_offsets(self):
        for segments in ([{"start_ms": 1.5, "end_ms": 5, "text": "测试"}],
                         [{"start_ms": 0, "end_ms": 501, "text": "测"}, {"start_ms": 500, "end_ms": 900, "text": "试"}]):
            with self.assertRaises(ValueError):
                audio.check_segments("测试", segments, 1000)

    def test_rejects_silent_mp3_after_real_decode(self):
        import imageio_ffmpeg

        cache = ROOT / ".cache/audio-tests"
        cache.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=cache) as folder:
            silent = Path(folder) / "silent.mp3"
            subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-v", "error", "-f", "lavfi", "-i",
                            "anullsrc=r=24000:cl=mono", "-t", "1", str(silent)],
                           check=True, capture_output=True, timeout=10)
            with self.assertRaisesRegex(ValueError, "silent"):
                audio.inspect_audio(silent)


if __name__ == "__main__":
    unittest.main()
