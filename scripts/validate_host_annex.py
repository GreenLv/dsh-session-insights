#!/usr/bin/env python3
"""Validate portable native-acceptance/v2 structure and factual bindings."""
import argparse
import json
from pathlib import Path
import re
import sys
from datetime import datetime

from jsonschema import Draft202012Validator, FormatChecker

PORTABLE = {
    'artifact_digest', 'artifact_identity', 'runtime_closure', 'host_cli_identity',
    'install_official_cli', 'installed_manifest', 'uninstall_official_cli',
    'reload_official_cli', 'reloaded_manifest', 'loaded_manifest',
    'load_and_register', 'project_isolation', 'deterministic_report',
    'cancel_recovers', 'rerun_after_cancel', 'registration_reload', 'dispose_cleanup',
}

def validate(value):
    schema = json.loads((Path(__file__).resolve().parents[1]/'docs/schema/native-acceptance-v2.schema.json').read_text(encoding='utf-8'))
    if next(Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(value), None):
        raise ValueError('annex shape or field format invalid')
    def private_scan(item):
        if isinstance(item, dict):
            for child in item.values(): private_scan(child)
        elif isinstance(item, list):
            for child in item: private_scan(child)
        elif isinstance(item, str):
            local = re.search(r'(?:^|\s)(?:/Users/|/private/|/tmp/|[A-Za-z]:[\\/])', item)
            secret = re.search(r'github_pat_|ghp_|Bearer\s|sk-[A-Za-z0-9_-]{16,}', item)
            if local or secret: raise ValueError('annex contains private path or credential-like text')
    private_scan(value)
    artifact = value['artifact']
    if artifact:
        if artifact['git_head'] != value['repository']['commit'] or '/' in artifact['filename'] or '\\' in artifact['filename']:
            raise ValueError('artifact identity does not match repository')
    ids = set()
    for gate in value['gates']:
        if gate['id'] in ids:
            raise ValueError('duplicate gate')
        ids.add(gate['id'])
        subject = gate['subject']
        expected = {'commit': value['repository']['commit'], 'runtime_tree': value['runtime_tree_sha256'], 'artifact': artifact['sha256'] if artifact else None}
        if expected.get(subject['kind']) != subject['id']:
            raise ValueError('gate subject mismatch')
        status, code = gate['status'], gate['exit_code']
        if (status == 'passed' and code != 0) or (status == 'failed' and (code is None or code == 0)) or (status in ('not_run', 'skipped') and code is not None):
            raise ValueError('gate exit code disagrees with status')
        evidence = gate['evidence']
        if evidence['mode'] != 'executed' or evidence['source_result_sha256'] is not None or evidence['source_gate_id'] is not None:
            raise ValueError('this entry accepts freshly executed evidence only')
    if value['gate_profile'] == 'portable-installed-artifact':
        required = {gate['id'] for gate in value['gates'] if gate['required']}
        if required != PORTABLE:
            raise ValueError('portable gate set is incomplete')
        if value['status'] == 'passed' and (not artifact or not value['runtime_tree_sha256']):
            raise ValueError('passed portable gate needs artifact and runtime identities')
    passed = all(not g['required'] or g['status'] == 'passed' for g in value['gates']) and not any(g['status'] == 'failed' for g in value['gates']) and value['cleanup'] == {'status': 'passed', 'remaining_ids': []}
    if value['status'] != ('passed' if passed else 'failed'):
        raise ValueError('derived status disagrees with annex')
    if datetime.fromisoformat(value['run']['finished_at'].replace('Z', '+00:00')) < datetime.fromisoformat(value['run']['started_at'].replace('Z', '+00:00')):
        raise ValueError('finish precedes start')
    return {'status': 'valid', 'acceptance_status': value['status'], 'gate_count': len(ids)}

def main():
    parser = argparse.ArgumentParser(); parser.add_argument('annex', type=Path)
    args = parser.parse_args()
    try:
        result = validate(json.loads(args.annex.read_text(encoding='utf-8')))
    except (OSError, ValueError, KeyError, TypeError):
        print(json.dumps({'status': 'invalid'})); return 1
    print(json.dumps(result)); return 0

if __name__ == '__main__':
    sys.exit(main())
