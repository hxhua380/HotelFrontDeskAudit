"""Reproducible real speech and service timing; --inspect never uses the network."""
from __future__ import annotations

import argparse
import array
import asyncio
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import math
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
import unittest

ROOT = Path(__file__).resolve().parents[1]
PIPELINE_VERSION = 1
NORMALIZATION = "Match source and service after removing Unicode punctuation/whitespace; restore original punctuation in segments without changing source text."


def normalized(text):
    return "".join(c for c in text if not c.isspace() and not unicodedata.category(c).startswith("P"))


def boundary_segments(text, boundaries, duration_ms):
    """Use service offsets only, preserving exact source text including punctuation."""
    positions = [i for i, c in enumerate(text) if normalized(c)]
    source = normalized(text)
    consumed = 0
    starts = []
    for event in boundaries:
        token = normalized(event["text"])
        if not token or not source.startswith(token, consumed):
            raise ValueError("Service boundary text does not match input text")
        starts.append(0 if not starts else positions[consumed])
        consumed += len(token)
    if not boundaries or consumed != len(source):
        raise ValueError("Service boundary text does not cover input text")
    segments = []
    for i, event in enumerate(boundaries):
        offset, duration = event["offset"], event["duration"]
        if type(offset) is not int or type(duration) is not int or offset < 0 or duration <= 0:
            raise ValueError("Invalid service offset/duration")
        start_ms = offset // 10000
        end_ms = (offset + duration + 9999) // 10000
        if end_ms > duration_ms:
            raise ValueError("Service boundary exceeds decoded audio duration")
        stop = starts[i + 1] if i + 1 < len(starts) else len(text)
        segments.append({"start_ms": start_ms, "end_ms": end_ms, "text": text[starts[i]:stop]})
    check_segments(text, segments, duration_ms)
    return segments


def check_segments(text, segments, duration_ms):
    previous_end = 0
    if not segments or "".join(s["text"] for s in segments) != text:
        raise ValueError("Transcript must preserve the complete input text")
    for segment in segments:
        start, end = segment["start_ms"], segment["end_ms"]
        if type(start) is not int or type(end) is not int:
            raise ValueError("Offsets must be integer milliseconds")
        if not (previous_end <= start < end <= duration_ms):
            raise ValueError("Invalid, overlapping, or out-of-duration segment")
        previous_end = end


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def inspect_audio(path, label=None):
    """Decode all MP3 samples; a file header alone never establishes valid audio."""
    import imageio_ffmpeg
    from mutagen.mp3 import MP3

    header = MP3(path).info
    if header.sample_rate < 16000 or header.channels not in (1, 2):
        raise ValueError(f"Unsupported audio format: {path}")
    result = subprocess.run(
        [imageio_ffmpeg.get_ffmpeg_exe(), "-v", "error", "-xerror", "-i", str(path),
         "-map", "0:a:0", "-f", "s16le", "-acodec", "pcm_s16le", "-"],
        capture_output=True, check=True, timeout=30,
    )
    samples = array.array("h")
    samples.frombytes(result.stdout)
    if sys.byteorder != "little":
        samples.byteswap()
    if not samples or len(samples) % header.channels:
        raise ValueError(f"Invalid decoded sample count: {path}")
    count = len(samples)
    mean = sum(samples) / count / 32768
    mean_square = sum(x * x for x in samples) / count / (32768 ** 2)
    rms = math.sqrt(mean_square)
    std = math.sqrt(max(0, mean_square - mean * mean))
    low, high = min(samples) / 32768, max(samples) / 32768
    frames = count // header.channels
    metrics = {
        "audio_path": label or str(path),
        "duration_ms": math.ceil(frames * 1000 / header.sample_rate),
        "sample_rate": header.sample_rate,
        "channels": header.channels,
        "decoded_frames": frames,
        "rms": round(rms, 9),
        "amplitude_std": round(std, 9),
        "min_sample": round(low, 9),
        "max_sample": round(high, 9),
        "non_silent": rms > 0.001 and std > 0.001 and high - low > 0.02,
        "sha256": digest(path),
        "size_bytes": path.stat().st_size,
    }
    if not metrics["non_silent"]:
        raise ValueError(f"Audio is silent or constant: {path}")
    return metrics


