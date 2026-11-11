"""Synthetic development data, so the UI can be built without API calls or tokens.

Every row is written with source = 'seed' (the API reports `sample: true` while
any exist, and the site labels itself as sample data). Companies are invented;
agencies are real DoD components so the graph has a believable shape. Amounts,
dates and descriptions are random and mean nothing.

Goes through the real loader, so rows have the same shape the pipeline writes.
"""

from __future__ import annotations

import random
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import psycopg

from pipeline.api.queries import taxonomy
from pipeline.load.postgres import LoadStats, upsert_award, upsert_org
from pipeline.models import AwardRecord, OrgRef

SOURCE = "seed"

DOD = OrgRef(
    source=SOURCE, source_id="agency:097", canonical_name="Department of Defense", kind="agency"
)


def _agency(name: str, kind: str = "agency", parent: OrgRef = DOD) -> OrgRef:
    return OrgRef(
        source=SOURCE, source_id=f"agency:{name}", canonical_name=name, kind=kind, parent=parent
    )


AIR_FORCE = _agency("Department of the Air Force")
NAVY = _agency("Department of the Navy")
ARMY = _agency("Department of the Army")
AGENCIES: list[tuple[OrgRef, list[str]]] = [
    (AIR_FORCE, ["collaborative-combat-aircraft", "uas", "autonomy-software"]),
    (_agency("Air Force Research Laboratory", "office", AIR_FORCE), ["swarming", "gps-denied-nav"]),
    (_agency("AFWERX", "office", AIR_FORCE), ["uas", "autonomy-software", "uxs-c2"]),
    (NAVY, ["maritime", "uas"]),
    (_agency("Office of Naval Research", "office", NAVY), ["maritime", "swarming"]),
    (_agency("Naval Sea Systems Command", "office", NAVY), ["maritime"]),
    (ARMY, ["ground-robotics", "counter-uas", "loitering-munitions"]),
    (_agency("Army Contracting Command", "office", ARMY), ["counter-uas", "ground-robotics"]),
    (
        _agency("Defense Advanced Research Projects Agency"),
        ["autonomy-software", "swarming", "gps-denied-nav"],
    ),
    (_agency("Defense Innovation Unit"), ["uas", "counter-uas", "uxs-c2"]),
    (_agency("U.S. Special Operations Command"), ["loitering-munitions", "uas", "gps-denied-nav"]),
]

NAME_A = [
    "Kestrel",
    "Marrow",
    "Tidewater",
    "Halcyon",
    "Bramble",
    "Osprey",
    "Larkspur",
    "Cinder",
    "Fathom",
    "Juniper",
    "Sablewing",
    "Thornfield",
    "Quillon",
    "Merrow",
    "Alderney",
    "Corvid",
    "Saltmarsh",
    "Windrow",
    "Petrel",
    "Hollowell",
    "Ember",
    "Skerry",
    "Plover",
    "Gantry",
    "Lodestar",
    "Wrenfield",
    "Ironbark",
    "Meridian",
    "Driftwood",
    "Starling",
    "Coldwater",
    "Vesper",
    "Tarn",
    "Harrier",
    "Nightjar",
    "Redshank",
    "Sedge",
    "Bittern",
    "Longspur",
    "Whimbrel",
    "Dunlin",
    "Godwit",
    "Fieldfare",
    "Pipit",
]
NAME_B = {
    "uas": ["Aero", "Flight Systems", "Aviation", "UAS"],
    "counter-uas": ["Defense", "Sentry Systems", "Shield"],
    "swarming": ["Collective", "Swarm Labs", "Dynamics"],
    "gps-denied-nav": ["Navigation", "Inertial", "PNT"],
    "maritime": ["Marine", "Maritime Robotics", "Subsea"],
    "ground-robotics": ["Robotics", "Ground Systems", "Mobility"],
    "autonomy-software": ["Autonomy", "AI", "Labs"],
    "collaborative-combat-aircraft": ["Aerospace", "Air Systems"],
    "loitering-munitions": ["Munitions", "Effects"],
    "uxs-c2": ["Command Systems", "Teaming", "Controls"],
}
SUFFIX = ["Inc.", "LLC", "Corp.", "Technologies Inc.", "Co."]

