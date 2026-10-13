"""Pin the Microsoft synthesis endpoint while edge-tts 7.2.8 is current.

Endpoint change reviewed from upstream PR 491 (not yet merged/released):
https://github.com/rany2/edge-tts/pull/491
Commit: 8a5844c3a1d33e4e8f2f3e14535542c0d75d4248
Only the endpoint change is applied; the unrelated locale change is excluded.
Remove this patch after validating an upstream release containing the fix.
"""
import hashlib
import importlib.metadata
import pathlib

ORIGINAL_SHA256 = "b73bc5ab451181c2048dac88df64b0c9a0aa763d241ef66a47820863cfb12f41"
ORIGINAL = b'WSS_URL = f"wss://{BASE_URL}/edge/v1?TrustedClientToken={TRUSTED_CLIENT_TOKEN}"'
REPLACEMENT = (
    b'WSS_URL = ("wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1"'
    b' f"?Ocp-Apim-Subscription-Key={TRUSTED_CLIENT_TOKEN}")'
)


def apply(version: str, path: pathlib.Path) -> None:
    if version != "7.2.8":
        raise RuntimeError("Unexpected edge-tts version; review or retire the endpoint patch")
    source = path.read_bytes()
    original = source.replace(REPLACEMENT, ORIGINAL)
    if hashlib.sha256(original).hexdigest() != ORIGINAL_SHA256 or original.count(ORIGINAL) != 1:
        raise RuntimeError("Unexpected edge-tts source; refusing to patch")
    patched = original.replace(ORIGINAL, REPLACEMENT)
    if source != patched:
        path.write_bytes(patched)


if __name__ == "__main__":
    import edge_tts.constants
    apply(importlib.metadata.version("edge-tts"), pathlib.Path(edge_tts.constants.__file__))
    print("edge-tts 7.2.8: Microsoft synthesis endpoint patch verified")
