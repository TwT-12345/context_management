# Vendored YAML parser

- Package: `js-yaml@4.1.1`, https://www.npmjs.com/package/js-yaml/v/4.1.1
- Upstream: https://github.com/nodeca/js-yaml
- Source: unmodified `dist/js-yaml.mjs` from the published npm tarball.
- License: MIT; see `LICENSE.js-yaml`.
- Parser SHA-256: `efbc45850bf15f0c8ee3434983f512be656002d7507dc292c7ade4449b5d57fa`.
- Tarball SHA-256: `948181607d4fb62dde7b9e04a62d89b20e62cd0c5659ceb711bc31768d00436f`.

The plugin uses CORE_SCHEMA, rejects duplicate keys and non-JSON/cyclic data,
and never evaluates custom JavaScript tags. This standalone ESM file requires
no runtime npm install, network access or platform-specific binary.
