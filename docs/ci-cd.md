# Automatic AWS deployment

The GitHub Actions workflow in `.github/workflows/ci.yml` checks every push and pull request. A successful push to `main` then deploys the `FleetFlow` CDK stack to AWS. Pull requests run checks only. The deployment job uses GitHub OIDC to obtain short-lived AWS credentials; it does not store AWS access keys in GitHub.

The job reads the existing stack's admin email and CloudFront distribution settings before deploying. It requires the distribution to use `fleetflow.prudhvik.me` and an ACM certificate in `us-east-1`. It deploys only the `FleetFlow` application stack, so the separate `FleetFlowBudget` stack is not redeployed. After deployment, it checks `/api/ready` at the custom domain.

## One-time connection

1. Sign in locally as the IAM administrator using `aws login --profile fleetflow-admin --region ap-south-2`. Confirm `aws sts get-caller-identity --profile fleetflow-admin --query Arn --output text` returns the IAM user, not the root user.
2. Sign in to GitHub CLI with `gh auth login -h github.com` if needed.
3. From the repository root in PowerShell, run `./infra/setup-github-deploy.ps1`. It creates the GitHub OIDC provider if missing, deploys the `FleetFlowGitHubDeploy` IAM role, and sets the `FLEETFLOW_AWS_ROLE_ARN` GitHub repository variable when GitHub CLI is signed in. If the CLI cannot set the variable, the script prints the role ARN so it can be entered under **Settings → Secrets and variables → Actions → Variables**.
4. Merge a reviewed pull request into `main`. The `verify` job must pass before the `deploy` job starts. Watch the `Deploy to AWS` job in GitHub Actions for the first deployment.

The trust policy restricts the GitHub role to this repository's `main` branch. The role can assume the existing CDK bootstrap deployment roles in `ap-south-2`, which can modify the FleetFlow AWS stack. Protecting `main` with required reviews and the `verify` check controls who can trigger production changes.

The current deployment job updates the running stack. It does not create or change a teardown schedule. AWS resources continue to incur charges while running; the existing budget sends alerts, not a spending cap.

