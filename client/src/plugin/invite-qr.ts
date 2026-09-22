import qrcode from "qrcode-generator";

/*!
 * Bundled dependency: QR Code Generator for JavaScript
 * Copyright (c) 2009 Kazuhiko Arase — http://www.d-project.com/
 * Licensed under the MIT license: http://www.opensource.org/licenses/mit-license.php
 * The word 'QR Code' is a registered trademark of DENSO WAVE INCORPORATED.
 */

export const INVITE_ACTION = "telimus";

/** The receiving plugin opens a form; following this link never pairs automatically. */
export function inviteLink(invite: string): string {
  return `obsidian://${INVITE_ACTION}?invite=${encodeURIComponent(invite)}`;
}

/** Encode locally: an invite must never be sent to a QR image service. */
export function inviteQrImage(invite: string): string {
  const code = qrcode(0, "M");
  code.addData(inviteLink(invite), "Byte");
  code.make();
  const svg = code.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
