<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Deimos AI LLC -->

# Open source policy

How Deimos AI LLC consumes open source software, complies with its licences,
responds to vulnerabilities in it, and contributes back.

This document is the policy required by **ISO/IEC 5230** (OpenChain licence
compliance) §3.1.1 and **ISO/IEC 18974** (OpenChain security assurance) §4.1.1.
The conformance mapping is at the end.

---

## 1. Scope

**Program scope** *(5230 §3.1.4, 18974 §4.1.4)*

This program covers **all software supplied by Deimos AI LLC**, which at the time of
writing is Ratchet: the control plane, the worker, the published `ratchet-mcp`
bridge, and the website. It covers open source that Deimos AI LLC consumes as a
dependency and open source that Deimos AI LLC publishes.

It does not cover software Deimos AI LLC neither ships nor depends on — developer
tooling installed on a workstation and never distributed is out of scope.

## 2. Roles, competence and awareness

**Roles** *(5230 §3.1.2, §3.2.2; 18974 §4.1.2, §4.2.2)*

Deimos AI LLC is **three people**. **One of them holds every role in this
program**: policy owner, licence reviewer, security responder, and release
approver. [`GOVERNANCE.md`](../GOVERNANCE.md) records this and what a successor
would need.

The distinction is load-bearing for this requirement, so it is drawn rather than
blurred: the company is not one person, but the open source program is, and the
program is what the specification asks about. A program of one satisfies
"communicated internally" and "aware of the policy" trivially, and it satisfies
"adequately staffed" only in the narrow sense that the work currently fits one
person. The bus factor for this program is 1 for its decisions, though no longer
for its continuity: a second partner holds the credentials and admin on the
repository, so the program survives its participant even though it does not
currently share the work.

**Competence.** The role holder's competence is self-assessed on the basis of
having designed and built the software in scope, and is evidenced by the
practices in this document being implemented rather than merely described. No
second person has assessed it, so it is not independently assessed.

**Legal expertise** *(5230 §3.2.2.3)*. **This requires a decision before
certification.** Deimos AI LLC has no retained counsel. Conformance requires
identifying legal expertise — internal or external — available for licence
compliance questions. Until named, this requirement is not met.

## 3. Licence obligations

**Reviewing obligations** *(5230 §3.1.5)*

Every dependency's licence is reviewed before it is introduced, and the review
asks three questions: what the licence obliges us to do when we distribute, what
it restricts, and what it grants.

**The criterion:** a distributed dependency must carry an OSI-approved
permissive licence with no reciprocal obligation on distribution. A copyleft
licence in a distributed component is refused by default and requires explicit
approval, because Ratchet ships as a container image and an npm package, and
reciprocal obligations would extend to code we do not intend to publish under
those terms.

**This is enforced, not merely stated.** `bash scripts/check-licenses.sh` runs
in CI and fails the build on a production dependency outside the allowlist. The
allowlist lives in that script, so adding a licence is a commit somebody signs
rather than something that happens silently at install time.

The licences currently present in the production tree, all within policy:
MIT, ISC, BlueOak-1.0.0, BSD-3-Clause, BSD-2-Clause.

Writing this section is what found BlueOak-1.0.0. Five packages
(`glob`, `lru-cache`, `minimatch`, `minipass`, `path-scurry`) use it, and an
earlier draft of this policy listed only MIT, Apache-2.0, BSD and ISC — so the
policy as first written did not describe the software it governed. It is an
OSI-approved permissive licence and is accepted; the point is that the gap was
found by applying the policy rather than by reading it.

Development dependencies are out of scope: they are not distributed, so their
licences impose no obligation on what we ship. That is why the check is scoped
to `--production`.

**Handling common use cases** *(5230 §3.3.2)*

- **Distributed as-is, unmodified** — retain the licence text and attribution;
  satisfied by the SBOM and by preserving the dependency tree intact.
- **Modified** — Deimos AI LLC does not fork or vendor dependencies. Nothing is
  modified, so no modification obligations arise. If that changes, the fork is
  approved case by case and its licence obligations are re-reviewed.
