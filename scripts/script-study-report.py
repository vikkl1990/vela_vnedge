"""Assemble the line-by-line script study into a report, a contract per script, and proposed readings.

The study itself was run by model readers, one per batch of Pine sources, with a second reader trying to refute every
claimed misread on a script that trades. This script only collects their output; it reads files and writes three:

  python3 scripts/script-study-report.py RESULTS_DIR READINGS_JSON OUT_DIR

RESULTS_DIR holds batches/, results/ and verify/ from the study. READINGS_JSON is the live scanner readings
({"scanners": {id: {enabled, sources, labels, sides, ...}}}) used to mark enabled scanners and show the current reading.
"""
import collections, glob, json, os, sys

src, readings_path, out = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(out, exist_ok=True)
live = json.load(open(readings_path))['scanners']

batches = {}
for p in sorted(glob.glob(os.path.join(src, 'batches', 'batch-*.json'))):
    for s in json.load(open(p))['scripts']:
        batches[os.path.basename(s['file'])] = {r['id']: r for r in s['readings']}

rows, missing = [], []
for p in sorted(glob.glob(os.path.join(src, 'batches', 'batch-*.json'))):
    name = os.path.basename(p)[:-5]
    rp = os.path.join(src, 'results', name + '.json')
    want = json.load(open(p))['scripts']
    try:
        got = json.load(open(rp))
    except Exception:
        missing += [os.path.basename(s['file']) for s in want]
        continue
    by_file = {os.path.basename(x.get('file', '')): x for x in got}
    for s in want:
        x = by_file.get(os.path.basename(s['file']))
        if x is None: missing.append(os.path.basename(s['file'])); continue
        x['file'] = os.path.basename(s['file']); x['batch'] = name
        rows.append(x)

checks = {}
for p in glob.glob(os.path.join(src, 'verify', 'batch-*.json')):
    for c in json.load(open(p)):
        checks[(c.get('id'), (c.get('marker') or '').strip().lower(), c.get('problem'))] = c

def trading(i): return bool((live.get(i) or {}).get('enabled')) or any((r.get(i) or {}).get('pairs', 0) > 0 for r in batches.values())
pairs_of = {i: r['pairs'] for rs in batches.values() for i, r in rs.items()}
enabled = {i for i, v in live.items() if v.get('enabled')}

for x in rows:
    for m in x.get('botMisreads') or []:
        c = checks.get((m.get('id'), (m.get('marker') or '').strip().lower(), m.get('problem')))
        m['check'] = 'confirmed' if c and c.get('upheld') else 'refuted' if c else ('unchecked' if trading(m.get('id')) else 'not-trading')
        if c and c.get('why'): m['checkNote'] = c['why']

# 1. one contract per script, one line each
with open(os.path.join(out, 'contracts.jsonl'), 'w') as f:
    for x in rows: f.write(json.dumps(x, ensure_ascii=False, separators=(',', ':')) + '\n')

# 2. proposed readings for scripts that trade, only where a misread survived the check
proposed = {}
for x in rows:
    for i in x.get('ids') or []:
        if not trading(i): continue
        kept = [m for m in (x.get('botMisreads') or []) if m.get('id') == i and m['check'] == 'confirmed']
        if not kept: continue
        proposed[i] = {'file': x['file'], 'enabled': i in enabled, 'pairs': pairs_of.get(i, 0), 'verdict': x.get('verdict'),
                       'current': {k: v for k, v in (live.get(i) or {}).items() if k != 'enabled'},
                       'proposed': x.get('proposedReading') or {}, 'because': [{k: m.get(k) for k in ('marker', 'problem', 'line', 'evidence', 'fix')} for m in kept]}
json.dump(proposed, open(os.path.join(out, 'proposed-readings.json'), 'w'), indent=1, ensure_ascii=False)

