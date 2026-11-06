#!/usr/bin/env python3
"""
FIDO2 helper for fingerprint-based account recovery (指紋帳號復原 計劃，階段 1).

The Electron main process (FidoProvider.js) spawns this script once per operation.
Protocol: newline-delimited JSON on stdin/stdout.

  main  -> helper  first line : {"cmd": "...", ...params}
  helper -> main   events     : {"type": "event", "event": "...", ...}
  helper -> main   PIN request: {"type": "pin-request", "retries": n}
  main  -> helper  PIN answer : {"pin": "..."}  or  {"pin": null} to cancel
  helper -> main   final line : {"type": "result", ...}  or  {"type": "error", "code": "...", "message": "..."}

All binary values are base64url (no padding).

Commands
  info          Device capabilities and PIN / fingerprint state. No touch needed.
  register      Create a credential with hmac-secret and derive the secret for `salt`.
                params: rpId, challenge, userId, userName, salt
  authenticate  Get an assertion from one of `credentialIds` and derive the secret for `salt`.
                params: rpId, challenge, credentialIds[], salt
  set-pin       Set the FIDO2 PIN on a fresh key. params: pin
  enroll        Enroll a fingerprint. Asks for the PIN via pin-request. params: name?

The derived secret leaves this process only in the `secret` field of the result and
is never written to disk or stderr.
"""
import base64
import json
import os
import sys
import threading
import time

try:
    from fido2.client import ClientError, DefaultClientDataCollector, Fido2Client, UserInteraction
    from fido2.ctap import CtapError
    from fido2.ctap2 import Ctap2
    from fido2.ctap2.bio import CaptureError, FPBioEnrollment
    from fido2.ctap2.extensions import HmacSecretExtension
    from fido2.ctap2.pin import ClientPin
    from fido2.hid import CtapHidDevice
    from fido2.webauthn import (
        PublicKeyCredentialCreationOptions,
        PublicKeyCredentialDescriptor,
        PublicKeyCredentialParameters,
        PublicKeyCredentialRequestOptions,
        PublicKeyCredentialRpEntity,
        PublicKeyCredentialType,
        PublicKeyCredentialUserEntity,
        UserVerificationRequirement,
    )
except ImportError as _e:  # pragma: no cover
    sys.stdout.write(json.dumps({
        "type": "error",
        "code": "FIDO2_NOT_INSTALLED",
        "message": f"python fido2 package missing: {_e}. Run: pip3 install 'fido2>=2.2'",
    }) + "\n")
    sys.stdout.flush()
    sys.exit(2)

_out_lock = threading.Lock()
MAX_UV_ATTEMPTS = 6  # safety cap; the key itself blocks the fingerprint after 3 consecutive misses
LIFT_PAUSE_S = 1.5    # after a miss, give the user time to lift the finger before the key re-arms


class HelperError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(bytes(data)).rstrip(b"=").decode()


def unb64u(s: str) -> bytes:
    if not isinstance(s, str):
        raise HelperError("BAD_REQUEST", "expected base64url string")
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def send(obj):
    with _out_lock:
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()


def event(name, **kw):
    send({"type": "event", "event": name, **kw})


def read_msg():
    line = sys.stdin.readline()
    if not line:
        raise HelperError("CANCELLED", "stdin closed")
    return json.loads(line)


def ask_pin(ctap):
    try:
        retries = ClientPin(ctap).get_pin_retries()[0]
    except Exception:
        retries = None
    send({"type": "pin-request", "retries": retries})
    pin = read_msg().get("pin")
    if not pin:
        raise HelperError("CANCELLED", "PIN entry cancelled")
    return pin


def uv_retries_left(ctap):
    try:
        return ClientPin(ctap).get_uv_retries()
    except Exception:
        return None


class Interaction(UserInteraction):
    """Event semantics for the UI:
    uv    - about to ask the key for a fingerprint; tell the user to wait for the green LED
    touch - the key is waiting right now (keepalive UPNEEDED); place the finger and touch the bezel
    """

    def __init__(self, ctap):
        self.ctap = ctap

    def prompt_up(self):
        event("touch")

    def request_uv(self, permissions, rp_id):
        # When the fingerprint is locked, skip it so python-fido2 goes straight to the PIN
        # instead of showing a fingerprint prompt that can never succeed.
        if uv_retries_left(self.ctap) == 0:
            event("uv-blocked")
            return False
        event("uv")
        return True

    def request_pin(self, permissions, rp_id):
        event("pin-fallback")
        return ask_pin(self.ctap)


def open_device():
    devs = list(CtapHidDevice.list_devices())
    if not devs:
        raise HelperError("NO_DEVICE", "No FIDO2 security key found")
    if len(devs) > 1:
        event("multiple-devices", count=len(devs))
    dev = devs[0]
    return dev, Ctap2(dev)


def require_ready(ctap):
    info = ctap.info
    if "hmac-secret" not in info.extensions:
        raise HelperError("UNSUPPORTED", "Security key does not support hmac-secret")
    if not info.options.get("clientPin"):
        raise HelperError("PIN_NOT_SET", "Security key has no PIN set")


