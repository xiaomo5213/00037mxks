# -*- coding: utf-8 -*-
"""
把 Anki 牌组（.apkg / collection.anki2）转换成网页闪卡数据。

用法：
    python scripts/build_cards.py "路径/xxx.apkg"
    python scripts/build_cards.py "路径/xxx.apkg" --out data

做的事情：
  1. 解出 collection.anki21 / collection.anki2（SQLite），逐条读 notes。
  2. 去掉模板里塞进来的推广标注（“更多牌组资料在公众号【在爬坡的路上】”之类）。
  3. 把 {{c1::答案}} 换成空位占位符，答案单独存数组，前端点击显形。
  4. 清洗 HTML：丢掉颜色/字号等内联样式，只保留加粗、下划线、分隔行等结构。
  5. 从每张卡开头的 h2 / “第X节” 里抽出「章 / 节」，作为面包屑和目录分组。
  6. 输出 data/cards.js（window.MEIXUE_DATA）和 data/cards.json。
"""
from __future__ import annotations

import argparse
import html as html_mod
import io
import json
import os
import re
import sqlite3
import sys
import tempfile
import zipfile

from lxml import html as lxml_html

# ---------------------------------------------------------------- 清洗规则

# 推广标注：这些片段会从任何字段里删掉
PROMO_PATTERNS = [
    r"更多牌组资料在公众号\s*【\s*在爬坡的路上\s*】",
    r"更多牌组资料[，,]?\s*请?关注公众号\s*【?\s*在爬坡的路上\s*】?",
    r"公众号\s*【\s*在爬坡的路上\s*】",
    r"微信公众号\s*[:：]?\s*在爬坡的路上",
    r"在爬坡的路上",
]

DROP_TAGS = {"script", "style", "iframe", "object", "embed", "link", "meta", "noscript"}
ALLOWED_TAGS = {
    "div", "p", "br", "b", "strong", "i", "em", "u", "s", "del", "span",
    "sub", "sup", "small", "h2", "h3", "h4", "ul", "ol", "li", "blockquote",
}

CLOZE_RE = re.compile(r"\{\{(c\d+)::(.*?)\}\}", re.S)
BLANK_TPL = '<span class="blk {size}" data-a="{idx}"></span>'

# 红笔强调：把原卡的红色标注收敛成一个柔和的强调色
COLOR_RGB_RE = re.compile(r"rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})", re.I)
COLOR_HEX_RE = re.compile(r"#([0-9a-f]{6}|[0-9a-f]{3})\b", re.I)


def is_red(style: str) -> bool:
    """原卡用红色标考点；把偏红的颜色识别出来。"""
    if not style:
        return False
    for m in COLOR_RGB_RE.finditer(style):
        r, g, b = (int(x) for x in m.groups())
        if r >= 140 and r - max(g, b) >= 55 and g < 140 and b < 140:
            return True
    for m in COLOR_HEX_RE.finditer(style):
        h = m.group(1)
        if len(h) == 3:
            h = "".join(ch * 2 for ch in h)
        r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
        if r >= 140 and r - max(g, b) >= 55 and g < 140 and b < 140:
            return True
    return False


def strip_promo(text: str) -> tuple[str, int]:
    """删掉推广文案，返回 (新文本, 删除次数)。"""
    n = 0
    for pat in PROMO_PATTERNS:
        text, k = re.subn(pat, "", text)
        n += k
    return text, n


def plain_text(fragment: str) -> str:
    """HTML 片段 -> 纯文本。"""
    if not fragment:
        return ""
    txt = re.sub(r"<[^>]+>", "", fragment)
    txt = html_mod.unescape(txt).replace("\xa0", " ")
    return re.sub(r"[ \t\r\n]+", " ", txt).strip()


def answer_size(text: str) -> str:
    """按答案长度给空位挑一个宽度档位（不精确暴露字数）。"""
    n = len(re.sub(r"\s+", "", text))
    if n <= 3:
        return "s"
    if n <= 7:
        return "m"
    if n <= 12:
        return "l"
    return "xl"


