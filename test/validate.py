# -*- coding: utf-8 -*-
"""EPUB 结构校验（模拟 EPUBCheck 核心项）"""
import zipfile, sys, re
import xml.etree.ElementTree as ET

p = sys.argv[1] if len(sys.argv) > 1 else 'out.epub'
z = zipfile.ZipFile(p)
names = z.namelist()
errors, warns = [], []

# 1. mimetype 必须是第一个条目且 STORED
first = z.infolist()[0]
if first.filename != 'mimetype':
    errors.append(f'mimetype 不是首个条目: {first.filename}')
elif first.compress_type != zipfile.ZIP_STORED:
    errors.append('mimetype 被压缩了（必须 STORED）')
elif z.read('mimetype') != b'application/epub+zip':
    errors.append('mimetype 内容错误')

# 2. container.xml
if 'META-INF/container.xml' not in names:
    errors.append('缺 META-INF/container.xml')
else:
    root = ET.fromstring(z.read('META-INF/container.xml'))
    rf = root.find('.//{urn:oasis:names:tc:opendocument:xmlns:container}rootfile')
    opf_path = rf.get('full-path') if rf is not None else None
    if not opf_path or opf_path not in names:
        errors.append(f'rootfile 指向不存在: {opf_path}')

# 3. OPF
opf = ET.fromstring(z.read(opf_path))
NS = {'opf': 'http://www.idpf.org/2007/opf', 'dc': 'http://purl.org/dc/elements/1.1/'}
pkg = opf
if pkg.get('version') != '3.0':
    warns.append(f'opf version={pkg.get("version")}')

title = pkg.find('.//dc:title', NS)
ident = pkg.find('.//dc:identifier', NS)
mod = [m for m in pkg.findall('.//opf:meta', NS) if m.get('property') == 'dcterms:modified']
if title is None: errors.append('缺 dc:title')
if ident is None: errors.append('缺 dc:identifier')
if not mod: errors.append('EPUB3 缺 dcterms:modified（必需）')

manifest = {}
for it in pkg.findall('.//opf:manifest/opf:item', NS):
    manifest[it.get('id')] = it
    href = it.get('href')
    full = opf_path.rsplit('/', 1)[0] + '/' + href
    if full not in names:
        errors.append(f'manifest 指向缺失文件: {href}')

# 4. spine
spine = pkg.findall('.//opf:spine/opf:itemref', NS)
if not spine:
    errors.append('spine 为空')
for ir in spine:
    if ir.get('idref') not in manifest:
        errors.append(f'spine 引用未定义 id: {ir.get("idref")}')

# 5. nav 文档
navs = [i for i in manifest.values() if 'nav' in (i.get('properties') or '')]
if not navs:
    errors.append('EPUB3 缺 nav 文档')

# 6. 所有 XHTML 必须是 well-formed XML
xhtml_count = 0
for n in names:
    if n.endswith('.xhtml') or n.endswith('.ncx') or n.endswith('.opf'):
        try:
            ET.fromstring(z.read(n))
            if n.endswith('.xhtml'): xhtml_count += 1
        except Exception as e:
            errors.append(f'XML 非法 {n}: {e}')

# 7. 抽查正文
sample = [n for n in names if re.match(r'OEBPS/text/chapter\d+\.xhtml', n)]
if sample:
    body = z.read(sample[len(sample)//2]).decode('utf-8')
    paras = body.count('<p')
    if paras == 0:
        errors.append(f'样章 {sample[len(sample)//2]} 无段落')

print(f'条目 {len(names)} | XHTML {xhtml_count} | spine {len(spine)} | 大小 {z.fp.seek(0,2)/1048576:.2f} MB')
print(f'标题: {title.text if title is not None else "?"} | ID: {ident.text[:40] if ident is not None else "?"}')
print()
if errors:
    print('❌ 错误:')
    for e in errors[:20]: print('  -', e)
else:
    print('✅ 结构校验通过，无阻断性错误')
if warns:
    print('⚠️  提示:')
    for w in warns[:10]: print('  -', w)