def srt_time(value):
    return f"{value // 3600000:02}:{value // 60000 % 60:02}:{value // 1000 % 60:02},{value % 1000:03}"


def subtitle_text(segments):
    return "\n\n".join(f"{i}\n{srt_time(s['start_ms'])} --> {srt_time(s['end_ms'])}\n{s['text']}" for i, s in enumerate(segments, 1)) + "\n"


def relative_path(value):
    path = ROOT / value
    if not isinstance(value, str) or path.resolve().is_relative_to(ROOT.resolve()) is False:
        raise ValueError("Output path must remain inside repository")
    return path


def fingerprint(row, manifest, version):
    value = {"text": row["text"], "voice": manifest["voice"], "rate": manifest["rate"],
             "tool_version": version, "boundary": "SentenceBoundary", "pipeline_version": PIPELINE_VERSION}
    return hashlib.sha256(json_bytes(value)).hexdigest()


def validate_raw_alignment(raw, recording_id, version):
    """Reject cached sidecars whose claimed source or event schema changed."""
    expected = {"schema_version": 1, "tool": "edge-tts", "version": version,
                "recording_id": recording_id, "boundary": "SentenceBoundary", "time_unit": "100ns"}
    if not isinstance(raw, dict) or type(raw.get("schema_version")) is not int:
        raise ValueError("Invalid raw alignment schema_version")
    for key, value in expected.items():
        if raw.get(key) != value:
            raise ValueError(f"Invalid raw alignment {key}")
    events = raw.get("events")
    if not isinstance(events, list) or not events:
        raise ValueError("Raw alignment must contain service events")
    for event in events:
        if not isinstance(event, dict) or event.get("type") != "SentenceBoundary":
            raise ValueError("Raw alignment event type must be SentenceBoundary")
        if (type(event.get("offset")) is not int or event["offset"] < 0 or
                type(event.get("duration")) is not int or event["duration"] <= 0 or
                not isinstance(event.get("text"), str) or not event["text"].strip()):
            raise ValueError("Invalid raw alignment event offset/duration/text")
    return events


def publish_files(files, backup_root):
    """Preflight all files and roll back completed replacements on an OSError.

    This protects against ordinary filesystem failures during publication. It
    does not provide atomic visibility to concurrent readers or crash recovery.
    """
    changed = []
    destinations = set()
    # Finish every read, directory check, and snapshot before replacing files.
    for source, destination in files:
        source, destination = Path(source), Path(destination)
        resolved = destination.resolve()
        if resolved in destinations or source.resolve() == resolved:
            raise ValueError("Duplicate publication destination or source equals destination")
        destinations.add(resolved)
        contents = source.read_bytes()
        previous = destination.read_bytes() if destination.exists() else None
        if contents == previous:
            continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        # Check write access without changing any named dataset file.
        with tempfile.TemporaryFile(dir=destination.parent):
            pass
        changed.append((source, destination, previous is not None))
    backup_root = Path(backup_root)
    backup_root.mkdir(parents=True, exist_ok=True)
    prepared = []
    for index, (source, destination, existed) in enumerate(changed):
        backup = backup_root / f"{index:03}.backup" if existed else None
        if backup is not None:
            shutil.copy2(destination, backup)
        prepared.append((source, destination, backup))
    completed = []
    try:
        for source, destination, backup in prepared:
            source.replace(destination)
            completed.append((destination, backup))
    except OSError as error:
        rollback_errors = []
        for destination, backup in reversed(completed):
            try:
                if backup is None:
                    destination.unlink()
                else:
                    backup.replace(destination)
            except OSError as rollback_error:
                rollback_errors.append(f"{destination}: {rollback_error}")
        if rollback_errors:
            raise OSError(f"Publication failed ({error}); rollback also failed: {'; '.join(rollback_errors)}") from error
        raise


