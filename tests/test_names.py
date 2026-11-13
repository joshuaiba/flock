"""Short display names for graph labels."""

from __future__ import annotations

import pytest

from pipeline.api import names


@pytest.mark.parametrize(
    ("legal", "short"),
    [
        # Legal suffixes go, whole words only, after a comma too.
        ("ATLANTIC DIVING SUPPLY, INC.", "Atlantic Diving Supply"),
        ("GRIFFON AEROSPACE, INC.", "Griffon Aerospace"),
        ("LOCKHEED MARTIN CORPORATION", "Lockheed Martin"),
        ("FISHER SCIENTIFIC COMPANY L.L.C.", "Fisher Scientific"),
        ("PLATFORM SYSTEMS, INCORPORATED", "Platform Systems"),
        ("MEDLINE INDUSTRIES, LP", "Medline Industries"),
        ("CARDINAL HEALTH 200, LLC", "Cardinal Health 200"),
        ("JTG CORPORATION PTE. LTD.", "JTG"),
        ("XCORP", "Xcorp"),
        # "& CO" goes as a pair; an inner "&" stays.
        ("W S DARLEY & CO", "W S Darley"),
        ("OWENS & MINOR DISTRIBUTION INC", "Owens & Minor Distribution"),
        ("TENNANT SALES AND SERVICE COMPANY", "Tennant Sales and Service"),
        # Title case, keeping acronyms and initials.
        ("HII UNMANNED SYSTEMS, INC", "HII Unmanned Systems"),
        ("SRC INC", "SRC"),
        ("S.C.A. - SHIPPING CONSULTANTS ASSOCIATED LTD.", "SCA Shipping Consultants Associated"),
        ("U.S. TACTICAL SUPPLY, INC.", "US Tactical Supply"),
        ("BV-WOOLPERT JOINT VENTURE", "BV-Woolpert Joint Venture"),
        ("R2 WIRELESS, INC.", "R2 Wireless"),
        ("3AUTONOMY LLC", "3Autonomy"),
        ("UNIVERSITY OF TEXAS AT AUSTIN", "University of Texas at Austin"),
        ("THE BOEING COMPANY", "Boeing"),
        ("O'GARA GROUP INC", "O'Gara Group"),
        ("XYZ HOLDINGS LLC DBA SKYHAWK", "Skyhawk"),
        # A name made only of suffixes is written whole, not cut to one.
        ("INC", "Inc"),
        ("CO INC", "CO Inc"),
        # A name already in mixed case keeps its capitals.
        ("Kestrel UAS Inc.", "Kestrel UAS"),
        ("Halcyon AI LLC", "Halcyon AI"),
        ("Tidewater Aero Co.", "Tidewater Aero"),
        # The override table, by legal name or by the name without its suffix.
        ("AEROVIRONMENT, INC", "AeroVironment"),
        ("AeroVironment Inc.", "AeroVironment"),
        ("ANDURIL INDUSTRIES, INC.", "Anduril"),
        ("GENERAL ATOMICS AERONAUTICAL SYSTEMS, INC.", "General Atomics"),
        ("SHIELD AI INC", "Shield AI"),
        ("L3HARRIS TECHNOLOGIES, INC.", "L3Harris"),
        ("SARONIC TECHNOLOGIES, INC", "Saronic"),
        ("ATT MOBILITY LLC", "AT&T Mobility"),
        # Nothing left but a suffix: keep it rather than return nothing.
        ("INC", "Inc"),
    ],
)
def test_company_names(legal, short):
    assert names.company_name(legal) == short


@pytest.mark.parametrize(
    ("canonical", "short"),
    [
        ("Department of the Army", "Army"),
        ("DEPT OF THE ARMY", "Army"),
        ("Army", "Army"),
        ("Department of the Navy", "Navy"),
        ("Department of the Air Force", "Air Force"),
        ("United States Marine Corps", "Marine Corps"),
        ("U.S. Space Force", "Space Force"),
        ("Defense Logistics Agency", "Defense Logistics"),
        ("U.S. Special Operations Command", "SOCOM"),
        ("Defense Innovation Unit", "DIU"),
        ("Defense Advanced Research Projects Agency", "DARPA"),
        ("DEFENSE ADVANCED RESEARCH PROJECTS AGENCY", "DARPA"),
        ("Missile Defense Agency", "Missile Defense"),
        ("Defense Information Systems Agency", "DISA"),
        ("Defense Finance And Accounting Service", "DFAS"),
        ("USTRANSCOM", "TRANSCOM"),
        ("Department of Defense", "DoD"),
        ("Air Force Research Laboratory", "AFRL"),
        ("Office of Naval Research", "ONR"),
        # A contracting activity with its location, or a command with its division.
        ("Naval Air Systems Command, Patuxent River, Maryland", "NAVAIR"),
        ("Naval Surface Warfare Center, Dahlgren Division, Dahlgren, Virginia", "NSWC"),
        ("Army Contracting Command Redstone Arsenal", "Army Contracting"),
        # Unknown: prefixes go, the rest is title-cased.
        ("Department of the Interior", "Interior"),
        ("DEPT OF ENERGY", "Energy"),
        ("DEFENSE HUMAN RESOURCES ACTIVITY", "Defense Human Resources Activity"),
        ("Space Development Agency", "Space Development Agency"),
        # A prefix with nothing but joining words after it stays.
        ("Dept of the", "Dept of the"),
    ],
)
def test_agency_names(canonical, short):
    assert names.agency_name(canonical) == short


def test_display_name_by_kind():
    assert names.display_name("AEROVIRONMENT, INC", "company") == "AeroVironment"
    assert names.display_name("Department of the Army", "agency") == "Army"
    assert names.display_name("AFWERX", "office") == "AFWERX"
    # Solicitations keep their title; there is nothing to shorten.
    assert names.display_name("Group 3 UAS airframes (RFI)", "opportunity") is None
    assert names.display_name("", "company") is None
    assert names.display_name(None, "company") is None
