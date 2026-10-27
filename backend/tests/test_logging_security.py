from __future__ import annotations

import logging

from app.core.logging import SecretRedactionFilter


def test_secret_redaction_covers_quoted_values_and_bearer_headers() -> None:
    secrets = (
        "password with spaces",
        "access-value",
        "refresh-value",
        "matrix-access-value",
        "matrix-session-value",
        "synapse-signing-key-value",
    )
    record = logging.LogRecord(
        name="test",
        level=logging.ERROR,
        pathname=__file__,
        lineno=1,
        msg=(
            'password="password with spaces" '
            "access_token=access-value "
            "refresh_token: refresh-value "
            "Authorization: Bearer matrix-access-value "
            "matrix_access_token=matrix-session-value "
            "SYNAPSE_JWT_SIGNING_KEY=synapse-signing-key-value"
        ),
        args=(),
        exc_info=None,
    )

    assert SecretRedactionFilter().filter(record)
    message = record.getMessage()
    assert all(secret not in message for secret in secrets)
    assert message.count("[REDACTED]") == len(secrets)
