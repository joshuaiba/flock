"""Tools for the entity-resolution agent.

All four are read-only with respect to the knowledge graph: they never touch
organizations, awards, opportunities or edges. The only tables they write are
`http_cache` and the `http_requests` log behind the daily quota (see
pipeline/resolve/http_cache.py), through `deps.cache`. Merges are applied by
apply.py, after the agent has returned.

Failure handling: an upstream that is down, slow, redirecting in circles or
returning something other than the documented shape yields a result with
status "unavailable" (or "bad_query" for a rejected query), never an
exception, so one bad response cannot end the agent run. ModelRetry is kept
for arguments the model can fix.

Docstrings are the tool descriptions the model sees, so they are written for
the model. `TOOLS` is what the agent registers.

APIs (docs read 2026-11-09):
- SAM.gov Entity Management API v4, https://open.gsa.gov/api/entity-api/
  GET /entity-information/v4/entities?ueiSAM=|legalBusinessName=&api_key=
  10 results per page; daily quota depends on the key type (10 or 1,000) and
  no quota error is documented, so requests are counted in http_requests.
- USAspending, POST /api/v2/recipient/ and GET /api/v2/recipient/{id}/
  (api_contracts/contracts/v2/recipient*.md). No key.
"""

from __future__ import annotations

import logging
import re

import httpx
import psycopg
from pydantic import ValidationError
from pydantic_ai import ModelRetry, RunContext, Tool

from pipeline.agents.run_log import redact
from pipeline.resolve import addresses, http_cache
from pipeline.resolve.deps import ResolveDeps
from pipeline.resolve.models import (
    AddressComparison,
    OrgAward,
    OrgAwards,
    SamEntity,
    SamLookup,
    UsaspendingRecipient,
    UsaspendingSearch,
)

log = logging.getLogger(__name__)

SAM_URL = "https://api.sam.gov/entity-information/v4/entities"
SAM_SECTIONS = "entityRegistration,coreData"
SAM_MAX_ENTITIES = 5
USASPENDING_SEARCH_URL = "https://api.usaspending.gov/api/v2/recipient/"
USASPENDING_DETAIL_URL = "https://api.usaspending.gov/api/v2/recipient/{}/"
USASPENDING_PAGE_URL = "https://www.usaspending.gov/recipient/{}/latest"
USASPENDING_SEARCH_LIMIT = 5
USASPENDING_MAX_DETAILS = 3  # so one tool call sends at most 1 + 3 requests
# Tool results are re-sent to the model on every later request, so awards are
# kept small: at most 10 awards x ~300 characters is under 1k tokens per call
# (it was 25 x ~400, about 2.5k), leaving 8 tool calls well inside the 50k
# token budget.
AWARDS_DEFAULT_LIMIT = 5
AWARDS_MAX_LIMIT = 10
DESCRIPTION_CHARS = 120
MAX_NAME_CHARS = 120

_UEI = re.compile(r"^[A-Z0-9]{12}$")


def _clean_name(name: str) -> str:
    """Whitespace-collapsed and upper-cased: both registries match names
    case-insensitively, so "Sikorsky Aircraft" and "SIKORSKY AIRCRAFT" must be
    one cache entry (and one request against the quota), not two."""
    cleaned = " ".join(name.split()).upper()
    if not 3 <= len(cleaned) <= MAX_NAME_CHARS:
        raise ModelRetry(f"name must be 3-{MAX_NAME_CHARS} characters; got {len(cleaned)}")
    return cleaned


def _one_line(*parts: str | None) -> str | None:
    kept = [p.strip() for p in parts if isinstance(p, str) and p.strip()]
    return ", ".join(kept) or None


def _address_line(line1, line2, city, state, zip_code) -> str | None:
    """One-line address for compare_addresses, or None when there is no street
    line: "STRATFORD, CT 06614" is a town, and two records in the same town
    must not compare as the same address."""
    if not (isinstance(line1, str) and line1.strip()):
        return None
    tail = " ".join(p for p in (state, zip_code) if isinstance(p, str) and p)
    return _one_line(line1, line2, city, tail)


def _dict(value) -> dict:
    return value if isinstance(value, dict) else {}


# --- SAM.gov -----------------------------------------------------------------


def _sam_address(addr: dict | None) -> tuple[str | None, str | None]:
    addr = _dict(addr)
    state = addr.get("stateOrProvinceCode")
    line = _address_line(
        addr.get("addressLine1"),
        addr.get("addressLine2"),
        addr.get("city"),
        state,
        addr.get("zipCode"),
    )
    return line, state