- **Own code** — published under Apache-2.0, with a per-file `SPDX-License-Identifier`
  and copyright notice. The repository is [REUSE 3.3](https://reuse.software/)
  compliant and this is checked in CI, so a new file without licensing
  information fails the build.

## 4. Bill of materials

**Creating and managing it** *(5230 §3.3.1, 18974 §4.3.1)*

Every release carries a software bill of materials in **SPDX 2.3** and
**CycloneDX 1.5**, generated by `npm sbom` from the committed lockfile and
attached to the GitHub release by
[`.github/workflows/publish.yml`](../.github/workflows/publish.yml).

The bill is generated *after* the release tag's signature is verified, so it
describes a commit somebody vouched for. Records are the release assets
themselves, which persist for the life of the repository.

## 5. Compliance artifacts

**Creation, delivery and archiving** *(5230 §3.4.1)*

The artifacts distributed with the supplied software are: the `LICENSE` file,
the `LICENSES/` directory in the REUSE layout, per-file licence and copyright
headers, and the SBOM attached to each release.

They are archived by being part of a public git repository with signed,
GitHub-verified release tags. That archive is intended to outlive any individual
release and is not deleted on supersession.

## 6. Contributions to open source

**Contribution policy** *(5230 §3.5.1)*

Deimos AI LLC **permits and publishes** open source contributions.

- Software Deimos AI LLC publishes is licensed **Apache-2.0**.
- Contributions *to* Deimos AI LLC projects require a `Signed-off-by` line
  certifying the [Developer Certificate of Origin](https://developercertificate.org/),
  enforced by [`.github/workflows/dco.yml`](../.github/workflows/dco.yml).
- Contributions *from* Deimos AI LLC to third-party projects follow that project's
  own contribution terms, and must not include material Deimos AI LLC does not have
  the right to submit.
- The requirements for an acceptable contribution are in
  [`CONTRIBUTING.md`](../CONTRIBUTING.md) and [`docs/CODE_REVIEW.md`](CODE_REVIEW.md).

## 7. Security assurance

**Standard practice implementation** *(18974 §4.1.5, §4.3.2)*

How known vulnerabilities in open source components are identified, assessed and
remediated:

- **Identification.** Dependabot monitors dependencies and GitHub Actions.
  `npm audit --omit=dev` gates every CI run and distinguishes a registry outage
  from a finding, so a check that could not run never reports clean. CodeQL runs
  on every push and weekly.
- **Assessment.** A finding in a production dependency blocks the build. A
  finding in a development dependency does not, because a vulnerable test tool
  is not a vulnerable product — that distinction is deliberate and is the
  reason the audit is scoped with `--omit=dev`.
- **Remediation.** Updates arrive as pull requests. Those crossing a major
  version are evaluated in an isolated worktree against the full test suite
  before merge, not merged on a green checkmark.
- **Response to reports.** [`SECURITY.md`](../SECURITY.md) commits to
  acknowledgement within 72 hours and assessment within 7 days. Private
  reporting is available by email and through GitHub private vulnerability
  reporting.

The wider secure development practices are documented separately in
[`docs/SSDF.md`](SSDF.md), mapped to NIST SP 800-218.

## 8. Third-party inquiries

**Public access** *(5230 §3.2.1, 18974 §4.2.1)*

Anyone may raise an open source licence compliance or security question about
software supplied by Deimos AI LLC:

- **Licence compliance** — open an issue at
  <https://github.com/thearchitect0x-glitch/ratchet/issues>. Publicly visible,
  searchable, and permanently addressable.
- **Security** — `security@ratchetgate.com`, or GitHub private vulnerability
  reporting. See [`SECURITY.md`](../SECURITY.md).

**Internal procedure for responding.** An inquiry is acknowledged within 72
hours. Licence questions are answered from this policy and the release SBOM. If
an inquiry identifies a non-compliant case, the response is: stop distributing
the affected release if the exposure is ongoing, determine the obligation that
was missed, correct it, and reply with what was found and what was done. A
correction is not treated as complete until the artifact a third party can
download reflects it.

---

## Conformance mapping

**ISO/IEC 5230:2020 (OpenChain Specification 2.1)**

| Requirement | Where | Status |
|---|---|---|
| 3.1.1 Policy | This document | Met |
| 3.1.2 Competence | §2 | Met, self-assessed — one participant |
| 3.1.3 Awareness | §2 | Met trivially — one participant |
| 3.1.4 Program scope | §1 | Met |
| 3.1.5 Licence obligations | §3 | Met |
| 3.2.1 Access | §8 | Met |
| 3.2.2 Effectively resourced | §2 | **Not met** — legal expertise not identified |
| 3.3.1 Bill of materials | §4 | Met |
| 3.3.2 Licence compliance | §3 | Met |
| 3.4.1 Compliance artifacts | §5 | Met |
| 3.5.1 Contributions | §6 | Met |
| 3.6.1 Conformance | — | Pending the above |
| 3.6.2 Duration | — | 18 months from validation |

**ISO/IEC 18974 (OpenChain Security Assurance)**

| Requirement | Where | Status |
|---|---|---|
| 4.1.1 Policy | This document | Met |
| 4.1.2 Competence | §2 | Met, self-assessed |
| 4.1.3 Awareness | §2 | Met trivially |
| 4.1.4 Program scope | §1 | Met |
| 4.1.5 Standard practice implementation | §7 | Met |
| 4.2.1 Access | §8 | Met |
| 4.2.2 Effectively resourced | §2 | **Not met** — see 5230 §3.2.2 |
| 4.3.1 Software bill of materials | §4 | Met |
| 4.3.2 Security assurance | §7 | Met |
| 4.4.1 Completeness | — | Pending the above |
| 4.4.2 Duration | — | 18 months from validation |

**One requirement is unmet, in both specifications**, and it is the same one:
§3.2.2.3 / §4.2.2 asks the organization to identify legal expertise available
for open source compliance matters. Deimos AI LLC has none retained. That is a
decision for the organization, not a document to write, and conformance should
not be submitted until it is made.

---

*Reviewed: 2026-09-05. This policy is reviewed at least annually, or sooner on a
material change to what Deimos AI LLC supplies.*
