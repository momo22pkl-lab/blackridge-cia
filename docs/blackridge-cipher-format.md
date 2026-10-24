# BLACKRIDGE CIPHER format

The browser-only BLACKRIDGE CIPHER uses Web Crypto API AES-256-GCM. It does not use a substitution cipher: the custom glyphs are only a reversible text encoding of the authenticated ciphertext and its public parameters.

## Encryption parameters

- Key derivation: PBKDF2 with HMAC-SHA-256, 600,000 iterations, and the passphrase entered by the user.
- Salt: 16 cryptographically random bytes, generated independently for every message.
- Cipher: AES-256-GCM with a 12-byte cryptographically random IV and a 128-bit authentication tag.
- The passphrase and plaintext are kept in browser memory while the user operates the page. The cipher module does not persist them or send them to an API.

## Text format

Every message starts with the exact header:

```text
BLACKRIDGE-CIPHER/1
```

The next lines contain the payload encoded with this 32-symbol alphabet:

```text
◈◉◇◆◐◑◒◓◔◕◖◗⊙⊚⊛⊜⊝⊞⊟⊠⊡⋄⋇⋈⋉⋊⋋⋌⋍⌁⌖⌘
```

The symbols encode successive five-bit groups of bytes. Whitespace is added only for readability and is ignored when decoding. The final group is zero-padded to five bits; the decoder checks that padding is canonical.

After decoding, the byte sequence is:

| Offset | Length | Contents |
| --- | ---: | --- |
| 0 | 1 byte | Format version (`0x01`) |
| 1 | 16 bytes | PBKDF2 salt |
| 17 | 12 bytes | AES-GCM IV |
| 29 | remaining bytes | AES-GCM ciphertext followed by its 16-byte authentication tag |

The version currently implies PBKDF2-HMAC-SHA-256, 600,000 iterations, and AES-256-GCM. Unknown versions and malformed symbol strings are rejected. A wrong passphrase and a modified ciphertext both fail GCM authentication and return the same user-facing error.

## Operational notes

Share the passphrase separately from the cipher text. Anyone with both can decrypt the message. A strong, unique passphrase matters; PBKDF2 slows guessing but cannot make a weak passphrase strong. There is no password recovery. The application must be opened in a browser with Web Crypto support over HTTPS or localhost. A compromised device, malicious browser extension, or compromised page can still expose text or the passphrase while in use.
