import { randomBytes } from "crypto";

/** A random value for the webview's content security policy (scripts run only with this nonce). */
export function getNonce(): string {
    return randomBytes(24).toString("base64url");
}
