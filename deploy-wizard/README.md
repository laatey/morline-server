# Deploy wizard

Runs the Morline deploy flow (package → S3 → SSM → wait) in one command.

This folder is **standalone**: it has no dependencies, nothing else in the project imports it,
and it never modifies the project. It is left out of the package it uploads. To remove it,
delete the `deploy-wizard/` folder.

## Use

```powershell
node deploy-wizard/wizard.mjs              # deploy the current commit (asks first)
node deploy-wizard/wizard.mjs --dry-run    # package only; shows the plan, uploads nothing
node deploy-wizard/wizard.mjs --rollback   # restore morline-server-old and rebuild
node deploy-wizard/wizard.mjs --yes        # no questions
node deploy-wizard/wizard.mjs --no-wait    # send and return
node deploy-wizard/wizard.mjs --help
```

Needs Node 18+, `git`, and the AWS CLI on your PATH.

## What it does

1. Checks `git` and `aws`; shows the commit, and **warns about uncommitted changes**
   (`git archive` only packages `HEAD`, so those are not deployed).
2. Checks the AWS session; offers to run `aws login --profile morline` if it has expired.
3. Checks the instance is online in SSM.
4. `git archive` with the required `morline-server/` prefix.
5. Uploads the versioned copy and the canonical `morline-server-source.tar.gz`.
6. Sends the same shell script as the manual flow through SSM.
7. Polls until it finishes (no fixed sleep), prints the server output as it arrives, and
   optionally checks `healthUrl`.

## Settings

`config.json`: profile, region, bucket, instance id, deploy path, compose file.
Set `healthUrl` (e.g. your API's `/health`) to have the wizard confirm the site answers.

## If a deploy fails

The old version is kept at `/opt/morline/morline-server-old`. Run `--rollback` to put it back.
(It is not restored automatically.)
