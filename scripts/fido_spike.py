#!/usr/bin/env python3
"""
指紋帳號復原 計劃 — 階段 0「到貨驗證」腳本。

驗證 YubiKey Bio 是否能當作「以指紋驗證後產生固定秘密值」的裝置：
  1. 讀取金鑰能力：hmac-secret 擴充、bioEnroll、PIN 狀態
  2. 尚未設 PIN 就先設 PIN
  3. 尚未登錄指紋就登錄一枚指紋
  4. 建立一個測試憑證（啟用 prf / hmac-secret）
  5. 用同一個 salt 按指紋兩次 → 秘密值必須相同
     換另一個 salt 按指紋一次   → 秘密值必須不同
  6. （選用 --wrong-pin-test）故意輸錯一次 PIN，觀察剩餘次數回報

所有資料只在記憶體，不寫檔；測試憑證是非常駐（non-discoverable），不佔金鑰儲存空間。

用法：
  python3 scripts/fido_spike.py            # 完整流程
  python3 scripts/fido_spike.py --check    # 只讀能力，不需 PIN、不需觸碰
  python3 scripts/fido_spike.py --wrong-pin-test
  python3 scripts/fido_spike.py --enroll-more    # 補登指紋，提高辨識率
"""
import argparse
import os
import sys
import time
from getpass import getpass

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
    PublicKeyCredentialUserEntity,
    PublicKeyCredentialType,
    UserVerificationRequirement,
)

RP_ID = "secure-cloud-storage.local"
ORIGIN = f"https://{RP_ID}"


def ok(msg):
    print(f"  [OK]   {msg}")


def fail(msg):
    print(f"  [FAIL] {msg}")
    sys.exit(1)


class CliInteraction(UserInteraction):
    def __init__(self, ctap=None):
        self.ctap = ctap

    def prompt_up(self):
        print("  >>> 現在按指紋：手指平放在感測器上，同時碰到銀色金屬環，停留約 1 秒")

    def request_pin(self, permissions, rp_id):
        return getpass("  >>> 請輸入 FIDO2 PIN：")

    def request_uv(self, permissions, rp_id):
        if self.ctap is not None and ClientPin(self.ctap).get_uv_retries() == 0:
            print("  指紋已鎖定，改用 PIN。輸入正確 PIN 會解除指紋鎖定。")
            return False
        print("  等金鑰綠燈閃爍...")
        return True


def get_device():
    devs = list(CtapHidDevice.list_devices())
    if not devs:
        fail("找不到 FIDO 金鑰，請確認 YubiKey Bio 已插上。")
    dev = devs[0]
    print(f"找到金鑰：{dev.descriptor.product_name} (vid={dev.descriptor.vid:04x} pid={dev.descriptor.pid:04x})")
    return dev


def step_check(ctap):
    print("\n[1] 讀取金鑰能力")
    info = ctap.info
    print(f"  versions   = {info.versions}")
    print(f"  aaguid     = {info.aaguid.hex()}")
    print(f"  extensions = {info.extensions}")
    opts = dict(info.options)
    if "hmac-secret" in info.extensions:
        ok("支援 hmac-secret（prf）擴充")
    else:
        fail("不支援 hmac-secret，這支金鑰無法產生秘密值。")
    bio = opts.get("bioEnroll")
    if bio is None:
        fail("不支援 bioEnroll，這不是指紋型金鑰。")
    ok(f"支援指紋登錄 bioEnroll，{'已登錄指紋' if bio else '尚未登錄指紋'}")
    pin = opts.get("clientPin")
    ok(f"支援 clientPin，{'已設定 PIN' if pin else '尚未設定 PIN'}")
    print(f"  alwaysUv   = {opts.get('alwaysUv')}   minPinLength = {getattr(info, 'min_pin_length', None)}")
    return bool(pin), bool(bio)


def step_set_pin(ctap):
    print("\n[2] 設定 FIDO2 PIN（金鑰尚未設定）")
    client_pin = ClientPin(ctap)
    while True:
        p1 = getpass("  >>> 請輸入新的 PIN（至少 4 碼，建議 6 碼以上）：")
        p2 = getpass("  >>> 再輸入一次：")
        if p1 != p2:
            print("  兩次不一致，重來。")
            continue
        if len(p1) < 4:
            print("  太短，重來。")
            continue
        break
    client_pin.set_pin(p1)
    ok("PIN 設定完成")
    return p1


