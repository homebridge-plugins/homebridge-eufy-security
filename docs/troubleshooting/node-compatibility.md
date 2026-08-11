# Node.js compatibility

V5 requires Node.js 24.5.0 or newer. This is a package engine requirement, not a recommendation.

```bash
node --version
node -p "process.versions.openssl"
```

Historical V4 releases encountered livestream failures after upstream OpenSSL changes disabled legacy
RSA PKCS#1 v1.5 implicit rejection behavior in several Node release lines. Node 24.5.0 restored the
required compatibility mechanism. V5 does not support downgrading to Node 18 or 20 as a workaround.

See [Node.js CVE-2023-46809](https://nodejs.org/en/blog/vulnerability/february-2024-security-releases-2)
and the [Node.js tracking discussion](https://github.com/nodejs/node/issues/55628) for upstream context.