def sanitize(fragment: str, keep_blanks: bool = False) -> str:
    """
    把 Anki 里的富文本洗成干净、可控的 HTML：
      - 去掉 script/style/颜色/字号/对齐等一切内联样式
      - 红色字（原卡用红笔标考点）转成 <span class="hl">
      - 保留 b/i/u/br/div/p 之类结构
    """
    fragment = re.sub(r"<script\b.*?</script>", "", fragment, flags=re.S | re.I)
    fragment = re.sub(r"<style\b.*?</style>", "", fragment, flags=re.S | re.I)
    if not fragment.strip():
        return ""

    # 用 div 包一层，避免多根节点丢失
    doc = lxml_html.document_fromstring("<div id='__root'>" + fragment + "</div>")
    root = doc.get_element_by_id("__root")

    for el in list(root.iterdescendants()):
        tag = (el.tag or "").lower() if isinstance(el.tag, str) else ""
        if tag in DROP_TAGS:
            el.drop_tree()
            continue
        if tag == "span":
            cls = el.get("class") or ""
            style = el.get("style") or ""
            if keep_blanks and cls.startswith("blk"):
                idx = el.get("data-a", "")
                size = cls.split()[1] if len(cls.split()) > 1 else "m"
                el.attrib.clear()
                el.set("class", f"blk {size}")
                el.set("data-a", idx)
                continue
            if is_red(style):
                el.tag = "span"
                el.attrib.clear()
                el.set("class", "hl")
            else:
                # 多数 span 只是分色，直接脱壳
                if el.get("class") == "hl":
                    el.attrib.clear()
                    el.set("class", "hl")
                else:
                    el.drop_tag()
            continue
        if tag == "font":
            color = (el.get("color") or "") + " " + (el.get("style") or "")
            if is_red(color):
                el.tag = "span"
                el.attrib.clear()
                el.set("class", "hl")
            else:
                el.drop_tag()
            continue

        if tag not in ALLOWED_TAGS:
            el.drop_tag()
            continue

        # 其余标签一律清空属性
        el.attrib.clear()

    # 去掉纯空白行：<div><br></div>、空的 <div></div>、只有空白与 br 的 div
    for el in reversed(list(root.iterdescendants())):
        if not isinstance(el.tag, str):
            continue
        if el.tag in ("div", "p"):
            has_blank = bool(el.xpath('.//span[contains(@class,"blk")]'))
            if has_blank:
                continue
            if not _own_text(el):
                el.drop_tree()

    # 收尾：压缩 &nbsp;、去掉行尾多余空格
    out = "".join(
        lxml_html.tostring(c, encoding="unicode", method="html") if isinstance(c.tag, str) else (c or "")
        for c in root
    )
    out = out.replace("\xa0", " ").replace("\u200b", "")
    out = re.sub(r"[ \t]{2,}", " ", out)
    out = re.sub(r"\s*<br\s*/?>\s*(?=<br)", "", out, flags=re.I)
    return out.strip()


CH_RE = re.compile(r"^(第[一二三四五六七八九十百零]+章)\s*(.*)$")
SEC_LABEL_RE = re.compile(r"^(第[一二三四五六七八九十百零]+节)\s*(.*)$")
# 节标题后面紧跟的下一级编号 / 考点标注，都是标题的结束处
TITLE_CUT_RE = re.compile(
    r"(?:[一二三四五六七八九十百]\s*[、．.]"
    r"|[（(]\s*[一二三四五六七八九十]+\s*[)）]"
    r"|\d+\s*[、．.)]"
    r"|[（(]\s*\d+\s*[)）]"
    r"|第[一二三四五六七八九十百]+[章节]"
    r"|【|。|；|;|，|,|：|:)"
)


def _norm(s: str) -> str:
    return re.sub(r"[\s　]+", "", s)


