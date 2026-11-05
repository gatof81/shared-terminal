"""Tests for the @skills-dir decision detector (investigation #2). Pure, no CLI.
Run: python3 test_skills_block_detect.py

Texts use the REAL 2.1.314 phrasings found by static analysis of claude.exe."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import skills_block_detect as D  # noqa: E402

P = "2026-11-05T10:00:00.000Z [DEBUG] "
# The real UI block line (builder `yvn`), as it renders on the pane.
BLOCK_UI = ("✗ Plugins from /home/developer/.claude/skills/ are blocked by your organization's "
            "managed settings (strictKnownMarketplaces or blockedMarketplaces). Ask your "
            "administrator to add {\"source\":\"skills-dir\"} to strictKnownMarketplaces, or remove "
            "it from blockedMarketplaces.")
# The real loaded line (a [DEBUG] entry the kit captures today).
LOADED = P + "hooks module st-b1-rogue-n14@skills-dir loaded (worker, environment 3, tier user); events: session.start"
# A GENERIC marketplace block (no skills-dir advice) must NOT be read as a skills-dir block.
GENERIC_MARKET_BLOCK = ("✗ Marketplace \"st-b1-rogue-mk6\" is blocked by your organization's "
                        "managed settings (strictKnownMarketplaces or blockedMarketplaces).")
PROBE_ONLY = P + "hooks module st-b1-probe@st-b1 loaded (worker, environment 2, tier prepend)"


class SkillsDirDetect(unittest.TestCase):
    def test_loaded_is_fail(self):
        self.assertEqual(D.classify_skills_dir(LOADED), "loaded")
        self.assertEqual(D.classify_skills_dir(PROBE_ONLY + "\n" + LOADED), "loaded")

    def test_block_detected_from_ui_line(self):
        self.assertEqual(D.classify_skills_dir(BLOCK_UI), "blocked")
        self.assertEqual(D.classify_skills_dir(PROBE_ONLY + "\n" + BLOCK_UI), "blocked")

    def test_loaded_wins_over_block_text(self):
        # If the rogue actually loaded, that is a FAIL regardless of any block text present.
        self.assertEqual(D.classify_skills_dir(BLOCK_UI + "\n" + LOADED), "loaded")

    def test_generic_marketplace_block_is_not_skills_dir(self):
        self.assertEqual(D.classify_skills_dir(GENERIC_MARKET_BLOCK), "none")

    def test_nothing_is_none(self):
        self.assertEqual(D.classify_skills_dir(PROBE_ONLY), "none")
        self.assertEqual(D.classify_skills_dir(""), "none")
        self.assertEqual(D.classify_skills_dir(None), "none")


if __name__ == "__main__":
    unittest.main()