def validate_manifest(manifest):
    required = {"schema_version", "data_source", "hotel", "time_zone", "voice", "rate", "recordings"}
    if not isinstance(manifest, dict) or not required.issubset(manifest):
        raise ValueError("Manifest is missing required fields")
    if (type(manifest["schema_version"]) is not int or manifest["schema_version"] != 1 or
            manifest["data_source"] != "synthetic demo data"):
        raise ValueError("Only the schema v1 synthetic demo manifest is supported")
    if manifest["hotel"] != "Demo Hotel" or manifest["time_zone"] != "Asia/Shanghai":
        raise ValueError("Manifest must identify Demo Hotel in Asia/Shanghai")
    if not isinstance(manifest["voice"], str) or not manifest["voice"].strip():
        raise ValueError("Manifest voice must be a nonempty string")
    if not isinstance(manifest["rate"], str) or not re.fullmatch(r"[+-]\d+%", manifest["rate"]):
        raise ValueError("Manifest rate must be a signed integer percentage")
    if not isinstance(manifest["recordings"], list) or len(manifest["recordings"]) != 8:
        raise ValueError("Manifest must contain eight recordings")
    ids = set()
    paths = set()
    for row in manifest["recordings"]:
        if not isinstance(row, dict) or not {"recording_id", "audio_path", "text", "started_at"}.issubset(row):
            raise ValueError("Manifest recording is missing required fields")
        rid = row["recording_id"]
        if not isinstance(rid, str) or not re.fullmatch(r"R00[1-8]", rid) or rid in ids:
            raise ValueError("Invalid or duplicate recording_id")
        if row["audio_path"] != f"audio/{rid}.mp3" or row["audio_path"] in paths:
            raise ValueError("Invalid or duplicate audio_path")
        if not isinstance(row["text"], str) or not row["text"].strip() or len(row["text"]) > 200:
            raise ValueError("Empty or overlong demo script")
        if not isinstance(row["started_at"], str):
            raise ValueError("started_at must be an ISO timestamp")
        offset = datetime.fromisoformat(row["started_at"]).utcoffset()
        if offset is None or offset.total_seconds() != 28800:
            raise ValueError("started_at must include the +08:00 offset")
        ids.add(rid)
        paths.add(row["audio_path"])


async def synthesize(row, manifest, target):
    import edge_tts

    events = []
    communicator = edge_tts.Communicate(row["text"], manifest["voice"], rate=manifest["rate"], boundary="SentenceBoundary")
    with target.open("wb") as stream:
        async for chunk in communicator.stream():
            if chunk["type"] == "audio":
                stream.write(chunk["data"])
            elif chunk["type"] in ("WordBoundary", "SentenceBoundary"):
                events.append(chunk)
    return events