WHAT = {
    "uas": ["small uncrewed aircraft systems", "Group 3 UAS airframes", "long-endurance UAS"],
    "counter-uas": ["counter-sUAS detection and defeat", "passive RF drone detection"],
    "swarming": ["heterogeneous drone swarm coordination", "swarm tasking algorithms"],
    "gps-denied-nav": ["visual-inertial navigation without GPS", "alternative PNT receivers"],
    "maritime": ["uncrewed surface vessels", "autonomous undersea vehicles"],
    "ground-robotics": ["robotic combat vehicle autonomy kits", "uncrewed ground vehicles"],
    "autonomy-software": ["mission autonomy software", "onboard perception stacks"],
    "collaborative-combat-aircraft": [
        "collaborative combat aircraft prototypes",
        "attritable wingman air vehicles",
    ],
    "loitering-munitions": ["loitering munition systems", "one-way attack air vehicles"],
    "uxs-c2": ["common control stations for uncrewed systems", "human-machine teaming software"],
}

STAGES = {
    # key: (description template, low $, high $)
    "phase_1": ("SBIR Phase I: feasibility study for {what}.", 75e3, 250e3),
    "phase_2": ("SBIR Phase II: prototype development and demonstration of {what}.", 0.9e6, 2e6),
    "production": ("Production and delivery of {what}, with spares and training.", 8e6, 600e6),
    "other": ("Research, development, test and evaluation of {what}.", 0.2e6, 40e6),
}

# How far each company got, and where it stalled. Weights sum to 1.
TRAJECTORIES = [
    (0.22, ["phase_1"]),
    (0.22, ["phase_1", "phase_2"]),
    (0.14, ["phase_1", "phase_2", "production"]),
    (0.10, ["phase_1", "production"]),
    (0.12, ["production"]),
    (0.20, []),
]


def _log_uniform(rng: random.Random, lo: float, hi: float) -> Decimal:
    from math import exp, log

    return Decimal(round(exp(rng.uniform(log(lo), log(hi))), 2)).quantize(Decimal("0.01"))


def _uei(rng: random.Random) -> str:
    return "".join(rng.choice("ABCDEFGHJKLMNPQRSTUVWXYZ0123456789") for _ in range(12))


