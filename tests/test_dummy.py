import release_pipeline_dummy


def test_version():
    assert release_pipeline_dummy.__version__


def test_trip2_scenario8():
    """Make CI fail so origin-check must block scenario 8."""
    assert False, "TEST-ONLY: deliberate scenario 8 CI failure"
