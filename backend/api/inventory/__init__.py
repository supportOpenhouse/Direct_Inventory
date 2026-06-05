"""Inventory API package.

The blueprint lives in `_common`; importing the route modules below registers
their handlers on it. `app.py` registers `inventory.bp`.

Route module order matters for Flask URL matching only insofar as Werkzeug
sorts by rule specificity, not import order — but we import the static/specific
paths (lists, bulk, maintenance) before the `<oh_id>` catch-alls in `records`
to keep the registration intent obvious.
"""
from __future__ import annotations

from ._common import bp  # noqa: F401  (re-exported for app.py)

# Importing these modules registers their @bp routes. Keep after `bp` import.
from . import lists       # noqa: E402,F401
from . import bulk        # noqa: E402,F401
from . import maintenance # noqa: E402,F401
from . import records     # noqa: E402,F401

__all__ = ["bp"]