def _own_text(el) -> str:
    return plain_text(lxml_html.tostring(el, encoding="unicode", method="html", with_tail=False))


def extract_heading(root):
    """
    从正文里认出「章」「节」两个标题，返回 (chapter, section, 需要从正文里删掉的节点)。

    有的卡是扁平结构（<div><b>第一节</b> <b>标题</b></div>），
    有的嵌得很深（<div><div><b>第一节</b> <b>标题</b></div><div>一、…</div></div>），
    所以只认「文字刚好是 第X节」的那个元素，往上找一层拿到节标题，
    再把只装标题的那一层从正文里摘掉。
    """
    remove = []
    chapter = section = ""

    for el in root.iter():
        if not isinstance(el.tag, str) or el.tag not in ("h2", "h3"):
            continue
        text = _own_text(el)
        m = CH_RE.match(text)
        if m and len(text) < 40:
            chapter = (m.group(1) + " " + m.group(2)).strip()
            remove.append(el)
        break

    label_el = None
    label = ""
    inline_title = ""
    for el in root.iter():
        if not isinstance(el.tag, str):
            continue
        own = (el.text or "").strip()
        m = SEC_LABEL_RE.match(own)
        if m and len(own) <= 40:
            label_el = el
            label, inline_title = m.group(1), m.group(2).strip()
            break

    if label_el is not None:
        block = label_el
        for _ in range(3):
            parent = block.getparent()
            if parent is None or parent is root or not isinstance(parent.tag, str):
                break
            if parent.tag not in ("div", "p", "li", "span", "b", "strong"):
                break
            if _own_text(parent).startswith(label) and len(_own_text(parent)) <= 60:
                block = parent
            else:
                break

        rest = inline_title if inline_title else _own_text(block)[len(label):].strip(" 　")
        cut = TITLE_CUT_RE.search(rest)
        if cut:
            rest = rest[: cut.start()]
        title = rest.strip(" 　、，,。")
        section = (label + " " + title).strip()

        # 找只装「第X节 标题」的那一层，从正文里删掉，避免和面包屑重复
        target = _norm(section)
        best = None
        for el in root.iter():
            if not isinstance(el.tag, str) or el is root:
                continue
            if _norm(_own_text(el)) == target:
                if best is None or len(_own_text(el)) <= len(_own_text(best)):
                    best = el
        if best is not None:
            remove.append(best)

    return chapter, section, remove


def cloze_to_blanks(raw: str) -> tuple[str, list[dict]]:
    """把 {{c1::xxx}} 换成占位 span，返回 (替换后的 HTML, 答案列表)。"""
    answers: list[dict] = []

    def repl(m):
        idx = len(answers)
        inner = m.group(2)
        txt = plain_text(inner)
        answers.append({
            "h": sanitize(inner) or html_mod.escape(txt),
            "t": txt,
        })
        return BLANK_TPL.format(size=answer_size(txt), idx=idx)

    return CLOZE_RE.sub(repl, raw), answers


# ---------------------------------------------------------------- 读取 apkg

def open_collection(apkg_path: str, workdir: str) -> str:
    """解出 SQLite 库，返回文件路径。"""
    if zipfile.is_zipfile(apkg_path):
        with zipfile.ZipFile(apkg_path) as z:
            names = set(z.namelist())
            target = "collection.anki21" if "collection.anki21" in names else "collection.anki2"
            if target not in names:
                raise SystemExit("这个 apkg 里没有 collection.anki21 / collection.anki2")
            out = os.path.join(workdir, target)
            with z.open(target) as src, open(out, "wb") as dst:
                dst.write(src.read())
            with open(out, "rb") as f:
                if f.read(4) == b"\x28\xb5\x2f\xfd":
                    raise SystemExit("该库是 zstd 压缩格式，请先用 Anki 导出「支持旧版 Anki 的 .apkg」再试。")
            return out
    return apkg_path