def _sam_entity(raw: dict) -> SamEntity:
    reg = _dict(raw.get("entityRegistration"))
    core = _dict(raw.get("coreData"))
    hierarchy = _dict(core.get("entityHierarchyInformation"))
    immediate = _dict(hierarchy.get("immediateParentEntity"))
    ultimate = _dict(hierarchy.get("ultimateParentEntity"))
    address, state = _sam_address(core.get("physicalAddress"))
    return SamEntity(
        uei=reg.get("ueiSAM"),
        legal_name=reg.get("legalBusinessName"),
        dba_name=reg.get("dbaName"),
        cage_code=reg.get("cageCode"),
        registration_status=reg.get("registrationStatus"),
        address=address,
        state=state,
        immediate_parent_uei=immediate.get("ueiSAM"),
        immediate_parent_name=immediate.get("legalBusinessName"),
        ultimate_parent_uei=ultimate.get("ueiSAM"),
        ultimate_parent_name=ultimate.get("legalBusinessName"),
    )


def lookup_sam_entity(
    ctx: RunContext[ResolveDeps], uei: str | None = None, name: str | None = None
) -> SamLookup:
    """Look up a company's official SAM.gov registration (the federal contractor registry).

    Returns legal business name, DBA name, UEI, CAGE code, physical address and the
    immediate and ultimate parent companies. This is the most authoritative source:
    two rows with the same UEI are the same entity; different UEIs with a parent link
    between them are parent and subsidiary, which are separate entities.

    Pass exactly one of `uei` or `name`. Prefer `uei` whenever one is known: it is an
    exact match, while `name` is a partial match that can return several entities.
    Lookups are limited per day. Result status:
    - "ok": `entities` holds the matches.
    - "not_found": nothing is registered under that UEI or name.
    - "bad_query": SAM.gov rejected this particular query (for example characters it
      does not accept in a name). Other lookups still work: try the UEI, or a simpler name.
    - "unavailable": SAM.gov cannot be used right now (no access, quota used up, or
      down). Do not call this tool again in this run; rely on the other tools.

    Args:
        uei: 12-character SAM Unique Entity ID, e.g. "UTJWTSLMFNG4".
        name: Legal business name or the start of one, e.g. "SIKORSKY AIRCRAFT".
    """
    if (uei is None) == (name is None):
        raise ModelRetry("Pass exactly one of `uei` or `name`.")
    if uei is not None:
        uei = uei.strip().upper()
        if not _UEI.match(uei):
            raise ModelRetry("`uei` must be exactly 12 letters/digits.")
        query = {"ueiSAM": uei}
    else:
        query = {"legalBusinessName": _clean_name(name)}

    deps = ctx.deps
    if not deps.sam_api_key:
        return SamLookup(status="unavailable", detail="SAM.gov lookups are not configured.")

    source_url = str(httpx.URL(SAM_URL, params=query))
    try:
        resp = http_cache.cached_request(
            deps.cache,
            deps.http,
            "GET",
            SAM_URL,
            params={**query, "includeSections": SAM_SECTIONS},
            secret_params={"api_key": deps.sam_api_key},
            quota=deps.sam_daily_quota,
        )
    except http_cache.QuotaExhausted:
        return SamLookup(status="unavailable", detail="SAM.gov daily quota exhausted.")
    except (httpx.HTTPError, psycopg.Error) as e:
        log.warning("SAM.gov lookup failed: %s: %s", type(e).__name__, redact(str(e)))
        return SamLookup(status="unavailable", detail="SAM.gov could not be reached.")

    if resp.status == 404:
        return SamLookup(status="not_found", detail="No SAM.gov registration matched.")
    if resp.status == 400:
        # A rejected query says nothing about the service: keep SAM usable.
        return SamLookup(
            status="bad_query",
            detail="SAM.gov rejected this query (HTTP 400). Try the UEI or a simpler name.",
        )
    if resp.status != 200 or not isinstance(resp.body, dict):
        return SamLookup(status="unavailable", detail=f"SAM.gov returned HTTP {resp.status}.")
    raw_entities = resp.body.get("entityData") or []
    if not isinstance(raw_entities, list):
        return SamLookup(status="unavailable", detail="SAM.gov returned an unexpected response.")
    raw_entities = [e for e in raw_entities if isinstance(e, dict)]
    if not raw_entities:
        return SamLookup(status="not_found", detail="No SAM.gov registration matched.")
    try:
        entities = [_sam_entity(e) for e in raw_entities[:SAM_MAX_ENTITIES]]
    except ValidationError as e:  # fields of an unexpected type
        log.warning("SAM.gov response did not match the documented shape: %s", e)
        return SamLookup(status="unavailable", detail="SAM.gov returned an unexpected response.")
    total = resp.body.get("totalRecords")
    return SamLookup(
        status="ok",
        source_url=source_url,
        total_matches=total if isinstance(total, int) and total else len(raw_entities),
        entities=entities,
    )


