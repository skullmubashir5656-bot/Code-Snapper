# CodeSnapper Self-Healing Debugger Rule

## Command Trigger
- **Command**: `/debugger`
- When the user calls `/debugger` or reports an issue with `/debugger`, invoke the self-healing debugging workflow.

## Core Rules & Protocol
1. **Always Read `brain.md` First**: Before diagnosing or modifying any code, consult `brain.md` as the ultimate source of truth.
2. **Root Cause Analysis & Diagnosis Reporting**:
   - Trace and read the real code in `server.js`, `app.js`, `index.html`, `styles.css`, etc.
   - Accurately identify the failure point without guessing.
   - Present the diagnosis directly to the user: explain the exact error, affected files/lines, and root cause.
   - Wait for the user to provide the fix direction.
3. **Permission Budget**:
   - Limit asking for user permission to at most **3 times** per conversation session.
   - Perform all other research, testing, syntax checking, and self-healing fixes autonomously.
4. **2-Failure Circuit Breaker**:
   - When a fix attempt fails twice for the same issue, **STOP** trying variations of the same approach.
   - Step back and question whether the root cause diagnosis itself was wrong.
   - Restart the diagnosis from scratch with fresh, unconstrained assumptions.
   - Present the fresh diagnosis to the user for a new fix direction.
5. **Implementation & Verification**:
   - Implement solutions aligned with `brain.md` and user directives.
   - Always run verification tests using node or scratch scripts before marking a task complete.
   - Report back with clean file links, line references, and test outputs.