def step_enroll_fingerprint(ctap, pin):
    print("\n[3] 登錄指紋")
    client_pin = ClientPin(ctap)
    token = client_pin.get_pin_token(pin, ClientPin.PERMISSION.BIO_ENROLL)
    bio = FPBioEnrollment(ctap, client_pin.protocol, token)
    sensor = bio.get_fingerprint_sensor_info()
    print(f"  感測器資訊：{sensor}")
    enroller = bio.enroll()
    template_id = None
    print("  >>> 用同一根手指反覆取樣，直到完成。每一次都要：")
    print("      等綠燈閃、手指碰到銀色金屬環、換一個角度（中央、指尖、左側、右側、稍微旋轉）")
    while template_id is None:
        try:
            template_id = enroller.capture()
            if template_id is None:
                print(f"      取樣成功，估計還需要 {enroller.remaining} 次")
        except CaptureError as e:
            print(f"      這次取樣失敗（{e}），再放一次")
    bio.set_name(template_id, f"finger-{len(bio.enumerate_enrollments())}")
    ok(f"指紋登錄完成，template_id = {template_id.hex()}")


def make_client(dev, ctap):
    return Fido2Client(
        dev,
        DefaultClientDataCollector(ORIGIN),
        user_interaction=CliInteraction(ctap),
        extensions=[HmacSecretExtension(allow_hmac_secret=True)],
    )


def _ctap_code(err):
    cause = err.cause if isinstance(err, ClientError) else err
    return cause.code if isinstance(cause, CtapError) else None


def with_uv_retry(ctap, fn):
    """指紋比對失敗（UV_INVALID）時重試；金鑰連錯 3 次會回 UV_BLOCKED，
    python-fido2 會自動改問 PIN，這裡只負責提示。"""
    while True:
        try:
            return fn()
        except ClientError as e:
            code = _ctap_code(e)
            if code == CtapError.ERR.UV_INVALID:
                left = ClientPin(ctap).get_uv_retries()
                print(f"  指紋比對失敗，還可再試 {left} 次。")
                if left:
                    print("  請把手指完全移開...")
                    time.sleep(1.5)
                continue
            if code == CtapError.ERR.UV_BLOCKED:
                print("  指紋已鎖定，改用 PIN。輸入正確 PIN 會解除指紋鎖定。")
                continue
            raise


def step_make_credential(client, ctap):
    print("\n[4] 建立測試憑證（啟用 prf / hmac-secret）")
    print("  這一步會要求輸入 PIN，並按一次指紋。")
    options = PublicKeyCredentialCreationOptions(
        rp=PublicKeyCredentialRpEntity(id=RP_ID, name="Secure Cloud Storage"),
        user=PublicKeyCredentialUserEntity(id=os.urandom(16), name="spike-test", display_name="spike-test"),
        challenge=os.urandom(32),
        pub_key_cred_params=[PublicKeyCredentialParameters(type=PublicKeyCredentialType.PUBLIC_KEY, alg=-7)],
        extensions={"prf": {}},
        authenticator_selection={"userVerification": "required", "residentKey": "discouraged"},
    )
    result = with_uv_retry(ctap, lambda: client.make_credential(options))
    cred_id = result.response.attestation_object.auth_data.credential_data.credential_id
    flags = result.response.attestation_object.auth_data.flags
    ext = result.client_extension_results
    prf_enabled = bool(getattr(ext, "prf", None) and ext.prf.enabled)
    print(f"  credential_id = {cred_id.hex()[:32]}...  (len {len(cred_id)})")
    print(f"  flags: UP={bool(flags & 0x01)} UV={bool(flags & 0x04)}")
    if not prf_enabled:
        fail("憑證建立成功，但 prf/hmac-secret 未啟用。")
    ok("憑證建立成功且 hmac-secret 已啟用")
    return cred_id


