# Governance

Ratchet is maintained by one person. Deimos LLC, which publishes it, is three;
the other two do not hold the credentials or the release path, so for anyone
depending on Ratchet the number that matters is one. This document says that
plainly, says what it means, and says what happens if that person stops. A governance document that described committees this project does not
have would be worse than none, because the point of it is to let you predict
what will actually happen.

## Roles and responsibilities

There is currently one role.

### Maintainer

Held by **[@thearchitect0x-glitch](https://github.com/thearchitect0x-glitch)**,
operating as Deimos LLC.

Responsible for:

- **Deciding what gets merged.** Reviewing and accepting or declining proposed
  changes, and saying why when the answer is no.
- **Releases.** Tagging, writing release notes, publishing to npm, deploying.
- **Security reports.** Receiving them at security@ratchetgate.com, acknowledging
  within 72 hours, assessing within 7 days, and coordinating disclosure — see
  [SECURITY.md](SECURITY.md).
- **Conduct reports.** Receiving them at conduct@ratchetgate.com — see
  [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- **The invariants.** Keeping true the properties in [CLAUDE.md](CLAUDE.md) that
  the product's safety rests on: at-most-once initiation enforced by the
  database, no claim of exactly-once, an unknown outcome staying unknown, and
  never storing a raw payload.
- **Operating the hosted service** at ratchetgate.com, including the on-call for it.

### Contributor

Anyone who opens an issue or a pull request. No permissions are required and none
are granted; contributions are reviewed by the maintainer. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## How decisions are made

The maintainer decides, in the open.

- **Technical direction** is proposed in a GitHub issue before large work starts,
  so nobody spends a weekend on something that will not be merged.
- **Disagreements** are settled on the technical argument in the issue or pull
  request thread. Where the maintainer overrules a contributor, the reason is
  written down in that thread rather than delivered privately.
- **The invariants above are not decided case by case.** They are the product. A
  change that erodes one is declined even where it is otherwise good, and
  [CLAUDE.md](CLAUDE.md) explains each so the reasoning is inspectable rather
  than personal.
- **Roadmap** is in [ROADMAP.md](ROADMAP.md), including what the project has
  decided *not* to do.

This model will not survive a second full-time contributor, and it is not meant
to. If one arrives, this document changes with them rather than being imposed.

## Continuity

Ratchet is Apache-2.0 licensed and the full history is public, so the code
cannot be withdrawn. What follows is about the things a licence does not cover.

### If the maintainer becomes unavailable

**The repository is not the risk — the accounts are.** These are the assets a
successor needs, and the state of each:

| Asset | Where | Recoverable by a successor? |
|---|---|---|
| Source and history | GitHub, plus every clone | Yes — public, Apache-2.0 |
| npm package `ratchet-mcp` | npm registry | Needs npm account access |
| Domain `ratchetgate.com` | Registrar | Needs registrar access |
| Hosted service | Fly.io | Needs Fly account access |
| Database and backups | Fly Postgres + off-site object storage | Needs both, plus `AUTH_SECRET` |

**Documented recovery procedure:** [docs/handoff/RECOVERY.md](docs/handoff/RECOVERY.md)
lists every credential, where it lives, and what breaks without it. It is written
for somebody who is not the author.

**Honest limitation, stated because pretending otherwise would be the failure
this criterion exists to prevent:** there is currently no second person holding
those credentials. A successor with account access could continue the project
immediately; without it they could fork the code and run their own instance, but
could not take over the published package, the domain, or the hosted service.
Establishing that second holder is tracked in [ROADMAP.md](ROADMAP.md).

### If the project is abandoned

The licence permits anyone to fork and continue it. The design deliberately
avoids lock-in: Ratchet holds no vendor credentials, performs no side effects,
and every decision it has made is exportable as a signed receipt, so a customer
leaving takes their record with them.

## Changing this document

By pull request, like anything else.
