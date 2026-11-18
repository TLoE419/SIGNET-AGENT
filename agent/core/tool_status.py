"""Classify a tool invocation separately from scientific completion."""


def activity_status(status):
    if status in {'ok', 'success', 'completed', 'verified_completed', 'prepared', 'unchanged', 'created', 'existing'}:
        return 'completed'
    if status in {'error', 'failed', 'verification_failed', 'timeout', 'timed_out', 'invalid', 'blocked', 'unavailable'}:
        return 'failed'
    if status in {'interrupted', 'cancelled'}:
        return 'cancelled'
    return 'needs_review'
