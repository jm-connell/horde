"""The timedtext pacer: library caption work first, Ask indexing in the gaps."""

from app.services.timedtext import TimedtextPacer


def test_background_slot_is_spaced():
    pacer = TimedtextPacer()
    assert pacer.try_reserve_background(60)
    assert not pacer.try_reserve_background(60)
    assert pacer.seconds_until_background() > 0


def test_background_fetches_never_block_library_work():
    pacer = TimedtextPacer()
    assert pacer.try_reserve_background(60)
    assert pacer.seconds_blocked() == 0


def test_a_block_stops_background_work():
    pacer = TimedtextPacer()
    pacer.block(30)
    assert pacer.seconds_blocked() > 0
    assert not pacer.try_reserve_background(1)


def test_block_keeps_the_later_time():
    pacer = TimedtextPacer()
    pacer.block(100)
    pacer.block(5)
    assert pacer.seconds_blocked() > 50
