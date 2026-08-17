# Security Policy

## Supported versions

d1-eloquent is currently in **public beta** (`0.1.0-beta.x`). Security fixes are applied
to the latest published beta. Once a stable `0.1.0` ships, this policy will be updated
with a support matrix.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately using GitHub's built-in **[Report a vulnerability](https://github.com/Orphnet/d1-eloquent/security/advisories/new)**
flow (repository → **Security** tab → **Report a vulnerability**). This opens a private
advisory visible only to you and the maintainers.

Please include:

- A description of the issue and its impact.
- Steps to reproduce (a minimal Worker snippet or failing test is ideal).
- The version / commit you tested against.

## What to expect

- We aim to acknowledge a report within a few days.
- We'll work with you on a fix and coordinate a disclosure timeline before any public
  write-up.
- With your permission, we'll credit you in the release notes.

## Scope notes

d1-eloquent builds SQL for Cloudflare D1. Of particular interest:

- Identifier / column-name handling (the library exposes `safeIdent` / `safeIdentList`
  guards for untrusted identifiers — misuse or bypass reports are welcome).
- Any path where user-controlled input could reach raw SQL outside a bound parameter.