def derive_secret(client, ctap, cred_id, salt):
    options = PublicKeyCredentialRequestOptions(
        challenge=os.urandom(32),
        rp_id=RP_ID,
        allow_credentials=[PublicKeyCredentialDescriptor(type=PublicKeyCredentialType.PUBLIC_KEY, id=cred_id)],
        user_verification=UserVerificationRequirement.REQUIRED,
        extensions={"prf": {"eval": {"first": salt}}},
    )
    sel = with_uv_retry(ctap, lambda: client.get_assertion(options))
    res = sel.get_response(0)
    flags = res.response.authenticator_data.flags
    if not (flags & 0x04):
        fail("斷言的 UV 旗標為 0：金鑰沒有做使用者驗證，Server 端必須拒絕這種斷言。")
    prf = res.client_extension_results.prf
    if not prf or not prf.results or not prf.results.first:
        fail("斷言沒有回傳 prf 結果。")
    return bytes(prf.results.first), res.response.authenticator_data.counter


def step_hmac_secret(client, ctap, cred_id):
    print("\n[5] 驗證秘密值：同 salt 兩次相同、換 salt 不同（會按指紋三次）")
    salt_a = os.urandom(32)
    salt_b = os.urandom(32)
    print("  第一次（salt A）")
    s1, c1 = derive_secret(client, ctap, cred_id, salt_a)
    print(f"    secret = {s1.hex()[:16]}...  counter={c1}")
    print("  第二次（salt A）")
    s2, c2 = derive_secret(client, ctap, cred_id, salt_a)
    print(f"    secret = {s2.hex()[:16]}...  counter={c2}")
    print("  第三次（salt B）")
    s3, c3 = derive_secret(client, ctap, cred_id, salt_b)
    print(f"    secret = {s3.hex()[:16]}...  counter={c3}")
    if s1 != s2:
        fail("同 salt 兩次秘密值不同！")
    ok("同 salt 兩次秘密值相同（32 bytes）")
    if s1 == s3:
        fail("換 salt 後秘密值竟然相同！")
    ok("換 salt 後秘密值不同")
    if not (c1 < c2 < c3):
        print("  [WARN] 簽章計數器沒有遞增，Server 端無法靠計數器防複製。")
    else:
        ok("簽章計數器遞增")


def step_wrong_pin(ctap):
    print("\n[6] 錯 PIN 回報測試（故意輸錯一次）")
    client_pin = ClientPin(ctap)
    before = client_pin.get_pin_retries()
    print(f"  測試前剩餘次數：{before}")
    try:
        client_pin.get_pin_token("0000wrong", ClientPin.PERMISSION.GET_ASSERTION, RP_ID)
        print("  [WARN] 錯 PIN 竟然通過？")
    except CtapError as e:
        print(f"  金鑰回報：{e.code.name}")
    after = client_pin.get_pin_retries()
    print(f"  測試後剩餘次數：{after}")
    print("  提示：連續錯 3 次要拔插金鑰才能再試；累計錯 8 次會鎖死，只能 reset。")
    print("  現在請用正確 PIN 做一次任意操作（例如重跑本腳本）把計數歸零。")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只讀能力，不需要 PIN 或觸碰")
    ap.add_argument("--wrong-pin-test", action="store_true", help="最後故意輸錯一次 PIN 觀察回報")
    ap.add_argument("--enroll-more", action="store_true", help="再登錄一枚指紋（同一根手指再登一次可提高辨識率），然後結束")
    args = ap.parse_args()

    dev = get_device()
    ctap = Ctap2(dev)
    has_pin, has_bio = step_check(ctap)
    if args.check:
        print("\n只做能力檢查，結束。")
        return
    if args.enroll_more:
        step_enroll_fingerprint(ctap, getpass("\n登錄指紋需要 PIN，請輸入 PIN："))
        print("完成。金鑰最多可存 5 枚指紋樣板。")
        return

    pin = None
    if not has_pin:
        pin = step_set_pin(ctap)
    if not has_bio:
        if pin is None:
            pin = getpass("\n登錄指紋需要 PIN，請輸入 PIN：")
        step_enroll_fingerprint(ctap, pin)
    del pin

    client = make_client(dev, ctap)
    cred_id = step_make_credential(client, ctap)
    step_hmac_secret(client, ctap, cred_id)

    if args.wrong_pin_test:
        step_wrong_pin(ctap)

    print("\n階段 0 驗證全部通過，可以進入階段 1（fido_helper.py + FidoProvider）。")


if __name__ == "__main__":
    main()
