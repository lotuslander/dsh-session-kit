# Changelog

## [1.0.0] - 2026-11-02

### Added

- 6 tools: `session_list`, `session_search`, `session_read`, `send_message`, `broadcast`, `session_audit`
- Cross-session full-text search reusing the host `sessionQuery.searchSessions()` (SQLite FTS5)
- Global broadcast with preview-by-default, explicit confirm, target cap, failure isolation
- Session addressing: full id, unique prefix, exact title, title substring, cwd fragment, self
- Operation audit log
- Zero external dependencies
- 41 functional tests + 5 performance tests

### Fixed

- Tool declarations now use `output: { schema, render }` instead of `returns`
  (was rejected by DSH with `must declare output`)
- Engine error results are now thrown by the tool layer instead of silently returned

### Known issues

- Full-text search requires enabling the session-query index in the profile patch
  (`openAt: never` is the DSH default) — see README
