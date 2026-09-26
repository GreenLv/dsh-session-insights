"""V4-only rejection and physical framing checks; no source log is migrated."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from dsh_session_insights.v4 import validate_records
from dsh_session_insights import analyzer
from helpers import records, compress_dsh_generation

class V4AdmissionTests(unittest.TestCase):
    def test_critical_structure_and_versions_fail(self):
        for version in (None, 0, 3, 5):
            rows=records(); rows[0]['version']=version
            with self.assertRaisesRegex(ValueError,'V4'): validate_records(rows,analyzer.DSH_KNOWN_RECORD_TYPES)
        for mutation in ('source','call','role','isError','sequence','required'):
            rows=records()
            if mutation=='source': rows[3]['data']['source']={'kind':'plugin','plugin':'test'}
            if mutation=='call': rows[6]['data']['message']['toolCallId']='conflict'
            if mutation=='role': rows[6]['data']['message']['role']='user'
            if mutation=='isError': rows[6]['data']['message']['isError']='false'
            if mutation=='sequence': rows[3]['seq']=99
            if mutation=='required': rows[2]['type']='example/required'
            with self.assertRaises(ValueError): validate_records(rows,analyzer.DSH_KNOWN_RECORD_TYPES)

    def test_physical_ranges_decode_and_bad_ranges_fail(self):
        path=Path(__file__).parent/'fixtures/rc2-extended/session.v4.jsonl'
        rows=[json.loads(line) for line in path.read_text().splitlines()]
        self.assertTrue(any(isinstance(n,list) for row in rows for n in row.get('sourceEventSeqs',[])))
        validate_records(rows,analyzer.DSH_KNOWN_RECORD_TYPES,physical=True)
        self.assertTrue(all(type(n) is int for row in rows for n in row.get('sourceEventSeqs',[])))
        broken=copy.deepcopy(rows);broken[-3]['sourceEventSeqs']=[[0,999999]]
        with self.assertRaises(ValueError):validate_records(broken,analyzer.DSH_KNOWN_RECORD_TYPES,physical=True)

    def test_first_frame_must_be_only_header(self):
        import zstandard
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/'session.v4.jsonl.zstd'
            lines=[json.dumps(row) for row in records()]
            path.write_bytes(zstandard.ZstdCompressor().compress(('\n'.join(lines)+'\n').encode()))
            with self.assertRaisesRegex(ValueError,'header line'):analyzer.read_dsh_jsonl_lines(path)
            path.write_bytes(compress_dsh_generation(lines))
            self.assertEqual(len(analyzer.read_dsh_jsonl_lines(path)),len(lines))
