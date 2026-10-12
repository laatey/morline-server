# Morline server: engineering rules

- Plain Node.js ESM (Node 22+), Express 4, no build step. SQLite through `node:sqlite` via the helpers in `src/db/index.js` (`queryOne`, `queryAll`, `execute`); schema changes go in `src/db/schema.sql`.
- `openapi/openapi.yaml` is the contract. Change a route and its spec entry together, and keep the error shape (`{ code, message, fields, details, requestId }`) by using the helpers in `src/middleware/error-handler.js`.
- Docker is the only runtime for customer workloads: builds and containers go through `src/engine/container-supervisor.js`. Don't reintroduce host-process execution of customer code.
- Canvas edits that need a deploy are recorded as staged changes (`src/services/staged-changes-helper.js`), not applied immediately.
- Secrets come from the environment only. Never add a default value for a key, token or password in `src/config.js`, and document every new variable in `.env.example`.
- New routes that reference a team-owned resource need its kind added to `src/middleware/tenancy.js` (path rule or field) so cross-team access stays blocked.
- Assistant actions run in `src/services/assistant-actions.js`; add a new type there with `apply` and `revert` executors, a diff for the review UI, and a test with the fake GitHub in `test/builder.test.js`. The AI only proposes: never run model output.
- Tests are `node:test` files in `test/`; run `npm test` before shipping. Real AWS identifiers stay out of git (`deploy-wizard/config.json` is ignored).

<!-- BEGIN AWS Agent Toolkit rules -->
# AWS Guidance for the new AWS experience

This user has signed up for the new AWS experience. This experience lets you sign into AWS using a social provider and requires the following additional context.

Where this guidance conflicts with the project's own instructions, the project's instructions take precedence.

## Context
### Terminology:
- Say "project" instead of "account" — a project contains an AWS account and settings for sharing with other collaborators
- Say "team member" instead of "IAM user" — users are invited by email, not created or federated in IAM
- Say "AWS Settings" when referring to management tasks at https://settings.aws.com/ (project management, billing, team members, spend limits). Users view their actual AWS resources in the AWS Management Console.
- Say "selected Region" when referring to the user's Region — not "home Region"
- The user has a managed IAM experience. This includes managed service control policies (SCP) and resource control policies (RCP). They will still need IAM policies for service-to-service access.

### Constraints:
- All Regional resources must be created in the project's selected Region, `eu-north-1`.
- WAF, CloudWatch Logs, and CloudFront global dependencies may use `us-east-1` only where required by the global service.
- MUST NOT attempt cross-Region actions, Lambda@Edge, or CloudFormation StackSets.
- Reduced availability in `eu-north-1`: Amazon Rekognition, Amazon Textract, Amazon Personalize, and AWS App Runner are not available.
- IAM permissions for human access are managed by AWS. Don't assign roles to team members unless absolutely necessary.
- Ask about spend limits if previously working operations suddenly return Access Denied, and direct the user to AWS Settings > Billing.
- Ask whether the user wants to clean up successfully created resources or keep them to reduce cost.
- Before starting a task, check whether a relevant AWS skill is available and prefer its guidance.

### Help level
- help_level (required): LOW, MEDIUM, or HIGH. While a user is building, ask which level they want.
- HIGH: explain each step and why, suggest alternatives, and flag best practices while still executing the user's choice.
<!-- END AWS Agent Toolkit rules -->