def make_client(dev, ctap, rp_id):
    return Fido2Client(
        dev,
        DefaultClientDataCollector(f"https://{rp_id}"),
        user_interaction=Interaction(ctap),
        extensions=[HmacSecretExtension(allow_hmac_secret=False)],
    )


def ctap_code(err):
    cause = err.cause if isinstance(err, ClientError) else err
    return cause.code if isinstance(cause, CtapError) else None


def with_uv_retry(ctap, fn):
    for _ in range(MAX_UV_ATTEMPTS):
        try:
            return fn()
        except ClientError as e:
            code = ctap_code(e)
            if code == CtapError.ERR.UV_INVALID:
                left = uv_retries_left(ctap)
                event("uv-failed", retriesLeft=left)
                if left:
                    # Re-arming while the finger still rests on the sensor tends to fail again.
                    event("lift-finger")
                    time.sleep(LIFT_PAUSE_S)
                continue
            if code == CtapError.ERR.UV_BLOCKED:
                event("uv-blocked")
                continue
            raise
    raise HelperError("UV_FAILED", "Too many failed fingerprint attempts")


def prf_first(ext_results):
    prf = getattr(ext_results, "prf", None) if ext_results else None
    if prf and prf.results and prf.results.first:
        return bytes(prf.results.first)
    return None


# ---------------------------------------------------------------- commands

def cmd_info(req):
    dev, ctap = open_device()
    info = ctap.info
    opts = dict(info.options)
    cp = ClientPin(ctap)
    pin_retries = cp.get_pin_retries()[0] if opts.get("clientPin") else None
    uv_retries = cp.get_uv_retries() if opts.get("bioEnroll") else None
    return {
        "product": dev.descriptor.product_name,
        "aaguid": info.aaguid.hex(),
        "versions": list(info.versions),
        "hmacSecret": "hmac-secret" in info.extensions,
        "bioSupported": opts.get("bioEnroll") is not None,
        "fingerprintEnrolled": bool(opts.get("bioEnroll")),
        "pinSet": bool(opts.get("clientPin")),
        "pinRetries": pin_retries,
        "uvRetries": uv_retries,
        "minPinLength": getattr(info, "min_pin_length", None),
    }


def assertion_ok(auth_data):
    # UP (0x01) and UV (0x04) must both be set.
    return bool(auth_data.flags & 0x01) and bool(auth_data.flags & 0x04)


def cmd_register(req):
    rp_id = req["rpId"]
    challenge = unb64u(req["challenge"])
    salt = unb64u(req["salt"])
    user_id = unb64u(req["userId"])
    user_name = req.get("userName") or "user"

    dev, ctap = open_device()
    require_ready(ctap)
    client = make_client(dev, ctap, rp_id)

    options = PublicKeyCredentialCreationOptions(
        rp=PublicKeyCredentialRpEntity(id=rp_id, name="Secure Cloud Storage"),
        user=PublicKeyCredentialUserEntity(id=user_id, name=user_name, display_name=user_name),
        challenge=challenge,
        pub_key_cred_params=[
            PublicKeyCredentialParameters(type=PublicKeyCredentialType.PUBLIC_KEY, alg=-7),   # ES256
            PublicKeyCredentialParameters(type=PublicKeyCredentialType.PUBLIC_KEY, alg=-8),   # EdDSA
        ],
        extensions={"prf": {"eval": {"first": salt}}},
        authenticator_selection={"userVerification": "required", "residentKey": "discouraged"},
        attestation="none",
    )
    reg = with_uv_retry(ctap, lambda: client.make_credential(options))
    att = reg.response.attestation_object
    auth_data = att.auth_data
    if not assertion_ok(auth_data):
        raise HelperError("UV_MISSING", "Authenticator did not perform user verification")
    prf = getattr(reg.client_extension_results, "prf", None)
    if not prf or not prf.enabled:
        raise HelperError("UNSUPPORTED", "hmac-secret was not enabled on the new credential")
    cred_id = auth_data.credential_data.credential_id

    secret = prf_first(reg.client_extension_results)
    if secret is None:
        # Key lacks hmac-secret-mc: derive with a second fingerprint scan.
        event("need-second-touch")
        secret = _derive(client, ctap, rp_id, os.urandom(32), [cred_id], salt)[1]

    return {
        "credential": {
            "id": b64u(cred_id),
            "clientDataJSON": b64u(reg.response.client_data),
            "attestationObject": b64u(att),
        },
        "secret": b64u(secret),
    }


