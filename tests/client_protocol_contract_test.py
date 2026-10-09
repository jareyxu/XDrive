"""Keep the server and browser mutation protocol generation in lockstep."""

from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]


class ClientProtocolContractTests(unittest.TestCase):
    def test_go_server_and_browser_use_the_same_integer_protocol_version(self):
        server = (ROOT / "internal/server/server.go").read_text()
        client = (ROOT / "web/src/api/client.ts").read_text()
        protocol = (ROOT / "web/src/api/protocol.ts").read_text()
        fixture = (ROOT / "web/e2e/encrypted-directory-fixture.ts").read_text()
        server_match = re.search(r"(?m)^const clientProtocolVersion = ([0-9]+)$", server)
        client_match = re.search(r"(?m)^export const CLIENT_PROTOCOL_VERSION = '([0-9]+)'$", protocol)
        self.assertIsNotNone(server_match, "Go server protocol version declaration was not found")
        self.assertIsNotNone(client_match, "browser protocol version declaration was not found")
        self.assertEqual(int(server_match.group(1)), int(client_match.group(1)))
        self.assertIn("import { CLIENT_PROTOCOL_VERSION } from './protocol'", client)
        self.assertIn("headers.set('X-XDrive-Client-Protocol', CLIENT_PROTOCOL_VERSION)", client)
        self.assertIn("'X-XDrive-Client-Protocol': CLIENT_PROTOCOL_VERSION", client)
        self.assertIn("import { CLIENT_PROTOCOL_VERSION } from '../src/api/protocol'", fixture)
        self.assertEqual(fixture.count("'X-XDrive-Client-Protocol': CLIENT_PROTOCOL_VERSION"), 2)


if __name__ == "__main__":
    unittest.main()
