import hashlib, json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
data = json.loads((root/'decantx/merged.json').read_text(encoding='utf-8'))
backup_path = root/'decantx/merged.backup-20261115-003000.json'
backup = json.loads(backup_path.read_text(encoding='utf-8-sig'))
report = json.loads((root/'decantx/notes-enrichment-report.json').read_text(encoding='utf-8'))
assert len(data) == len(backup) == report['products'] == 4062
assert [p['name'] for p in data] == [p['name'] for p in backup]
for old, new in zip(backup, data):
    assert {k:v for k,v in old.items() if k != 'notes'} == {k:v for k,v in new.items() if k != 'notes'}
    assert any(new['notes'].get(k) for k in ('top','middle','base','key'))
    for tier in ('top','middle','base','key'):
        vals = new['notes'].get(tier, [])
        assert isinstance(vals, list) and all(isinstance(n,str) and n.strip() for n in vals)
assert not report['unresolved']
assert hashlib.sha256(backup_path.read_bytes()).hexdigest() == report['backup_sha256']
checks = {
    1924: ([], [], [], {'Magnolia','Jasmine','Vanilla','Almond','Sandalwood','Heliotrope','Hedione'}),
    2206: ([], [], [], {'Bergamot','Petitgrain','Grapefruit','Amber','Musk','Vetiver'}),
    2317: ({'Juniper Berries','Nutmeg'}, {'Coriander'}, {'Vanilla','Musk','Caramel','Amberwood'}, set()),
    2318: ({'Juniper Berries','Nutmeg','Bergamot','Pineapple'}, {'Coriander'}, {'Musk','Woody Notes','Cedar','Amber','Vanilla'}, set()),
    4053: ({'Danish Sea-Buckthorn'}, {'French Jasmin Absolute'}, {'Driftwood Accord'}, set()),
}
for i, (top, mid, base, key) in checks.items():
    n=data[i]['notes']
    for tier, expected in zip(('top','middle','base','key'), (top,mid,base,key)):
        if expected: assert set(n[tier]) == expected, (i,tier,n[tier])
print(json.dumps({'products':len(data),'all_have_notes':True,'non_note_fields_unchanged':True,'backup_sha256':report['backup_sha256'],'output_sha256':hashlib.sha256((root/'decantx/merged.json').read_bytes()).hexdigest(),'full_pyramids':report['complete_pyramids'],'flat_note_lists':report['flat_only'],'partial_pyramids':report['partial_pyramids'],'empty_tiers':report['empty_tiers'],'audit_changes':report['changed'],'source_links_in_audit':sum(bool(e.get('url')) for c in report['changes'] for e in c.get('evidence',[]))},ensure_ascii=False,indent=2))
