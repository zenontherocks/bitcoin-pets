# AI Development Risk Assessment

This document evaluates the real risks of using AI-assisted autonomous development (auto-merge `claude/*` branches, no manual code review) for this specific project.

---

## Risk 1: The Black Box Trap — HIGH SEVERITY

**What it is:** AI merges and deploys code you haven't read. When something breaks in production, you have no context for why.

**Why it's elevated here:** This project processes real Bitcoin transactions. A bug in payment confirmation logic (`handleOrderCheck`), the order expiry cron, or BTC address handling doesn't just create a bad user experience — it creates a financial failure mode. The auto-merge workflow (`auto-merge.yml`) deploys `claude/*` branches directly to production with no human review step.

**Mitigation:**
- Mark the Bitcoin payment functions as a protected zone in `src/worker.js` with a comment block requiring human review before changes merge
- Do a quick scan of any PR that touches `handleOrderCheck`, `handleCreateOrder`, or the cron handler before approving it

---

## Risk 2: Logic Duplication — MEDIUM SEVERITY

**What it is:** Two different Claude sessions solve the same problem in two different ways, because Claude in session B didn't see the implementation from session A.

**Why it applies here:** There's no bundler or module system to flag duplicate code. Utility logic (BTC amount formatting, fetch error handling, date display) can silently accumulate across `src/worker.js` and the HTML files. The golden rules in `PROJECT_ARCH.md` help, but only if Claude reads that file at the start of each session — which `CLAUDE.md` enforces, but is worth verifying is working.

**Mitigation:**
- Keep `PROJECT_ARCH.md` updated with any reusable patterns Claude introduces
- The weekly commit history scan the other AI recommended is practical: look at the file diff list, not the code itself

---

## Risk 3: SQL Injection Surface — REAL RISK (missed by generic advice)

**What it is:** `src/worker.js` uses D1's parameterized query API (`db.prepare(...).bind(...)`), which is safe. But auto-merged Claude code gets no review, and a single session that uses string-concatenated SQL instead of `?` placeholders would go undetected.

**Mitigation:**
- Add a CI grep step that fails if it finds patterns like `` `SELECT ... ${`` or `"INSERT ... " +` near SQL keywords in `worker.js`
- This is a one-liner in the auto-merge workflow

---

## Risk 4: worker.js Monolith Growth — REAL RISK (missed by generic advice)

**What it is:** Every feature gets appended to a single file. Without any size check, `worker.js` will grow to a point where production debugging becomes very difficult.

**Mitigation:**
- Set a soft line-count threshold (e.g., 1,500 lines) as a CI warning
- If hit, spend one session reorganizing before adding more features

---

## Risk 5: Dependency Bloat — LOW RISK (overstated by generic advice)

**Why it doesn't really apply here:** There is no `package.json`. There is nowhere to accidentally add npm dependencies. The architecture golden rules explicitly prohibit frameworks and external libraries. This risk is structurally mitigated by how the project is built.

---

## Recommended CI Addition

Add this step to `.github/workflows/auto-merge.yml` before the merge step:

```yaml
- name: Check for SQL injection patterns
  run: |
    if grep -Pn '`(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE).*\$\{' src/worker.js; then
      echo "Possible string-interpolated SQL detected. Use parameterized queries."
      exit 1
    fi

- name: Lint JavaScript
  run: npx --yes eslint src/worker.js --no-eslintrc --rule '{"no-undef": "warn"}'
```

---

## Summary

| Risk | Severity | Applies Here? |
|---|---|---|
| Black Box Trap (payment logic) | High | Yes — elevated by Bitcoin |
| Logic Duplication | Medium | Yes |
| SQL Injection surface | Medium | Yes |
| worker.js monolith growth | Medium | Yes |
| Dependency bloat | Low | No — architecture prevents it |
