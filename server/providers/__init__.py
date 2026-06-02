"""SERVARI personal-world data providers.

Each module is a fail-closed, read-only surface that reads a synthetic seed under
demo-data/ and returns the shape the UI expects. Missing/malformed data degrades
to an honest empty state — never a fabricated row.
"""
