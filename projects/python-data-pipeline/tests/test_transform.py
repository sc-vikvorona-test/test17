import pytest

from pipeline.transform import (
    filter_records,
    normalize_record,
    paginate_records,
    transform_batch,
)


def test_normalize_record_strips_whitespace():
    record = {"  Name  ": "  Alice  ", "  Age  ": "  30  "}
    result = normalize_record(record)
    assert result == {"name": "Alice", "age": "30"}


def test_normalize_record_converts_empty_string_to_none():
    record = {"status": "  ", "amount": "100"}
    result = normalize_record(record)
    assert result["status"] is None
    assert result["amount"] == "100"


def test_normalize_record_lowercases_and_replaces_spaces_in_keys():
    record = {"First Name": "Bob", "Last Name": "Smith"}
    result = normalize_record(record)
    assert "first_name" in result
    assert "last_name" in result
    assert result["first_name"] == "Bob"


def test_paginate_records_first_page():
    records = list(range(10))
    result = paginate_records(records, page=0, page_size=3)
    assert result == [0, 1, 2]


def test_paginate_records_middle_page():
    records = list(range(10))
    result = paginate_records(records, page=1, page_size=3)
    assert result == [3, 4, 5]


def test_paginate_records_last_partial_page():
    records = list(range(10))
    result = paginate_records(records, page=3, page_size=3)
    assert result == [9]


def test_paginate_records_beyond_end_returns_empty():
    records = list(range(5))
    result = paginate_records(records, page=10, page_size=3)
    assert result == []


def test_paginate_records_invalid_page_raises():
    with pytest.raises(ValueError, match="non-negative"):
        paginate_records([], page=-1, page_size=10)


def test_paginate_records_invalid_page_size_raises():
    with pytest.raises(ValueError, match="positive"):
        paginate_records([], page=0, page_size=0)


def test_filter_records_keeps_matching():
    records = [{"amount": "100"}, {"amount": None}, {"amount": "50"}]
    result = filter_records(records, lambda r: r["amount"] is not None)
    assert len(result) == 2
    assert all(r["amount"] is not None for r in result)


def test_filter_records_empty_input():
    result = filter_records([], lambda r: True)
    assert result == []


def test_transform_batch_normalizes_all_records():
    records = [
        {"Transaction ID": "  txn-1  ", "Amount": "200"},
        {"Transaction ID": "txn-2", "Amount": "  "},
    ]
    result = transform_batch(records)
    assert len(result) == 2
    assert result[0]["transaction_id"] == "txn-1"
    assert result[1]["amount"] is None


def test_transform_batch_empty_input():
    result = transform_batch([])
    assert result == []