def _derive(client, ctap, rp_id, challenge, cred_ids, salt):
    options = PublicKeyCredentialRequestOptions(
        challenge=challenge,
        rp_id=rp_id,
        allow_credentials=[
            PublicKeyCredentialDescriptor(type=PublicKeyCredentialType.PUBLIC_KEY, id=cid) for cid in cred_ids
        ],
        user_verification=UserVerificationRequirement.REQUIRED,
        extensions={"prf": {"eval": {"first": salt}}},
    )
    sel = with_uv_retry(ctap, lambda: client.get_assertion(options))
    res = sel.get_response(0)
    if not assertion_ok(res.response.authenticator_data):
        raise HelperError("UV_MISSING", "Authenticator did not perform user verification")
    secret = prf_first(res.client_extension_results)
    if secret is None:
        raise HelperError("NO_SECRET", "Authenticator returned no hmac-secret output")
    return res, secret


def cmd_authenticate(req):
    rp_id = req["rpId"]
    challenge = unb64u(req["challenge"])
    salt = unb64u(req["salt"])
    cred_ids = [unb64u(c) for c in req["credentialIds"]]
    if not cred_ids:
        raise HelperError("BAD_REQUEST", "credentialIds is empty")

    dev, ctap = open_device()
    require_ready(ctap)
    client = make_client(dev, ctap, rp_id)
    try:
        res, secret = _derive(client, ctap, rp_id, challenge, cred_ids, salt)
    except ClientError as e:
        if ctap_code(e) == CtapError.ERR.NO_CREDENTIALS or e.code == ClientError.ERR.DEVICE_INELIGIBLE:
            raise HelperError("WRONG_KEY", "This security key is not bound to the account")
        raise
    r = res.response
    return {
        "assertion": {
            "id": b64u(res.raw_id),
            "clientDataJSON": b64u(r.client_data),
            "authenticatorData": b64u(r.authenticator_data),
            "signature": b64u(r.signature),
            "userHandle": b64u(r.user_handle) if r.user_handle else None,
        },
        "secret": b64u(secret),
    }


def cmd_set_pin(req):
    _, ctap = open_device()
    if ctap.info.options.get("clientPin"):
        raise HelperError("PIN_ALREADY_SET", "PIN is already set on this key")
    pin = req.get("pin") or ""
    min_len = getattr(ctap.info, "min_pin_length", None) or 4
    if len(pin) < min_len:
        raise HelperError("PIN_TOO_SHORT", f"PIN must be at least {min_len} characters")
    ClientPin(ctap).set_pin(pin)
    return {"pinSet": True}


def cmd_enroll(req):
    _, ctap = open_device()
    if ctap.info.options.get("bioEnroll") is None:
        raise HelperError("UNSUPPORTED", "Security key has no fingerprint sensor")
    if not ctap.info.options.get("clientPin"):
        raise HelperError("PIN_NOT_SET", "Set a PIN before enrolling fingerprints")
    cp = ClientPin(ctap)
    token = cp.get_pin_token(ask_pin(ctap), ClientPin.PERMISSION.BIO_ENROLL)
    bio = FPBioEnrollment(ctap, cp.protocol, token)
    ctx = bio.enroll(timeout=30000)
    template_id = None
    event("enroll-start")
    while template_id is None:
        try:
            template_id = ctx.capture()
            event("enroll-sample", remaining=ctx.remaining)
        except CaptureError as e:
            event("enroll-retry", feedback=int(e.code))
    name = req.get("name")
    if name:
        bio.set_name(template_id, name)
    return {"templateId": b64u(template_id), "enrolledCount": len(bio.enumerate_enrollments())}


COMMANDS = {
    "info": cmd_info,
    "register": cmd_register,
    "authenticate": cmd_authenticate,
    "set-pin": cmd_set_pin,
    "enroll": cmd_enroll,
}

CTAP_CODE_MAP = {
    "PIN_INVALID": "PIN_INVALID",
    "PIN_BLOCKED": "PIN_BLOCKED",
    "PIN_AUTH_BLOCKED": "PIN_AUTH_BLOCKED",
    "UV_BLOCKED": "UV_BLOCKED",
    "USER_ACTION_TIMEOUT": "TIMEOUT",
    "KEEPALIVE_CANCEL": "CANCELLED",
    "OPERATION_DENIED": "DENIED",
    "NO_CREDENTIALS": "WRONG_KEY",
    "PIN_POLICY_VIOLATION": "PIN_POLICY_VIOLATION",
}


def main():
    try:
        req = read_msg()
        cmd = COMMANDS.get(req.get("cmd"))
        if cmd is None:
            raise HelperError("BAD_REQUEST", f"unknown cmd {req.get('cmd')!r}")
        result = cmd(req)
        send({"type": "result", **result})
    except HelperError as e:
        send({"type": "error", "code": e.code, "message": e.message})
    except (ClientError, CtapError) as e:
        c = ctap_code(e)
        name = c.name if c is not None else None
        code = CTAP_CODE_MAP.get(name, "CTAP_" + name if name else "CLIENT_ERROR")
        send({"type": "error", "code": code, "message": str(e)})
    except KeyError as e:
        send({"type": "error", "code": "BAD_REQUEST", "message": f"missing field {e}"})
    except Exception as e:  # noqa: BLE001
        send({"type": "error", "code": "INTERNAL", "message": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    main()