def generate(manifest_path, force):
    # Even constructing an asyncio loop needs sockets on Windows; cached runs
    # must reach the offline path before any event loop is created.
    manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    validate_manifest(manifest)
    version = importlib.metadata.version("edge-tts")
    metadata_path = ROOT / "data/audio-metadata.json"
    old = json.loads(metadata_path.read_text(encoding="utf-8")) if metadata_path.exists() else {}
    cached = {r["recording_id"]: r for r in old.get("recordings", [])}
    now = datetime.now(timezone.utc).isoformat()
    envelope = {key: manifest[key] for key in ("data_source", "hotel", "time_zone")}
    recordings, metadata_rows, publish = [], [], []
    staging_root = ROOT / ".cache/audio-generation"
    staging_root.mkdir(parents=True, exist_ok=True)
    # Nothing in audio/ or data/ changes until every clip has passed real decoding.
    with tempfile.TemporaryDirectory(prefix="batch-", dir=staging_root) as staging:
        stage = Path(staging)
        for row in manifest["recordings"]:
            rid = row["recording_id"]
            input_hash = fingerprint(row, manifest, version)
            mp3 = relative_path(row["audio_path"])
            raw_name = f"audio/{rid}.boundaries.json"
            srt_name = f"audio/{rid}.srt"
            prior = cached.get(rid)
            reusable = False
            if not force and prior and prior.get("input_sha256") == input_hash:
                try:
                    raw = json.loads(relative_path(raw_name).read_text(encoding="utf-8"))
                    events = validate_raw_alignment(raw, rid, version)
                    metrics = inspect_audio(mp3, row["audio_path"])
                    segments = boundary_segments(row["text"], events, metrics["duration_ms"])
                    reusable = (metrics["sha256"] == prior["sha256"] and
                                relative_path(srt_name).read_text(encoding="utf-8") == subtitle_text(segments))
                except (OSError, ValueError, KeyError, subprocess.SubprocessError):
                    reusable = False
            if reusable:
                item = {**prior, **metrics}
                print(f"{rid}: verified cache ({metrics['duration_ms']} ms)", file=sys.stderr)
            else:
                target = stage / f"{rid}.mp3"
                print(f"{rid}: synthesizing {manifest['voice']} {manifest['rate']}", file=sys.stderr)
                events = asyncio.run(synthesize(row, manifest, target))
                metrics = inspect_audio(target, row["audio_path"])
                segments = boundary_segments(row["text"], events, metrics["duration_ms"])
                raw = {"schema_version": 1, "tool": "edge-tts", "version": version, "recording_id": rid,
                       "boundary": "SentenceBoundary", "time_unit": "100ns", "events": events,
                       "text_normalization": NORMALIZATION}
                validate_raw_alignment(raw, rid, version)
                raw_target = stage / f"{rid}.boundaries.json"
                raw_target.write_bytes(json_bytes(raw))
                srt_target = stage / f"{rid}.srt"
                srt_target.write_text(subtitle_text(segments), encoding="utf-8", newline="\n")
                publish.extend([(target, mp3), (raw_target, relative_path(raw_name)), (srt_target, relative_path(srt_name))])
                item = {"recording_id": rid, **metrics, "input_sha256": input_hash, "generated_at": now,
                        "transcript_source": "service_sentence_boundary",
                        "timestamp_precision": "100ns service ticks, rounded outward to integer milliseconds",
                        "raw_alignment_path": raw_name, "subtitle_path": srt_name, "boundary_count": len(events)}
            if not 5000 <= metrics["duration_ms"] <= 20000:
                raise ValueError(f"{rid}: decoded duration {metrics['duration_ms']} ms outside 5000..20000; adjust manifest rate then rerun")
            recordings.append({key: row[key] for key in ("recording_id", "started_at", "audio_path")})
            recordings[-1]["transcript_segments"] = segments
            metadata_rows.append(item)
        if len({r["sha256"] for r in metadata_rows}) != 8:
            raise ValueError("Every demo recording must have distinct audio")
        metadata = {"schema_version": 1, **envelope, "tool": "edge-tts", "version": version,
                    "voice": manifest["voice"], "rate": manifest["rate"], "boundary": "SentenceBoundary",
                    "generated_at": now if publish else old.get("generated_at", now),
                    "recordings": metadata_rows}
        for name, payload in (("recordings.json", {**envelope, "recordings": recordings}), ("audio-metadata.json", metadata)):
            target = stage / name
            target.write_bytes(json_bytes(payload))
            publish.append((target, ROOT / "data" / name))
        publish_files(publish, stage / "publication-backups")
    return {"schema_version": 1, "generated_count": sum(r["generated_at"] == now for r in metadata_rows),
            "cached_count": sum(r["generated_at"] != now for r in metadata_rows),
            "recordings": metadata_rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=ROOT / "data/tts-manifest.json")
    parser.add_argument("--force", action="store_true", help="Regenerate even when content and verified cached MP3 match")
    parser.add_argument("--inspect", nargs="+", metavar="MP3", help="Offline decode validation, JSON-only stdout")
    parser.add_argument("--self-test", action="store_true", help="Run offline unit tests without network")
    args = parser.parse_args()
    if args.self_test:
        suite = unittest.defaultTestLoader.discover(str(ROOT / "tests/unit"), pattern="test_generate_audio.py")
        return 0 if unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful() else 1
    if args.inspect:
        result = {"schema_version": 1, "decoder": "ffmpeg", "recordings": [inspect_audio(relative_path(p), p) for p in args.inspect]}
    else:
        result = generate(args.manifest, args.force)
    print(json.dumps(result, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(f"Audio pipeline failed: {error}", file=sys.stderr)
        raise SystemExit(1)