def seed(conn: psycopg.Connection, *, today: date | None = None, rng_seed: int = 7) -> dict:
    """Insert the sample data set. Safe to call once on an empty database."""
    rng = random.Random(rng_seed)
    today = today or date.today()
    now = datetime.now(UTC)
    tax = taxonomy()
    slugs = list(tax["tags"])
    stats = LoadStats()

    with conn.transaction():
        tag_ids = {}
        for slug, desc in {
            tax["root"]: "Root tag: any autonomy-related entity.",
            **tax["tags"],
        }.items():
            tag_ids[slug] = conn.execute(
                """INSERT INTO tags (slug, description, source, source_id)
                   VALUES (%s, %s, 'taxonomy', %s)
                   ON CONFLICT (source, source_id) DO UPDATE SET description = EXCLUDED.description
                   RETURNING id""",
                (slug, desc, slug),
            ).fetchone()[0]

        def tag(entity_type: str, entity_id: int, tags: list[str]) -> None:
            for slug in [tax["root"], *tags]:
                conn.execute(
                    """INSERT INTO taggings (entity_type, entity_id, tag_id, confidence,
                                             source, source_id)
                       VALUES (%s, %s, %s, %s, %s, %s) ON CONFLICT DO NOTHING""",
                    (
                        entity_type,
                        entity_id,
                        tag_ids[slug],
                        0.9,
                        SOURCE,
                        f"{entity_type}:{entity_id}:{slug}",
                    ),
                )

        agency_ids = {a.source_id: upsert_org(conn, a, stats) for a, _ in AGENCIES}

        def agency_for(slug: str) -> OrgRef:
            fits = [a for a, focus in AGENCIES if slug in focus]
            return rng.choice(fits or [a for a, _ in AGENCIES])

        # Solicitations: most closed, the newest still open.
        opps: dict[str, list[tuple[int, date]]] = {s: [] for s in slugs}
        for i in range(44):
            slug = slugs[i % len(slugs)]
            what = rng.choice(WHAT[slug])
            agency = agency_for(slug)
            age = int(rng.triangular(0, 400, 20)) if i >= 6 else rng.randint(0, 5)
            posted = today - timedelta(days=age)
            closes = posted + timedelta(days=rng.choice([30, 45, 60, 90]))
            kind = rng.choice(
                ["Broad Agency Announcement", "SBIR topic", "Commercial Solutions Opening", "RFI"]
            )
            (opp_id,) = conn.execute(
                """INSERT INTO opportunities (title, description, agency_id, posted_at, closes_at,
                                              url, source, source_id)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING id""",
                (
                    f"{what[0].upper()}{what[1:]} ({kind})",
                    f"{agency.canonical_name} seeks {what}.",
                    agency_ids[agency.source_id],
                    posted,
                    closes,
                    f"https://example.org/seed/opportunity/{i + 1}",
                    SOURCE,
                    f"opp-{i + 1}",
                ),
            ).fetchone()
            tag("opportunity", opp_id, [slug])
            opps[slug].append((opp_id, posted))

        n_awards = 0
        names = rng.sample(NAME_A, 44)
        for i, first in enumerate(names):
            focus = [slugs[i % len(slugs)]]
            if rng.random() < 0.4:
                focus.append(rng.choice([s for s in slugs if s != focus[0]]))
            org = OrgRef(
                source=SOURCE,
                source_id=f"company:{first.lower()}",
                canonical_name=f"{first} {rng.choice(NAME_B[focus[0]])} {rng.choice(SUFFIX)}",
                kind="company",
                uei=_uei(rng),
            )
            r, path = rng.random(), []
            for weight, steps in TRAJECTORIES:
                if r < weight:
                    path = steps
                    break
                r -= weight
            # Staged awards run oldest to newest; a newcomer's whole history is this week.
            newcomer = i % 11 == 0
            span = 6 if newcomer else rng.randint(120, 380)
            plan = [(s, span - (span // max(len(path), 1)) * k) for k, s in enumerate(path)]
            plan += [("other", rng.randint(0, span)) for _ in range(rng.randint(1, 9))]
            if not newcomer:
                # Recent activity, so the last 30 days are never empty.
                plan += [
                    (
                        rng.choice(["other", path[-1] if path else "other"]),
                        int(rng.triangular(0, 60, 0)),
                    )
                    for _ in range(rng.randint(0, 5))
                ]
            for stage, age in plan:
                slug = rng.choice(focus)
                what = rng.choice(WHAT[slug])
                template, lo, hi = STAGES[stage]
                agency = agency_for(slug)
                day = today - timedelta(days=max(age, 0))
                n_awards += 1
                award_id = upsert_award(
                    conn,
                    AwardRecord(
                        source=SOURCE,
                        source_id=f"award-{n_awards}",
                        fetched_at=now,
                        recipient=org,
                        agency=agency,
                        amount=_log_uniform(rng, lo, hi),
                        signed_at=day,
                        description=template.format(what=what),
                        url=f"https://example.org/seed/award/{n_awards}",
                        awardees=[org],
                    ),
                    stats,
                )
                tag("award", award_id, [slug])
                earlier = [o for o, posted in opps[slug] if posted < day]
                if earlier and rng.random() < 0.45:
                    conn.execute(
                        "UPDATE awards SET opportunity_id = %s WHERE id = %s",
                        (rng.choice(earlier), award_id),
                    )

        # One award the classifier would reject, to prove the API hides untagged rows.
        upsert_award(
            conn,
            AwardRecord(
                source=SOURCE,
                source_id="award-not-autonomy",
                fetched_at=now,
                agency=NAVY,
                amount=Decimal("950000000.00"),
                signed_at=today,
                description="Destroyer maintenance availability. Not autonomy; never tagged.",
            ),
            stats,
        )
    conn.commit()
    return {"awards": n_awards, "companies": len(names), "opportunities": 44}
