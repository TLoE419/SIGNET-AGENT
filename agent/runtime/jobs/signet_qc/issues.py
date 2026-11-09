"""Shared QC issue IDs and their serialized representation."""

from enum import Enum


class IssueCode(Enum):
    @property
    def severity(self):
        return 'error'


class CommonIssue(IssueCode):
    SIGNET_EXIT_NONZERO = 'signet_exit_nonzero'
    REQUIRED_ARTIFACT_MISSING = 'required_artifact_missing'
    INVALID_OR_UNREADABLE_ARTIFACT = 'invalid_or_unreadable_artifact'
    EMPTY_MATRIX = 'empty_matrix'
    RAGGED_MATRIX = 'ragged_matrix'
    INVALID_MATRIX_VALUES = 'invalid_matrix_values'
    SAMPLE_ID_COUNT_MISMATCH = 'sample_id_count_mismatch'
    DUPLICATE_SAMPLE_IDS = 'duplicate_sample_ids'
