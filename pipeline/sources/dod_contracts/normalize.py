"""Announcement HTML -> paragraphs -> AwardRecords.

Page structure (div.body):
    <p style="text-align: center;"><strong>AIR FORCE</strong></p>   section header
    <p>Company, City, State, was awarded $X ... (FA1234-25-C-0001) ...  one award
    <p>*Small business</p>                                            footnote
<p> tags are often left unclosed, so the parser treats each new <p> as the end
of the previous one.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from html import unescape
from html.parser import HTMLParser

from pipeline.extract.contract_announcement import ContractAnnouncement
from pipeline.models import AwardRecord, OrgRef

SOURCE = "dod_contracts"
DOD = OrgRef(
    source=SOURCE,
    source_id="agency:DEPARTMENT OF DEFENSE",
    canonical_name="Department of Defense",
    kind="agency",
    aliases=["Department of War"],
)


@dataclass
class Paragraph:
    index: int  # position among award paragraphs on the page (headers/footnotes excluded)
    section: str | None  # e.g. "AIR FORCE"
    text: str


class _BodyParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.depth = 0  # div nesting inside div.body; 0 = outside
        self.done = False
        self.blocks: list[str] = []
        self._cur: list[str] | None = None

    def _flush(self):
        if self._cur is not None:
            text = re.sub(r"\s+", " ", "".join(self._cur)).strip()
            if text:
                self.blocks.append(text)
        self._cur = None

    def handle_starttag(self, tag, attrs):
        if self.done:
            return
        if self.depth == 0:
            classes = (dict(attrs).get("class") or "").split()
            if tag == "div" and "body" in classes:
                self.depth = 1
            return
        if tag == "div":
            self.depth += 1
        elif tag == "p":
            self._flush()
            self._cur = []
        elif tag == "br" and self._cur is not None:
            self._cur.append(" ")

    def handle_endtag(self, tag):
        if self.depth == 0:
            return
        if tag == "p":
            self._flush()
        elif tag == "div":
            self.depth -= 1
            if self.depth == 0:
                self._flush()
                self.done = True

    def handle_data(self, data):
        if self.depth == 0:
            return
        if self._cur is None and data.strip():
            self._cur = []  # stray text outside a <p>
        if self._cur is not None:
            self._cur.append(data)


def _is_header(text: str) -> bool:
    return len(text) < 100 and text == text.upper() and "$" not in text and not text.startswith("*")


def split_paragraphs(html: str) -> list[Paragraph]:
    parser = _BodyParser()
    parser.feed(html)
    parser.close()
    out: list[Paragraph] = []
    section = None
    for block in parser.blocks:
        if _is_header(block):
            section = block
        elif block.startswith("*") and len(block) < 40:  # "*Small business"
            continue
        else:
            out.append(Paragraph(index=len(out), section=section, text=block))
    return out


def page_meta(html: str) -> dict:
    """Pull og:url / og:title, used to identify browser-saved pages from the drop folder."""
    meta = {}
    for prop in ("url", "title"):
        m = re.search(rf"""<meta\s+property=['"]og:{prop}['"]\s+content=['"]([^'"]+)['"]""", html)
        if m:
            meta[prop] = unescape(m.group(1))
    return meta


def _office(name: str | None, section: OrgRef | None) -> OrgRef | None:
    if not name:
        return None
    return OrgRef(
        source=SOURCE,
        source_id=f"office:{name}",
        canonical_name=name,
        kind="office",
        parent=section,
    )


def to_award(
    *,
    article_id: str,
    url: str,
    announced_on: date | None,
    fetched_at: datetime,
    paragraph: Paragraph,
    extraction: ContractAnnouncement,
    model: str,
) -> AwardRecord:
    section = (
        OrgRef(
            source=SOURCE,
            source_id=f"agency:{paragraph.section}",
            canonical_name=paragraph.section.title(),
            kind="agency",
            parent=DOD,
        )
        if paragraph.section
        else DOD
    )
    awardees = [
        OrgRef(
            source=SOURCE,
            source_id=f"company:{a.contractor}",
            canonical_name=a.contractor,
            kind="company",
        )
        for a in extraction.awardees
    ]
    return AwardRecord(
        source=SOURCE,
        source_id=f"{article_id}:{paragraph.index}",
        fetched_at=fetched_at,
        recipient=awardees[0] if len(awardees) == 1 else None,
        awardees=awardees,
        agency=_office(extraction.awarding_office, section) or section,
        amount=Decimal(str(extraction.amount_usd)) if extraction.amount_usd is not None else None,
        signed_at=announced_on,
        description=extraction.description,
        url=url,
        raw_text=paragraph.text,
        extraction=extraction.model_dump(mode="json"),
        extraction_model=model,
    )
