"""Query tokenization, stemming, and keyword rank keys."""

from app.services.search_text import (
    explain_match,
    keyword_rank_key,
    query_token_groups,
    snippet_around,
    token_variants,
    tokenize_query,
)


def test_tokenize_drops_stopwords_keeps_keywords():
    assert tokenize_query("paint fix") == ["paint", "fix"]
    assert tokenize_query("I painted his house to fix wifi") == [
        "painted",
        "house",
        "fix",
        "wifi",
    ]


def test_tokenize_stopword_only_keeps_raw():
    assert tokenize_query("the") == ["the"]


def test_token_variants_strip_common_suffixes():
    assert "paint" in token_variants("painting")
    assert "paint" in token_variants("painted")
    assert "paint" in token_variants("paints")
    assert "painted" in token_variants("paint")
    assert "painting" in token_variants("paint")


def test_token_variants_do_not_match_unrelated_prefixes():
    forms = set(token_variants("car"))
    assert "car" in forms
    assert "cars" in forms
    assert "card" not in forms
    assert "carriers" not in forms
    assert "caring" not in forms


def test_whole_word_not_substring():
    from app.services.search_text import query_in_text

    assert query_in_text("car", "We bought a new car today")
    assert query_in_text("car", "Two cars in the garage")
    assert not query_in_text("car", "The RTX 4090 graphics card")
    assert not query_in_text("car", "Switch carriers and save on your phone plan")
    assert query_in_text("paint", "I painted his House to Fix his WiFi")
    assert (
        explain_match("car", title="The RTX 4090 graphics card") is None
    )
    assert (
        explain_match(
            "car",
            title="Upgrade your home WiFi",
            description="Switch carriers and save on your phone plan.",
        )
        is None
    )


def test_query_token_groups_include_stems():
    groups = query_token_groups("painting house")
    assert groups[0][0] == "paint" or "paint" in groups[0]
    assert any("house" in g for g in groups)


def test_short_queries_skip_semantic():
    from app.services.search_text import query_allows_semantic, query_looks_natural

    assert not query_allows_semantic("car")
    assert not query_allows_semantic("gpu")
    assert not query_allows_semantic("wifi")
    assert not query_allows_semantic("hyprland")
    assert not query_allows_semantic("paint fix")
    assert not query_allows_semantic("hyprland install guide")
    assert not query_looks_natural("hyprland install guide")
    assert query_looks_natural("that episode about house wifi")
    assert query_allows_semantic("that episode about house wifi")
    assert query_allows_semantic("something cozy to fall asleep to")


def test_keyword_rank_prefers_phrase_in_title():
    phrase = keyword_rank_key("Paint Fix Special", None, "paint fix", 5)
    split = keyword_rank_key(
        "I painted his House to Fix his WiFi", None, "paint fix", 0
    )
    assert phrase < split


def test_snippet_around_centers_on_token():
    text = "We installed a wifi hotspot in the cab of the fire truck."
    snippet = snippet_around(text, "wifi")
    assert "wifi" in snippet.lower()
    assert "hotspot" in snippet.lower()


def test_explain_keyword_prefers_title_then_description():
    title_hit = explain_match(
        "paint",
        title="I painted his House to Fix his WiFi",
        description="unrelated",
    )
    assert title_hit is not None
    assert title_hit["source"] == "title"

    desc_hit = explain_match(
        "wifi",
        title="We built the ultimate gaming fire truck",
        description="We put a wifi hotspot in the cab.",
    )
    assert desc_hit is not None
    assert desc_hit["source"] == "description"
    assert "wifi" in (desc_hit["snippet"] or "").lower()


def test_explain_keyword_ignores_partial_token_overlap():
    """A lone common word must not claim a multi-word query matched."""
    hit = explain_match(
        "hyprland install guide",
        title="100 Thieves office tour",
        description="A walk through the new office and install of the lights.",
    )
    assert hit is None


def test_snippet_around_empty_when_no_token():
    assert snippet_around("No overlapping terms in this blurb.", "hyprland") == ""


def test_explain_captions_and_related():
    captions = explain_match(
        "wifi",
        title="We built the ultimate gaming fire truck",
        caption_chunk="then we dropped in a wifi hotspot for the LAN party",
    )
    assert captions is not None
    assert captions["source"] == "captions"
    assert "wifi hotspot" in (captions["snippet"] or "").lower()

    related = explain_match(
        "wifi",
        title="We built the ultimate gaming fire truck",
        description="A custom rig build.",
        allow_related=True,
    )
    assert related == {"source": "related", "snippet": None}
