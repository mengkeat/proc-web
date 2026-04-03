# Agent Guidelines for proc-web

## Known Pitfalls

### JavaScript variable ordering in inline HTML template (TDZ errors)

The entire client-side UI is defined as a template literal string (`const HTML = \`...\``) in `server.ts`. The `<script>` block inside this template is a single inline script — if any runtime error occurs, the **entire script aborts** and no subsequent functions (like `switchTab`, `toggleSearch`, etc.) will be defined.

**The recurring bug:** `let currentTab` was declared *after* code that called functions referencing `currentTab`. Because `let` has a temporal dead zone (TDZ), accessing it before declaration throws `ReferenceError`, killing the script silently. This made tab switching buttons non-functional.

**Why it keeps happening:** New features add functions (e.g., `sendResize()`) that reference `currentTab` outside a `try/catch`, and get placed above the `let currentTab = 'stdout'` declaration.

**Rules to follow:**
1. Always declare variables (`let`/`const`) **before** any function that references them, and before any immediate call sites.
2. Never rely on `try/catch` to silently swallow TDZ errors — fix the ordering instead.
3. When adding new functions to the inline `<script>`, check that all referenced variables are declared above.
4. Test tab switching (STDOUT → STDERR → COMBINED) after any change to the client-side JavaScript.
