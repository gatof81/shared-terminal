#!/usr/bin/env python3
"""Investigation #2 — minimal sanitized detector for the @skills-dir policy decision.

DISPOSABLE investigation artifact; NOT part of the audited PASS-B1a kit (`poc/passb1`, 8eafe1a), and
never run on VM100. It does not import or modify the kit.

Why it exists: static analysis of 2.1.314 (see docs/design/project-chat/inv2-n14-skillsdir.md) shows
the skills-dir BLOCK is reported only to the UI (`✗ Plugins from …/.claude/skills/ are blocked
…`, builder `yvn`) and to telemetry (`cli_plugin_init=policy_blocked`) — NEVER to `--debug-file`.
The kit captures only the debug-file + stderr (the pane is transient), so a *blocked* skills-dir
plugin leaves no captured evidence, while a *loaded* one does (`hooks module … loaded`, a DEBUG
line). This detector classifies the decision from the text the kit COULD capture if it also scanned
the pane — emitting a sanitized ENUM, never raw text (same privacy rule as the trust-gate prototype).
"""
import re

# The loaded rogue (FAIL) — a captured [DEBUG] line today.
ROGUE_LOADED = re.compile(r"hooks module st-b1-rogue-n14@\S+ loaded \(")
# The skills-dir BLOCK — the 2.1.314 UI builder `yvn`, hardcoding the skills-dir advice; today only
# on the pane. The path is variable; the skills-dir advice makes it specific (not a generic market).
SKILLS_DIR_BLOCK = re.compile(
    r"Plugins from \S+ are blocked by your organization's managed settings "
    r"\(strictKnownMarketplaces or blockedMarketplaces\)\. "
    r"Ask your administrator to add \{\"source\":\"skills-dir\"\}")


def classify_skills_dir(text):
    """Sanitized decision enum from captured text (debug + pane):
      'loaded'  — the rogue skills-dir plugin executed (FAIL); captured in debug today.
      'blocked' — the managed policy refused it (the `yvn` UI line); NOT captured by the kit today.
      'none'    — neither signal present: not-discovered OR insufficient evidence (indistinguishable).
    """
    if ROGUE_LOADED.search(text or ""):
        return "loaded"
    if SKILLS_DIR_BLOCK.search(text or ""):
        return "blocked"
    return "none"
