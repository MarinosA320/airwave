#!/usr/bin/env python3
"""
Writes the compiled toolbar-panel definition (InGamePanels/*.spb) for the Airwave MSFS panel, without the MSFS SDK.

The SPB layout (header, property GUID table, nested sets and typed values) and the position-dependent text cipher
were worked out with spb2xml (https://github.com/leppie/spb2xml). Its cipher table is not copied into Airwave:
pass the path of spb2xml's TextDecode.Data.cs when regenerating. The generated .spb is committed, so normal builds
never need this script.

  python3 tools/msfs/make-spb.py <spb2xml>/TextDecode.Data.cs out.spb            write the Airwave panel
  python3 tools/msfs/make-spb.py <spb2xml>/TextDecode.Data.cs out.spb --check X  also decode X and compare layout
"""
import re, struct, sys, uuid

# InGamePanels property GUIDs, in the order fspackagetool writes them (from fs-base-propdefs), with their size flag.
TAGS = [
    ('ee6fd77b-14bb-497c-ae59-0ccdd90eaa68', -1),  # 0  SimBase.Document (set)
    ('bdac895e-5ed0-480d-8d09-c4085785c2ff', -1),  # 1  Type (text)
    ('e0829420-4fa2-4cb5-82b2-f18b6d0f9256', 8),   # 2  version (long2)
    ('e714feba-bdca-4d18-865f-ee991266d625', -1),  # 3  Filename (text)
    ('50f3ce29-abad-4fa5-83a2-e6f24df78991', -1),  # 4  InGamePanels.InGamePanelDefinition (set)
    ('d3a57fc5-deff-4ec9-b84f-dc9b29018ab4', -1),  # 5  id
    ('5afa22a2-be9a-4bde-886d-a1a072879fda', -1),  # 6  Name
    ('68b57d5f-f513-4bd1-b321-615d0acf8d47', -1),  # 7  url
    ('57ce7f54-bbe6-446f-bff8-65ce02b53009', 4),   # 8  resizeDirections (enum: 3 = Both)
    ('ba3ab7bc-8fe2-4d6b-9729-31831d4252df', 4),   # 9  minWidth
    ('f0ce4d3e-8236-48b2-a5b7-559bec77810a', 4),   # 10 minHeight
    ('3242b0d8-a65b-46b1-9fcf-9f4bdf367da6', 4),   # 11 defaultWidth
    ('2fa37e31-3d66-44ee-a95e-fcacc9aa93e5', 4),   # 12 defaultHeight
    ('e6e4e1e5-1b55-4883-b1ff-14895c73c2ee', 4),   # 13 defaultTop
    ('44837f1f-018e-4be0-b416-7aa70d2cfb4b', 4),   # 14 defaultRight
    ('fbc73bd9-91c7-45e8-9444-3bc75da6651d', -1),  # 15 icon
    ('9d9e20fe-ee40-4481-b975-076f58e8e14c', 4),   # 16 buttonVisible
]

def load_cipher(path):
    S = {}
    for m in re.finditer(r'S\[0x([0-9A-Fa-f]+)\]\s*=\s*new byte\[\]\s*\{([^}]*)\}', open(path, encoding='utf-8-sig').read()):
        S[int(m.group(1), 16)] = [int(x, 16) for x in m.group(2).split(',') if x.strip()]
    if 0 not in S or len(S) < 90: sys.exit('That does not look like spb2xml TextDecode.Data.cs')
    return S

def build(S, p):
    tag = lambda i: struct.pack('<i', i + 1)
    def text(i, s):
        enc = bytes(S[ord(c)][k % 250] for k, c in enumerate(s)) + bytes([S[0][len(s) % 250]])
        return tag(i) + struct.pack('<i', len(enc)) + enc
    f32 = lambda i, v: tag(i) + struct.pack('<f', v)
    i32 = lambda i, v: tag(i) + struct.pack('<i', v)
    sett = lambda i, body: tag(i) + struct.pack('<i', len(body) + 4) + body + struct.pack('<i', 0)  # sets end with a 0 marker
    panel = (text(5, p['id']) + text(6, p['name']) + text(7, p['url']) + i32(8, 3) +
             f32(9, p['minWidth']) + f32(10, p['minHeight']) + f32(11, p['defaultWidth']) + f32(12, p['defaultHeight']) +
             f32(13, p['defaultTop']) + f32(14, p['defaultRight']) + text(15, p['icon']) + i32(16, 1))
    doc = text(1, 'InGamePanels') + tag(2) + struct.pack('<ii', 1, 0) + text(3, p['filename']) + sett(4, panel)
    body = sett(0, doc)
    head = struct.pack('<H', 0xEBAC) + struct.pack('<12i', 20, 1, 0, 512, 1, 0, len(TAGS) + 1, 0, 0, 0, 0, 0)
    table = b''.join(uuid.UUID(g).bytes_le + struct.pack('<i', flag) for g, flag in TAGS)
    return head + table + body

AIRWAVE = dict(id='PANEL_AIRWAVE_PILOT', name='Airwave', url='html_UI/InGamePanels/AirwavePilot/AirwavePilot.html',
               icon='ICON_TOOLBAR_AIRWAVE', filename='airwave-pilot-panel.spb',
               minWidth=18, minHeight=30, defaultWidth=22, defaultHeight=55, defaultTop=20, defaultRight=3)

if __name__ == '__main__':
    S = load_cipher(sys.argv[1])
    if '--check' in sys.argv:  # rebuild a known SPB from its own values and compare byte for byte
        ref = open(sys.argv[sys.argv.index('--check') + 1], 'rb').read()
        p = dict(id='PANEL_CUSTOM_PANEL', name='CustomPanel', url='html_UI/ingamePanels/CustomPanel/CustomPanel.html', icon='ICON_TOOLBAR_MAXIMUS_CUSTOM_PANEL',
                 filename='maximus-ingamepanels-custom.spb', minWidth=33, minHeight=35, defaultWidth=36, defaultHeight=36, defaultTop=33, defaultRight=2)
        mine = build(S, p)
        print('reference rebuilt identically' if mine == ref else 'MISMATCH: %d vs %d bytes, first difference at %d' % (len(mine), len(ref), next((i for i in range(min(len(mine), len(ref))) if mine[i] != ref[i]), min(len(mine), len(ref)))))
    open(sys.argv[2], 'wb').write(build(S, AIRWAVE))
    print('wrote', sys.argv[2])