# --- USAspending -------------------------------------------------------------


def _usaspending_detail(recipient: UsaspendingRecipient, detail: dict) -> None:
    loc = _dict(detail.get("location"))
    state = loc.get("state_code")
    names = detail.get("alternate_names")
    recipient.alternate_names = [n for n in names if isinstance(n, str)][:8] if names else []
    recipient.parent_name = detail.get("parent_name")
    recipient.parent_uei = detail.get("parent_uei")
    others = []
    parents = detail.get("parents")
    for p in parents if isinstance(parents, list) else []:
        if not isinstance(p, dict):
            continue
        label = f"{p.get('parent_name')} ({p.get('parent_uei')})"
        if p.get("parent_uei") != recipient.parent_uei and label not in others:
            others.append(label)
    recipient.other_parents = others[:5]
    recipient.address = _address_line(
        loc.get("address_line1"),
        loc.get("address_line2"),
        loc.get("city_name"),
        state,
        loc.get("zip"),
    )
    recipient.state = state if isinstance(state, str) else None


def search_usaspending_recipient(ctx: RunContext[ResolveDeps], name: str) -> UsaspendingSearch:
    """Search USAspending.gov for federal award recipients by name.

    Returns up to 5 matching recipient records (largest by award dollars first). The
    top 3 include their parent company, alternate names and address. Use it to see
    whether two names are listed as the same recipient, as parent and child, or as
    unrelated companies. `level` is "P" for a parent record, "C" for a child record
    and "R" for a standalone recipient; the same company can appear at several levels.
    `other_parents` lists past or alternate parents, which often reveals acquisitions
    and name changes.

    Args:
        name: Company name or a distinctive part of it, e.g. "SIKORSKY AIRCRAFT".
            A UEI also works.
    """
    keyword = _clean_name(name)
    deps = ctx.deps
    try:
        search = http_cache.cached_request(
            deps.cache,
            deps.http,
            "POST",
            USASPENDING_SEARCH_URL,
            json_body={"keyword": keyword, "limit": USASPENDING_SEARCH_LIMIT, "award_type": "all"},
        )
    except (httpx.HTTPError, psycopg.Error) as e:
        log.warning("USAspending search failed: %s: %s", type(e).__name__, redact(str(e)))
        return UsaspendingSearch(status="unavailable", detail="USAspending could not be reached.")
    if search.status != 200 or not isinstance(search.body, dict):
        return UsaspendingSearch(
            status="unavailable", detail=f"USAspending returned HTTP {search.status}."
        )
    results = search.body.get("results") or []
    if not isinstance(results, list):
        return UsaspendingSearch(
            status="unavailable", detail="USAspending returned an unexpected response."
        )
    # A row without an id cannot be cited or looked up; skip it rather than fail.
    results = [r for r in results if isinstance(r, dict) and isinstance(r.get("id"), str)]
    if not results:
        return UsaspendingSearch(status="not_found", detail="No recipient matched.")

    recipients = []
    for i, r in enumerate(results[:USASPENDING_SEARCH_LIMIT]):
        level = r.get("recipient_level")
        amount = r.get("amount")
        rec = UsaspendingRecipient(
            recipient_id=r["id"],
            name=r.get("name") if isinstance(r.get("name"), str) else "",
            uei=r.get("uei") if isinstance(r.get("uei"), str) else None,
            level=level if level in ("P", "C", "R") else None,
            amount_12mo=amount if isinstance(amount, int | float) else None,
            url=USASPENDING_PAGE_URL.format(r["id"]),
        )
        if i < USASPENDING_MAX_DETAILS:
            try:
                detail = http_cache.cached_request(
                    deps.cache, deps.http, "GET", USASPENDING_DETAIL_URL.format(r["id"])
                )
            except (httpx.HTTPError, psycopg.Error) as e:
                log.warning(
                    "USAspending recipient detail failed: %s: %s", type(e).__name__, redact(str(e))
                )
            else:
                if detail.status == 200 and isinstance(detail.body, dict):
                    try:
                        _usaspending_detail(rec, detail.body)
                    except (TypeError, ValueError, AttributeError) as e:
                        log.warning("USAspending recipient detail malformed: %s", e)
        recipients.append(rec)
    total = _dict(search.body.get("page_metadata")).get("total") or len(results)
    if not isinstance(total, int):
        total = len(results)
    return UsaspendingSearch(status="ok", total_matches=total, recipients=recipients)


