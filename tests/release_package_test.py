"""Release package extensibility, immutable bridge identity and build inputs."""
import importlib.util
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("release_builder", ROOT / "scripts/build_release_archive.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class ReleasePackageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="xdrive-package-build-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.stage = self.root / "stage"
        self.stage.mkdir()
        for name in builder.CORE:
            (self.stage / name).write_bytes(("fixture " + name).encode())
        (self.stage / "RELEASE.txt").write_text("version=v1.3.7\nos=linux\narchitecture=amd64\n\nLicense text\n")

    def test_complete_package_can_have_twenty_additional_files_while_bridge_stays_compatible(self):
        for index in range(20):
            resource = self.stage / "assets/icons" / f"{index}.dat"
            resource.parent.mkdir(parents=True, exist_ok=True)
            resource.write_bytes(f"resource-{index}".encode())
        full, legacy = self.root / "full.tar.gz", self.root / "bridge.tar.gz"
        builder.build(self.stage, full)
        builder.build(self.stage, legacy, legacy=True)
        with tarfile.open(full) as archive:
            self.assertEqual(len(archive.getmembers()), 25)
            self.assertTrue(all(member.isfile() for member in archive.getmembers()))
            release = archive.extractfile("RELEASE.txt").read().decode()
            manifest = json.loads(release.split(builder.BEGIN + "\n")[1].split("\n" + builder.END)[0])
            self.assertEqual(len(manifest["files"]), 24)
        with tarfile.open(legacy) as archive:
            self.assertEqual(set(archive.getnames()), builder.CORE | {"RELEASE.txt"})
        builder.verify_bridge(legacy, "v1.3.7", "amd64")

    def test_bridge_cannot_be_replaced_by_wrong_release_or_architecture(self):
        bridge = self.root / "bridge.tar.gz"
        builder.build(self.stage, bridge, legacy=True)
        for version, architecture in [("v1.3.8", "amd64"), ("v1.3.7", "arm64")]:
            with self.subTest(version=version, architecture=architecture), self.assertRaises(ValueError):
                builder.verify_bridge(bridge, version, architecture)

    def test_extra_files_cannot_override_bootstrap_files(self):
        extra = self.root / "extra"
        extra.mkdir()
        (extra / "xdrive").write_bytes(b"unexpected replacement")
        with self.assertRaises(ValueError):
            builder.build(self.stage, self.root / "bad.tar.gz", extra=extra)

    def test_links_and_nonportable_names_are_rejected(self):
        for name in ["linked.dat", "bad name.dat"]:
            resource = self.stage / name
            if name == "linked.dat":
                resource.symlink_to(self.stage / "xdrive")
            else:
                resource.write_bytes(b"invalid path")
            with self.subTest(name=name), self.assertRaises(ValueError):
                builder.build(self.stage, self.root / "bad.tar.gz")
            resource.unlink()

    def test_package_output_is_reproducible(self):
        first, second = self.root / "first.tar.gz", self.root / "second.tar.gz"
        builder.build(self.stage, first)
        builder.build(self.stage, second)
        self.assertEqual(first.read_bytes(), second.read_bytes())


if __name__ == "__main__":
    unittest.main()
