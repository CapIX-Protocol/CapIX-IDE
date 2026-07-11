# Security Policy

## Reporting a Vulnerability
- Email: security@capix.network
- Do NOT open a public issue for security vulnerabilities
- Response SLA: 48 hours for acknowledgement, 7 days for initial assessment
- Please include: description, reproduction steps, affected version, potential impact

## Supported Versions
| Version | Supported |
|---------|-----------|
| latest main | Yes (development) |
| tagged releases | Security fixes only |

## Security Features
- Session tokens and API keys stored in VS Code SecretStorage (OS keychain)
- Webview Content Security Policy with per-render nonce
- SSH host-key verification (TOFU + persistent known_hosts)
- API key never passed via terminal environment variables