# 3. the report
C = collections.Counter
mis = [(x, m) for x in rows for m in (x.get('botMisreads') or [])]
trade_rows = [x for x in rows if any(trading(i) for i in x.get('ids') or [])]
L = []
def table(head, rows_):
    L.append('| ' + ' | '.join(head) + ' |'); L.append('|' + '---|' * len(head))
    for r in rows_: L.append('| ' + ' | '.join(str(c) for c in r) + ' |')
    L.append('')
L += ['# Script study', '', f'Every Pine source in the library read line by line by a model reader and compared with the way the bot reads it: {len(rows)} sources, {sum(int(x.get("lines") or 0) for x in rows):,} lines. '
      f'On scripts that trade, a second reader tried to refute every claimed misread. Findings are proposals: no reading has been changed.', '']
if missing: L += [f'Not read: {len(missing)} sources ({", ".join(missing[:8])}{" …" if len(missing) > 8 else ""}).', '']
L += ['## What the library is', '']
table(['Verdict', 'All scripts', 'Scripts that trade'], [(v, n, sum(1 for x in trade_rows if x.get('verdict') == v)) for v, n in C(x.get('verdict') for x in rows).most_common()])
table(['Kind', 'Scripts'], C(x.get('type') for x in rows).most_common())
own = lambda k: sum(1 for x in rows if (x.get(k) or {}).get('has'))
table(['The script has its own', 'Scripts', 'Readable by the bot'], [
    ('stop', own('stop'), sum(1 for x in rows if (x.get('stop') or {}).get('has') and (x['stop'].get('readable') or 'no') != 'no')),
    ('targets', own('targets'), sum(1 for x in rows if (x.get('targets') or {}).get('has') and (x['targets'].get('readable') or 'no') != 'no')),
    ('exit', own('exit'), ''), ('open-trade state that gates its later alerts', sum(1 for x in rows if x.get('tracksOwnPosition')), '')])
tm = [(x, x.get('timing') or {}) for x in rows]
table(['Timing', 'All scripts', 'Scripts that trade'], [
    ('signal not known at the bar close', sum(1 for _, t in tm if t.get('knownAtClose') is False), sum(1 for x, t in tm if t.get('knownAtClose') is False and x in trade_rows)),
    ('drawings or signals repaint', sum(1 for _, t in tm if t.get('repaints')), sum(1 for x, t in tm if t.get('repaints') and x in trade_rows)),
    ('higher-timeframe data can see an unfinished bar', sum(1 for _, t in tm if t.get('lookahead') == 'unsafe'), sum(1 for x, t in tm if t.get('lookahead') == 'unsafe' and x in trade_rows)),
    ('entry built on a pivot confirmed 10+ bars late', sum(1 for _, t in tm if (t.get('pivotLagBars') or 0) >= 10), sum(1 for x, t in tm if (t.get('pivotLagBars') or 0) >= 10 and x in trade_rows))])

L += ['## How the bot misreads them', '', 'A misread compares the author\'s intent with what the bot trades. On scripts that trade, each claim was checked by a second reader.', '']
kinds = ['wrong-side', 'exit-misread', 'not-an-entry', 'unconfirmed-marker', 'entry-not-read', 'side-dropped']
desc = {'wrong-side': 'traded on the side opposite to the author\'s', 'exit-misread': 'an exit or reversal alert read on the wrong side or as an entry',
        'not-an-entry': 'a regime, exit or information marker traded as an entry', 'unconfirmed-marker': 'a marker traded without the script\'s own confirmation',
        'entry-not-read': 'the author\'s real entry is not read', 'side-dropped': 'one side traded, its mirror not'}
table(['Misread', 'Meaning', 'All claims', 'On trading scripts', 'Confirmed', 'Refuted'],
      [(k, desc[k], sum(1 for _, m in mis if m.get('problem') == k), sum(1 for _, m in mis if m.get('problem') == k and m['check'] != 'not-trading'),
        sum(1 for _, m in mis if m.get('problem') == k and m['check'] == 'confirmed'), sum(1 for _, m in mis if m.get('problem') == k and m['check'] == 'refuted')) for k in kinds])

