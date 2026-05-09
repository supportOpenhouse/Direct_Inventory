"""Unit tests for OH Pricing row normalization.

Sample rows are taken verbatim from the live OH Pricing sheet so any future
column rename in the sheet would be caught here before deploy.
"""
from __future__ import annotations

from backend.services.oh_pricing_sync import _normalize_row


def test_normalize_gurgaon_row():
    raw = {
        "society": "AEZ Aloha",
        "locality": "Sushant Lok 3 Extension",
        "micromarket": "",
        "bhk": 4,
        "sqft": 3260,
        "target": 0,
        "demand_score": "",
        "confidence": "LOW",
        "selling_price_l": 280.7,
        "acq_price_l": 266.7,
        "margin_l": 14,
    }
    out = _normalize_row(raw, default_city="Gurgaon")
    assert out is not None
    assert out["city"] == "Gurgaon"
    assert out["society"] == "AEZ Aloha"
    assert out["bhk"] == 4
    assert out["area_sqft"] == 3260
    # 280.7 ₹L = ₹2,80,70,000
    assert out["price"] == 28_070_000
    # Gurgaon Acq Price comes from "★ Acq Price (₹L)" → acq_price_l. 266.7 ₹L = ₹2,66,70,000.
    assert out["acq_price"] == 26_670_000


def test_normalize_noida_gzb_row():
    raw = {
        "city": "Ghaziabad",
        "locality": "Vaibhav Khand",
        "society": "Aarcity Krishna Apra Sapphire",
        "bhk": 3,
        "size_sqft": 1470,
        "sell_price_l": 180.6,
        "l1_acq_l": 164.2,
        "l2_acq_l": 168.8,        # we pick L2 specifically
        "l3_acq_l": 173.7,
    }
    out = _normalize_row(raw, default_city=None)
    assert out is not None
    assert out["city"] == "Ghaziabad"
    assert out["bhk"] == 3
    assert out["area_sqft"] == 1470
    assert out["price"] == 18_060_000
    # Noida+GZB Acq Price comes specifically from "L2 Acq (₹L)". 168.8 ₹L = ₹1,68,80,000.
    assert out["acq_price"] == 16_880_000


def test_normalize_acq_price_optional():
    # Valid row but no acq columns at all — acq_price should be None, not failure
    raw = {"society": "Foo", "city": "Noida", "bhk": 2, "sqft": 1000, "selling_price_l": 100}
    out = _normalize_row(raw, default_city=None)
    assert out is not None
    assert out["acq_price"] is None


def test_normalize_skips_when_no_society():
    raw = {"city": "Noida", "bhk": 2, "sqft": 1000, "selling_price_l": 100}
    assert _normalize_row(raw, default_city=None) is None


def test_normalize_skips_when_no_price():
    raw = {"society": "Foo", "city": "Noida", "bhk": 2, "sqft": 1000}
    assert _normalize_row(raw, default_city=None) is None


def test_normalize_skips_when_unknown_city():
    raw = {"society": "Foo", "city": "Mumbai", "bhk": 2, "sqft": 1000, "selling_price_l": 100}
    assert _normalize_row(raw, default_city=None) is None


def test_normalize_falls_back_to_default_city_for_gurgaon_tab():
    raw = {"society": "Foo", "bhk": 2, "sqft": 1000, "selling_price_l": 100}
    out = _normalize_row(raw, default_city="Gurgaon")
    assert out is not None
    assert out["city"] == "Gurgaon"


def test_normalize_handles_raw_rupees_without_lakhs_suffix():
    raw = {"society": "Foo", "city": "Noida", "bhk": 2, "sqft": 1000, "price": 12500000}
    out = _normalize_row(raw, default_city=None)
    assert out is not None
    assert out["price"] == 12_500_000
