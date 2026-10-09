"""Keep the documented persistent-format matrix aligned with current readers."""

from __future__ import annotations

import json
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]


def source(path: str) -> str:
    return (ROOT / path).read_text()


def version(match: re.Match[str] | None, label: str) -> int:
    if match is None:
        raise AssertionError(f"could not find {label} version declaration")
    return int(match.group(1))


class PersistentFormatContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.matrix = json.loads(source("docs/format-version-matrix.json"))
        cls.contracts = cls.matrix["contracts"]

    def test_encrypted_object_envelope_versions_match_browser_codec(self):
        codec = source("web/src/crypto/envelope.ts")
        contract = self.contracts["encryptedObjectEnvelope"]
        written = version(re.search(r"(?m)^const VERSION = (\d+)$", codec), "object envelope")
        cipher = version(re.search(r"(?m)^const AES_256_GCM = (\d+)$", codec), "object cipher")
        self.assertEqual(contract["writeVersion"], written)
        self.assertEqual(contract["readVersions"], [written])
        self.assertEqual(contract["cipherId"], cipher)

    def test_vault_and_file_crypto_versions_match_reader_and_writer(self):
        keys = source("web/src/crypto/keys.ts")
        aad = source("web/src/crypto/aad.ts")
        client = source("web/src/api/client.ts")
        contract = self.contracts["vaultConfigAndKeySlotAad"]
        version_list = re.search(r"readonly formatVersion: ([^\n]+)", keys)
        self.assertIsNotNone(version_list, "vault config format-version type was not found")
        self.assertEqual(version_list.group(1).replace(" ", ""), "1|2")
        self.assertIn("formatVersion: 2", client, "new vault setup must use format version 2")
        self.assertEqual(contract["writeVersion"], 2)
        self.assertEqual(contract["readVersions"], [1, 2])
        self.assertIn("version is 1 | 2", aad)
        self.assertIn("u32be(input.formatVersion)", aad)
        self.assertIn("vault.vaultConfig.formatVersion === 2 ? 2 : 1", client)
        crypto_contract = self.contracts["fileCrypto"]
        self.assertEqual(crypto_contract["writeByVaultFormat"], {"1": 1, "2": 2})
        self.assertEqual(crypto_contract["readVersions"], [1, 2])

    def test_index_and_trash_schema_versions_match_strict_readers_and_writers(self):
        client = source("web/src/api/client.ts")
        version_one_writers = len(re.findall(r"JSON\.stringify\(\{ version: 1, indexId:", client))
        self.assertGreaterEqual(version_one_writers, 1)
        self.assertGreaterEqual(client.count("candidate.version !== 1"), 2)
        self.assertEqual(self.contracts["directoryIndex"]["writeVersion"], 1)
        self.assertEqual(self.contracts["directoryIndex"]["readVersions"], [1])
        self.assertEqual(self.contracts["trashIndex"]["writeVersion"], 1)
        self.assertEqual(self.contracts["trashIndex"]["readVersions"], [1])
        self.assertIn("function hasExactKeys", client)
        self.assertIn("['entryId', 'kind', 'name', 'childIndexId', ...timestamps]", client)
        self.assertIn("['entryId', 'kind', 'name', 'size', 'mime', 'fileId', 'manifestObjectId', 'manifestSha256'", client)
        self.assertIn("['tombstoneId', 'item', 'originalParentId', 'originalPath', 'deletedAt']", client)
        self.assertIn("['indexId', 'childIndexId', 'name']", client)
        self.assertEqual(
            self.contracts["directoryIndex"]["folderEntryRequiredFields"],
            ["entryId", "kind", "name", "childIndexId"],
        )
        self.assertEqual(
            self.contracts["directoryIndex"]["fileEntryRequiredFields"],
            ["entryId", "kind", "name", "size", "mime", "fileId", "manifestObjectId", "manifestSha256"],
        )
        self.assertEqual(
            self.contracts["trashIndex"]["originalPathEntryRequiredFields"],
            ["indexId", "childIndexId", "name"],
        )
        self.assertEqual(
            self.contracts["directoryIndex"]["optionalEntryFields"],
            {"allEntries": ["originalModifiedAt", "createdAt"], "fileEntries": ["fileCryptoVersion", "thumbnail"]},
        )

    def test_manifest_and_recovery_versions_match_strict_readers_and_writers(self):
        client = source("web/src/api/client.ts")
        resume = source("web/src/uploads/resume.ts")
        self.assertIn("const isCurrentSchema = candidate.version === 3", client)
        self.assertIn("candidate.version !== 1 && candidate.version !== 2", client)
        self.assertIn("version: 3,\n    fileCryptoVersion", client)
        self.assertIn("version: 4, fileCryptoVersion", client)
        self.assertIn("value.version !== 1 && value.version !== 2 && value.version !== 3 && value.version !== 4", resume)
        self.assertIn("value.version === 4 ? value.fileCryptoVersion !== 1 && value.fileCryptoVersion !== 2 : Object.hasOwn(value, 'fileCryptoVersion')", resume)
        self.assertIn("value.version === 3 || value.version === 4", resume)
        self.assertEqual(self.contracts["fileManifest"]["currentWriteVersion"], 3)
        self.assertEqual(self.contracts["fileManifest"]["readSchemaVersions"], [1, 2, 3])
        self.assertEqual(self.contracts["uploadRecoveryPayload"]["currentWriteVersion"], 4)
        self.assertEqual(self.contracts["uploadRecoveryPayload"]["readVersions"], [1, 2, 3, 4])

    def test_aad_local_state_backup_database_and_client_versions_match_sources(self):
        aad = source("web/src/crypto/aad.ts")
        local_state = source("web/src/uploads/resume.ts")
        backup = source("internal/backup/backup.go")
        database = source("internal/db/db.go")
        existing_database = source("internal/db/existing.go")
        server = source("internal/server/server.go")
        protocol = source("web/src/api/protocol.ts")

        self.assertIn("lp(utf8Strict('xdrive/v1/index')),\n    u32be(1)", aad)
        self.assertIn("lp(utf8Strict('xdrive/v1/local-state')),\n    u32be(1)", aad)
        self.assertIn("xdrive-local-v1", local_state)
        self.assertEqual(version(re.search(r"(?m)^const formatVersion = (\d+)$", backup), "backup"), self.contracts["backup"]["writeFormatVersion"])
        self.assertEqual(version(re.search(r"(?m)^const schemaVersion = (\d+)$", database), "SQLite"), self.contracts["sqlite"]["currentSchemaVersion"])
        minimum_schema = self.contracts["backup"]["snapshotSchemaRange"]["minimum"]
        maximum_schema = self.contracts["backup"]["snapshotSchemaRange"]["maximum"]
        self.assertIn(f"version >= {minimum_schema} && version <= schemaVersion", database)
        self.assertEqual(maximum_schema, self.contracts["sqlite"]["currentSchemaVersion"])
        self.assertIn("header.FormatVersion != formatVersion", backup)
        self.assertIn("manifest.FormatVersion != formatVersion", backup)
        self.assertIn("db.OpenBackupMetadata(ctx, settings.DatabasePath)", backup)
        self.assertIn("func OpenBackupMetadata(ctx context.Context, path string)", existing_database)
        self.assertEqual(version(re.search(r"(?m)^const clientProtocolVersion = (\d+)$", server), "Go client protocol"), self.contracts["clientMutationProtocol"]["currentVersion"])
        self.assertIn(f"export const CLIENT_PROTOCOL_VERSION = '{self.contracts['clientMutationProtocol']['currentVersion']}'", protocol)

    def test_matrix_has_sorted_unique_read_versions_and_explicit_rejection_policy(self):
        for name, contract in self.contracts.items():
            versions = contract.get("readVersions") or contract.get("readSchemaVersions")
            if versions is not None:
                self.assertEqual(versions, sorted(set(versions)), name)
                write = contract.get("writeVersion", contract.get("currentWriteVersion", contract.get("writeFormatVersion")))
                if write is not None:
                    self.assertIn(write, versions, name)
        self.assertEqual(self.matrix["status"], "release-approved")
        approval = self.matrix["releaseApproval"]
        self.assertEqual(approval["version"], "v1.3.3")
        self.assertRegex(approval["reviewedAt"], r"^\d{4}-\d{2}-\d{2}$")
        self.assertTrue(approval["reviewer"].strip())
        self.assertTrue(approval["evidence"])
        aad = self.contracts["aadDomains"]
        self.assertEqual(aad["keySlotFormatVersions"], self.contracts["vaultConfigAndKeySlotAad"]["readVersions"])
        self.assertEqual(aad["chunkManifestThumbnailCryptoVersions"], self.contracts["fileCrypto"]["readVersions"])


if __name__ == "__main__":
    unittest.main()