# --- our database ------------------------------------------------------------

_AWARDS_SQL = """
WITH RECURSIVE family AS (
    SELECT id FROM organizations WHERE id = %(canonical)s
    UNION
    SELECT o.id FROM organizations o JOIN family f ON o.merged_into = f.id
)
SELECT a.id, a.signed_at, a.amount, ag.canonical_name,
       COALESCE(a.description, a.raw_text), a.source, a.url,
       count(*) OVER (), sum(a.amount) OVER ()
FROM awards a
LEFT JOIN organizations ag ON ag.id = a.agency_id
WHERE a.recipient_id IN (SELECT id FROM family)
   OR EXISTS (
        SELECT 1 FROM edges e
        WHERE e.src_type = 'award' AND e.src_id = a.id AND e.rel = 'awarded_to'
          AND e.dst_type = 'organization' AND e.dst_id IN (SELECT id FROM family))
ORDER BY a.signed_at DESC NULLS LAST, a.id DESC
LIMIT %(limit)s
"""


def get_org_awards(ctx: RunContext[ResolveDeps], org_id: int, limit: int = 5) -> OrgAwards:
    """List contract awards already in our database for one organization.

    Shows what the organization has been awarded (date, amount, awarding agency,
    description). Compare the two candidates' awards: the same agencies, programs and
    products suggest one entity; unrelated lines of business suggest two.
    `total_awards` and `total_amount` cover all of the organization's awards, not
    just the ones listed.

    Args:
        org_id: Our organization id. Use the ids given for the pair under review.
        limit: How many of the most recent awards to return (1-10).
    """
    conn = ctx.deps.conn
    limit = max(1, min(int(limit), AWARDS_MAX_LIMIT))
    canonical = org_id
    row = None
    # Read inside a savepoint: if a query fails, the caller's transaction (and
    # the agent_runs row written after the run) stays usable.
    with conn.transaction():
        for _ in range(10):  # follow merged_into to the canonical row; bounded against cycles
            row = conn.execute(
                "SELECT id, canonical_name, uei, aliases, merged_into FROM organizations"
                " WHERE id = %s",
                (canonical,),
            ).fetchone()
            if row is None or row[4] is None:
                break
            canonical = row[4]
        rows = (
            conn.execute(_AWARDS_SQL, {"canonical": canonical, "limit": limit}).fetchall()
            if row is not None
            else []
        )
    if row is None:
        raise ModelRetry(f"No organization with id {org_id}. Use an id from the pair.")
    awards = [
        OrgAward(
            award_id=r[0],
            signed_at=r[1],
            amount=float(r[2]) if r[2] is not None else None,
            agency=r[3],
            description=(r[4] or "")[:DESCRIPTION_CHARS] or None,
            source=r[5],
            url=r[6],
        )
        for r in rows
    ]
    total_amount = rows[0][8] if rows else None
    return OrgAwards(
        org_id=org_id,
        canonical_org_id=row[0],
        name=row[1],
        uei=row[2],
        aliases=list(row[3])[:10],
        total_awards=rows[0][7] if rows else 0,
        total_amount=float(total_amount) if total_amount is not None else None,
        awards=awards,
    )


# --- addresses ---------------------------------------------------------------


def compare_addresses(a: str, b: str) -> AddressComparison:
    """Compare two US street addresses deterministically.

    Normalizes case, punctuation, street-suffix, directional and suite abbreviations
    and ZIP+4, then reports whether they are the same place. Use this instead of
    judging address strings yourself. Pass the `address` values returned by the other
    tools, complete with street number, city, state and ZIP. The verdict is "same" only
    when the numbered street line matches and the city/state or ZIP confirm the place;
    it is "unclear" whenever either address is incomplete, and "unclear" is not
    evidence either way. A shared address is supporting evidence, not proof:
    subsidiaries and unrelated tenants can share a building.

    Args:
        a: First address on one line, e.g. "6900 Main Street, Stratford, CT 06614".
        b: Second address on one line.
    """
    if not a.strip() or not b.strip():
        raise ModelRetry("Both addresses must be non-empty.")
    return addresses.compare(a, b)


# The DB/HTTP tools share one psycopg connection and one rate-limited HTTP
# client, and Pydantic AI runs sync tools in worker threads, in parallel when
# the model emits several calls at once. sequential=True makes each of them a
# barrier that runs alone. compare_addresses is pure and can overlap.
TOOLS: list[Tool[ResolveDeps]] = [
    Tool(lookup_sam_entity, sequential=True),
    Tool(search_usaspending_recipient, sequential=True),
    Tool(get_org_awards, sequential=True),
    Tool(compare_addresses),
]
