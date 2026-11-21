import json
from pathlib import Path

p = Path('decantx/notes-additional-research.json')
a = json.loads(p.read_text(encoding='utf-8'))

def add(i, url, top=(), middle=(), base=(), key=(), replace=False):
    d = {'index': i, 'url': url, 'notes': {'top': list(top), 'middle': list(middle), 'base': list(base), 'key': list(key)}}
    if replace:
        d['replace_all'] = True
    a[:] = [x for x in a if x['index'] != i]
    a.append(d)

add(879, 'https://scentadvice.com/ambre-nuit-new-look-edition-2022-dior%F0%9F%94%BA/', ('Bergamot','Grapefruit'), ('Damask Rose','Pink Pepper'), ('Guaiac Wood','Ambergris','Cedar','Patchouli'))
add(1362, 'https://www.fragrantica.com/perfume/Etat-Libre-d-Orange/Divin-Enfant-4514.html', key=('Marshmallow','African Orange Flower','Tobacco','Leather','Musk','Coffee','Tonka Bean','Amber','Rose'), replace=True)
add(1924, 'https://us.initioparfums.com/products/high-frequency', key=('Magnolia','Jasmine','Vanilla','Almond','Sandalwood','Heliotrope','Hedione'), replace=True)
add(2206, 'https://www.lelabofragrances.com/bergamote-22-131.html', key=('Bergamot','Petitgrain','Grapefruit','Amber','Musk','Vetiver'), replace=True)
add(2312, 'https://scenters.com/unisex/maison-francis-kurkdjian/aqua-vitae-edt', ('Calabrian Lemon','Sicilian Mandarin','Hedione'), ('Jasmine','Vanilla','Tonka Bean'), ('Guaiac Wood','Tonka Bean','Vanilla'), replace=True)
add(2317, 'https://www.fragrantica.com/parfum/Maison-Francis-Kurkdjian/Gentle-Fluidity-Gold-53401.html', ('Juniper Berries','Nutmeg'), ('Coriander',), ('Vanilla','Musk','Caramel','Amberwood'), replace=True)
add(2318, 'https://www.fragrantica.com/perfume/Maison-Francis-Kurkdjian/Gentle-Fluidity-Silver-53400.html', ('Juniper Berries','Nutmeg','Bergamot','Pineapple'), ('Coriander',), ('Musk','Woody Notes','Cedar','Amber','Vanilla'), replace=True)
add(2335, 'https://thescentbase.com/dk/perfumes/maison-martin-margiela/untitled-l-eau', ('Amalfi Lemon','Citruses','Mandarin Orange'), ('African Orange Flower','Green Notes','Mint'), key=('Amalfi Lemon','Citruses','Mandarin Orange','African Orange Flower','Green Notes','Mint'))
add(3688, 'https://www.fragrantica.com/perfume/Valentino/Born-in-Roma-Extradose-Uomo-101383.html', base=('Woody Notes',))
add(4053, 'https://www.zarkoperfume.com/commodity/14-zarkoperfume-cloud-collection-no1', ('Danish Sea-Buckthorn',), ('French Jasmin Absolute',), ('Driftwood Accord',), replace=True)
p.write_text(json.dumps(a, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
