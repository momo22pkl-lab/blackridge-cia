# BLACKRIDGE CIPHER format

The browser-only BLACKRIDGE CIPHER uses Web Crypto API AES-256-GCM. It does not use a substitution cipher: the custom glyphs are only a reversible text encoding of the authenticated ciphertext and its public parameters.

## Encryption parameters

- Key derivation: PBKDF2 with HMAC-SHA-256, 600,000 iterations, and the passphrase entered by the user.
- Salt: 16 cryptographically random bytes, generated independently for every message.
- Cipher: AES-256-GCM with a 12-byte cryptographically random IV and a 128-bit authentication tag.
- The passphrase and plaintext are kept in browser memory while the user operates the page. The cipher module does not persist them or send them to an API.

## Symbol display

New messages are shown as grouped glyphs only; the format prefix is not included in the copied output. The version remains in byte 0 of the encrypted package. For backwards compatibility, the decoder still accepts older copied text that begins with `BLACKRIDGE-CIPHER/1`. An unknown textual version is rejected.

The payload uses this 32-symbol alphabet:

`◈◉◇◆◐◑◒◓◔◕◖◗⊙⊚⊛⊜⊝⊞⊟⊠⊡⋄⋇⋈⋉⋊⋋⋌⋍⌁⌖⌘`

The symbols encode successive five-bit groups of bytes. Whitespace is added only for readability and is ignored when decoding. The final group is zero-padded to five bits; the decoder checks that padding is canonical.

After decoding, the byte sequence is:

| Offset | Length | Contents |
| --- | ---: | --- |
| 0 | 1 byte | Format version (`0x01`) |
| 1 | 16 bytes | PBKDF2 salt |
| 17 | 12 bytes | AES-GCM IV |
| 29 | remaining bytes | AES-GCM ciphertext followed by its 16-byte authentication tag |

The version currently implies PBKDF2-HMAC-SHA-256, 600,000 iterations, and AES-256-GCM. Unknown versions and malformed symbol strings are rejected. A wrong passphrase and a modified ciphertext both fail GCM authentication and return the same user-facing error.

## SCRIBBLE PNG display

The PNG is a real carrier for the same encrypted package, not decorative output and not a container for hidden text. Its black pixels form the background; one connected white path encodes each four-bit nibble by the height of its stroke in a cell. Rows join in alternating directions, so the lines remain continuous. The decoder reads those pixels directly; it does not use OCR, image metadata, or a side-channel.

The path carries a binary frame before the encrypted package:

| Offset | Length | Contents |
| --- | ---: | --- |
| 0 | 4 bytes | Image signature (`BRSC`) |
| 4 | 1 byte | Image-frame version (`0x01`) |
| 5 | 4 bytes | Encrypted package length, big-endian |
| 9 | 4 bytes | CRC-32 of the package, for accidental-damage detection |
| 13 | remaining bytes | The same versioned AES-GCM package described above |

The decoder validates dimensions, signature, frame version, length, zero padding, and CRC before attempting AES-GCM authentication. CRC-32 is only a corruption check; the GCM authentication tag is what prevents modified data or an incorrect passphrase from yielding plaintext. To avoid guessing at arbitrary or edited images, uploads must be PNGs matching the generated line layout. Do not crop or edit the exported image.

The image renderer is capped at 12 million pixels. If a message exceeds that image capacity, use SYMBOL MODE or shorten the message; encryption parameters and strength do not change between modes.

## Operational notes

Share the passphrase separately from the cipher text. Anyone with both can decrypt the message. A strong, unique passphrase matters; PBKDF2 slows guessing but cannot make a weak passphrase strong. There is no password recovery. The application must be opened in a browser with Web Crypto support over HTTPS or localhost. A compromised device, malicious browser extension, or compromised page can still expose text or the passphrase while in use.