def read_notes(db_path: str):
    con = sqlite3.connect(db_path)
    con.text_factory = bytes
    cur = con.cursor()
    row = cur.execute("SELECT models, decks FROM col LIMIT 1").fetchone()
    models = json.loads(row[0].decode("utf-8"))
    decks = json.loads(row[1].decode("utf-8"))
    notes = cur.execute("SELECT id, mid, flds, tags FROM notes ORDER BY id").fetchall()
    con.close()
    return models, decks, notes


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("apkg", help="Anki 牌组文件（.apkg）或 collection.anki2")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data"))
    args = ap.parse_args()

    with tempfile.TemporaryDirectory() as tmp:
        db_path = open_collection(args.apkg, tmp)
        models, decks, notes = read_notes(db_path)

    # 牌组名 / 模板里的副标题，用来做页面标题
    deck_name = ""
    for d in decks.values():
        if d.get("name") and d["name"] != "Default":
            deck_name = d["name"]
            break
    deck_name, _ = strip_promo(deck_name)

    cards = []
    answer_total = 0
    promo_hits = 0
    chapters: list[str] = []
    sections: dict[str, int] = {}

    for note_id, mid, flds, tags in notes:
        text = flds.decode("utf-8")
        fields = text.split("\x1f")
        content = fields[0] if fields else ""
        content, hits = strip_promo(content)
        promo_hits += hits
        if not content.strip():
            continue

        with_blanks, answers = cloze_to_blanks(content)
        clean = sanitize(with_blanks, keep_blanks=True)
        if not clean:
            continue

        # 抽章节，并把重复的标题从正文里摘掉
        doc = lxml_html.document_fromstring("<div id='__root'>" + clean + "</div>")
        root = doc.get_element_by_id("__root")
        chapter, section, drop_nodes = extract_heading(root)
        for el in drop_nodes:
            if el.getparent() is not None:
                el.drop_tree()
        # 扔掉摘掉标题后剩下的空壳
        for el in reversed(list(root.iterdescendants())):
            if isinstance(el.tag, str) and el.tag in ("div", "p"):
                if el.xpath('.//span[contains(@class,"blk")]'):
                    continue
                if not _own_text(el):
                    el.drop_tree()
        body = "".join(
            lxml_html.tostring(c, encoding="unicode", method="html") if isinstance(c.tag, str) else (c or "")
            for c in root
        ).strip()
        if not body:
            body = clean

        if chapter and chapter not in chapters:
            chapters.append(chapter)
        ch_index = chapters.index(chapter) if chapter else -1
        if section:
            sections[section] = sections.get(section, 0) + 1

        plain = plain_text(body)
        cards.append({
            "id": int(note_id),
            "c": ch_index,
            "ch": chapter,
            "sec": section,
            "body": body,
            "a": [x["h"] for x in answers],
            "t": plain,
            "p": plain[:64],
            "n": len(answers),
        })
        answer_total += len(answers)

    payload = {
        "meta": {
            "title": "00037 美学 · 全书笔记闪卡",
            "deck": deck_name,
            "count": len(cards),
            "blanks": answer_total,
            "chapters": chapters,
            "builtFrom": os.path.basename(args.apkg),
        },
        "cards": cards,
    }

    os.makedirs(args.out, exist_ok=True)
    js_path = os.path.join(args.out, "cards.js")
    with io.open(js_path, "w", encoding="utf-8", newline="\n") as f:
        f.write("/* 由 scripts/build_cards.py 生成，请勿手改 */\n")
        f.write("window.MEIXUE_DATA = ")
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")
    json_path = os.path.join(args.out, "cards.json")
    with io.open(json_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
        f.write("\n")

    print(f"卡片 {len(cards)} 张，空位 {answer_total} 个，章节 {len(chapters)} 个")
    print(f"删除推广标注 {promo_hits} 处")
    print(f"输出 {js_path}")
    print(f"输出 {json_path}")
    for c in chapters:
        print("  ", c, sum(1 for x in cards if x["ch"] == c))


if __name__ == "__main__":
    main()
