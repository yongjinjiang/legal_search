# Security Policy

## Supported Versions

Legal Retrieval Explorer is a personally maintained research prototype. Security
fixes target the latest code on `main` and the current official deployment at
[legal-search-eight.vercel.app](https://legal-search-eight.vercel.app/).
Older commits, historical releases, forks, and outdated self-hosted deployments
are not maintained for security updates.

## Reporting a Vulnerability

Report suspected security vulnerabilities privately through GitHub. Open this
repository's [Security Advisories](https://github.com/yongjinjiang/legal_search/security/advisories)
page and select **Report a vulnerability**.

Please include:

- The affected page, API endpoint, or component, and the deployment URL or commit.
- Clear reproduction steps and a minimal proof of concept, if available.
- The expected behavior, observed behavior, and potential security impact.

Do not publish exploit details, credentials, or sensitive data in public issues,
pull requests, or discussions. Redact secrets and personal information from
reports and screenshots. Use minimal, non-destructive tests; avoid accessing
other people's data, disrupting the public demo, or triggering excessive paid
provider requests.

## Response and Disclosure

Reports are reviewed on a best-effort basis. This personal project does not
guarantee a fixed response or remediation deadline. The maintainer will use the
private report to request clarification, communicate whether the issue is
accepted, and coordinate a fix or explain why it is not considered a security
vulnerability. Please coordinate public disclosure with the maintainer so that
an accepted issue can be addressed first.

Ordinary bugs, search relevance feedback, and questions about generated summaries
can be reported through public issues, provided they contain no sensitive data
or undisclosed vulnerability details.