L += ['## Enabled scanners', '']
for x in rows:
    for i in [i for i in x.get('ids') or [] if i in enabled]:
        ms = [m for m in x.get('botMisreads') or [] if m.get('id') == i]
        L.append(f'**{i}** ({x["file"]}): {x.get("verdict")}, {x.get("type")}, {x.get("confidence")} confidence. {x.get("idea") or ""}')
        for m in ms: L.append(f'- {m["check"]}: {m.get("problem")} "{m.get("marker")}" (line {m.get("line")}). {m.get("evidence") or ""} Fix: {m.get("fix") or ""}')
        if not ms: L.append('- No misread: the bot reads this script as its author intends.')
        st, tg, ex = x.get('stop') or {}, x.get('targets') or {}, x.get('exit') or {}
        L.append(f'- Own stop: {st.get("how") if st.get("has") else "none"}{" (readable: " + str(st.get("readable")) + ")" if st.get("has") else ""}. Targets: {tg.get("how") if tg.get("has") else "none"}. Exit: {ex.get("how") if ex.get("has") else "none"}.')
        if x.get('note'): L.append(f'- Note: {x["note"]}')
        L.append('')

L += ['## Confirmed side errors on scripts that trade', '']
conf = [(x, m) for x, m in mis if m['check'] == 'confirmed' and m.get('problem') in ('wrong-side', 'exit-misread')]
table(['Scanner', 'Pairs', 'Marker', 'Line', 'Problem', 'Evidence'], [(m.get('id'), pairs_of.get(m.get('id'), 0), (m.get('marker') or '')[:48], m.get('line'), m.get('problem'), (m.get('evidence') or '')[:150].replace('|', '/')) for x, m in sorted(conf, key=lambda t: -pairs_of.get(t[1].get('id'), 0))])

L += ['## Scripts that trade and can run as their author designed them', '']
rad = [x for x in trade_rows if x.get('verdict') == 'run-as-designed']
table(['Scanner', 'Pairs', 'Style', 'Own stop', 'Idea'], [(', '.join(i for i in x['ids'] if trading(i)), max(pairs_of.get(i, 0) for i in x['ids']), x.get('style'), (x.get('stop') or {}).get('readable') if (x.get('stop') or {}).get('has') else 'none', (x.get('idea') or '')[:110].replace('|', '/')) for x in sorted(rad, key=lambda x: -max(pairs_of.get(i, 0) for i in x['ids']))])

L += ['## The static audit against the model readers', '', 'Each reader confirmed or rejected the rule-based audit\'s findings for its scripts.', '']
ag, dg = C(), C()
for x in rows:
    for a in (x.get('staticAudit') or {}).get('agrees') or []: ag[a] += 1
    for d in (x.get('staticAudit') or {}).get('disagrees') or []: dg[d.get('code') if isinstance(d, dict) else d] += 1
codes = ['side-against-drawing', 'side-dropped', 'not-an-entry', 'own-stop-discarded', 'levels-plotted-unread', 'levels-not-exported', 'alerts-off-by-default', 'late-pivot', 'lookahead', 'no-entry-read']
table(['Audit finding', 'Confirmed', 'Rejected', 'Confirmed share'], [(c, ag[c], dg[c], f'{ag[c] / (ag[c] + dg[c]) * 100:.0f}%' if ag[c] + dg[c] else '-') for c in codes])

L += ['## Files', '', '- `contracts.jsonl`: one contract per script, with each misread marked confirmed, refuted, unchecked or not-trading.',
      '- `proposed-readings.json`: for each trading scanner with a confirmed misread, its current reading, the proposed reading and the evidence.', '']
open(os.path.join(out, 'report.md'), 'w').write('\n'.join(L) + '\n')
print(f'{len(rows)} contracts, {len(missing)} missing, {len(proposed)} proposed readings, {len(conf)} confirmed side errors, {len(rad)} trading scripts runnable as designed')
