# Security

Please report vulnerabilities privately through [GitHub security advisories](https://github.com/ethan-ab/xscout-jev/security/advisories/new) rather than in a public issue. You will get an answer within a week.

xscout handles API keys (TypeSafe, treg, a Slack webhook). Keep them in `.env` or your scheduler's secret store; `.env` and `data/` are ignored by git.
