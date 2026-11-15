# OSIRIS assist hardening patch

Apply inside a clone of https://github.com/simplifaisoul/osiris:

    git apply --ignore-whitespace path\to\0001-assist-provenance-gate.patch
    npx vitest run src/lib/oi/assist

Expected: 2 test files, 154 tests passing (31 existing + 123 new).
