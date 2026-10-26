"""High water at Dover and spring/neap factor.

Trimmed copy of ../speed_analysis/srichinmoy/tides.py (itself ported from the
simulator's ASTRO module), kept here so this project stays self-contained.
A timing fit to 2026 Dover high waters — good to a few minutes for 2026.
"""

import cmath
import datetime as dt
import math

D2R = math.pi / 180
TIDE_EPOCH = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
W_M2 = 28.9841042 * D2R  # rad/h

# [speed − wM2 (rad/h), complex coefficient]
PARTS = [
    ((28.9841042 - 28.9841042) * D2R, complex(-0.567310, 1.642265)),  # M2
    ((30.0000000 - 28.9841042) * D2R, complex(0.805192, -0.170592)),  # S2
    ((28.4397295 - 28.9841042) * D2R, complex(-0.239403, 0.259680)),  # N2
]
RANGE_A, RANGE_B, MEAN_SPRING_RANGE = 1.4104, 1.7609, 6.16


def _hours(when: dt.datetime) -> float:
    return (when - TIDE_EPOCH).total_seconds() / 3600


def envelope(t: float) -> complex:
    return sum(c * cmath.exp(1j * dw * t) for dw, c in PARTS)


def hw_near(when: dt.datetime) -> float:
    """Hours since epoch of the high water nearest `when` (Newton on the phase)."""
    t = _hours(when)
    for _ in range(25):
        ph = W_M2 * t + cmath.phase(envelope(t))
        ph = (ph + math.pi) % (2 * math.pi) - math.pi
        t -= ph / W_M2
        if abs(ph) < 1e-11:
            break
    return t


def hours_from_hw(when: dt.datetime) -> float:
    """Signed hours from the nearest Dover high water (HW−6 … HW+6)."""
    return _hours(when) - hw_near(when)


def spring_factor(when: dt.datetime) -> float:
    """Stream-strength multiplier: 1.0 at mean springs, ~0.41 at mean neaps."""
    rng = RANGE_A + RANGE_B * abs(envelope(hw_near(when)))
    return max(0.35, min(1.15, rng / MEAN_SPRING_RANGE))
