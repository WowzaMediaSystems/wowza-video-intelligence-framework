"""Bearer guard for the vLLM engine's non-OpenAI surface.

Mounted through the upstream ``--middleware`` knob, so it adds a layer and
overrides nothing:

    --middleware vif_auth.VifAuthMiddleware

vLLM's own ``AuthenticationMiddleware`` only guards ``/v1``, ``/v2`` and
``/inference``; everything else -- including the dev endpoints ``/sleep``,
``/wake_up``, ``/is_sleeping`` and ``/collective_rpc`` -- is open to anyone who
can reach the port. This closes that surface with the same key and the same
Bearer scheme, leaving the prefixes vLLM already guards untouched.

With ``VLLM_API_KEY`` unset it is a strict no-op: keyless deployments keep the
posture they have today, where the internal network is the protection.
"""

import hashlib
import os
import secrets
from collections.abc import Awaitable

from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

# Guarded by vLLM's own AuthenticationMiddleware; guarding them again would
# reject requests it has already accepted.
UPSTREAM_GUARDED_PREFIXES: tuple[str, ...] = ("/v1", "/v2", "/inference")

# Callers that legitimately have no key: the compose healthcheck, the
# launcher's own readiness poll, and metrics scrapes.
OPEN_PATHS: frozenset[str] = frozenset({"/health", "/ping", "/metrics", "/version"})


class VifAuthMiddleware:
    """Require ``Authorization: Bearer <VLLM_API_KEY>`` outside the open paths."""

    def __init__(self, app: ASGIApp) -> None:
        self.app: ASGIApp = app
        key: str = os.environ.get("VLLM_API_KEY", "")
        self.token_digest: bytes | None = (
            hashlib.sha256(key.encode("utf-8")).digest() if key else None
        )

    def __call__(self, scope: Scope, receive: Receive, send: Send) -> Awaitable[None]:
        if self.token_digest is None:
            return self.app(scope, receive, send)
        if scope["type"] not in ("http", "websocket") or scope.get("method") == "OPTIONS":
            return self.app(scope, receive, send)

        root_path: str = scope.get("root_path", "")
        path: str = scope["path"].removeprefix(root_path)
        if path.startswith(UPSTREAM_GUARDED_PREFIXES) or self._is_open(path):
            return self.app(scope, receive, send)
        if self._verify(Headers(scope=scope), self.token_digest):
            return self.app(scope, receive, send)

        response: JSONResponse = JSONResponse(
            content={"error": "Unauthorized"}, status_code=401
        )
        return response(scope, receive, send)

    def _is_open(self, path: str) -> bool:
        if path in OPEN_PATHS:
            return True
        # /metrics is a sub-application, so its children are open too.
        return any(path.startswith(f"{open_path}/") for open_path in OPEN_PATHS)

    def _verify(self, headers: Headers, token_digest: bytes) -> bool:
        header: str | None = headers.get("Authorization")
        if not header:
            return False
        scheme, _, param = header.partition(" ")
        if scheme.lower() != "bearer":
            return False
        digest: bytes = hashlib.sha256(param.encode("utf-8")).digest()
        return secrets.compare_digest(digest, token_digest)
