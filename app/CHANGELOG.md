# Changelog

All notable changes to this project will be documented here.  
This project follows [Semantic Versioning](https://semver.org/).

---

## [0.1.2] - 2025-08-18
### Added
- Colorized CLI usage/help output for better readability.
- Multiple ways to end JSON input interactively:
  - `:end` sentinel line  
  - closing code fences (```)  
  - blank line after valid JSON  
  - EOF (Ctrl+D / Ctrl+Z) still supported where terminals allow
- Usage instructions shown automatically after banner.

### Fixed
- Improved error messages.
- Correct interface/type naming from JSON keys.

---

## [0.1.1] - 2025-08-17
### Added
- More descriptive error handling.
- ASCII dinosaur banner cleanup.
- Support for nulls → `any`.

### Fixed
- Proper export of `main()` so CLI entry works correctly.

---

## [0.1.0] - 2025-08-16
### Initial Release
- **typasaur CLI** published to npm 🎉  
- Paste JSON or load from file → auto-generate TypeScript models.  
- ASCII art banner + colored output.  
- Generates `.ts` file with type-safe models from JSON input.  