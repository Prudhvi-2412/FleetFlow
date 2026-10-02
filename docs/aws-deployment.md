# AWS deployment review

FleetFlow is deployed in `ap-south-2` (Hyderabad) at [https://d21xu3q2u6259r.cloudfront.net](https://d21xu3q2u6259r.cloudfront.net). The owner chose the AWS Free plan, lowest practical cost, and an AWS-provided HTTPS endpoint. The budget alert email and administrator sign-in are configured privately.

**Paused on 2026-10-02 at the owner's request:** ECS desired/running tasks were verified at 0 and RDS status at `stopped`. Resume RDS and wait for it to become available before scaling ECS to 1. ElastiCache and the Application Load Balancer continue to incur time-based charges while paused. RDS can restart automatically after seven days.

## Account and deployment check — 2026-10-02

- AWS Free plan: `ACTIVE`, with $120 credits remaining when checked.
- Read-only ECS, RDS, ElastiCache, and EC2 calls work in Hyderabad. ECS also works in Sydney. Hyderabad remains the selected Region.
- The `FleetFlowBudget` stack is deployed in `us-east-1` with a $25 monthly alert. CDK is bootstrapped in `us-east-1` and Hyderabad.
- The first `FleetFlow` deployment failed when ElastiCache returned HTTP 408 during replication group creation. CloudFormation reached `ROLLBACK_COMPLETE` on 2026-09-29. Read-only checks then found no RDS instances, ElastiCache replication groups, ECS clusters, or load balancers in Hyderabad. The one-time teardown schedule was not created because the application stack rolled back. Published CDK image assets and bootstrap support resources remain in AWS.
- Deployments on 2026-09-30 and 2026-10-01 reached `AWS::CloudFront::Distribution` but failed with HTTP 403 requiring account verification. The owner reported an AWS email confirming CloudFront verification on 2026-10-02. A subsequent deployment created the distribution successfully.
- The `FleetFlow` stack reached `UPDATE_COMPLETE` on 2026-10-02 with one healthy ECS task and no `AWS::Scheduler::Schedule` resource. CloudFront's private VPC origin uses HTTP port 80 to the internal load balancer; viewers connect to CloudFront over HTTPS. The load balancer allows the AWS-managed CloudFront origin-facing prefix list. The API verifies PostgreSQL TLS with AWS's Hyderabad RDS CA bundle.
- Public `/` and `/api/ready` returned HTTP 200. Admin login, `/api/auth/me`, and admin metrics worked over HTTPS. The live smoke test passed roles, assignment, WebSocket tracking, idempotency, delivery lifecycle, cancellation, failure, notifications, metrics, and concurrent assignment. Test users and closed test deliveries remain in the database; the interrupted and concurrency-test assignments were closed, with no pending or dead jobs at the final check.
- The owner changed the temporary password and enabled MFA for a non-root IAM administrator. AWS verified one MFA device, `AdministratorAccess`, and zero access keys. The deployment CLI profile was verified as that IAM user. A root CLI profile must not be used for deployment. No IAM Identity Center instance was found in the Regions checked.
- AWS [states](https://aws.amazon.com/free/free-tier-faqs/) that a Free plan ends when its credits run out or its time limit is reached. A payment method and credits do not make an always-on stack costless.

Do not enable Paid Plan or AWS Organizations for this project. [AWS says](https://aws.amazon.com/free/free-tier-faqs/) creating or joining an organization automatically upgrades a Free-plan account and expires its Free Tier credits. An [IAM Identity Center account instance](https://docs.aws.amazon.com/singlesignon/latest/userguide/account-instances-identity-center.html) cannot assign AWS account permission sets, so it is not a substitute for a non-root administrator in this single-account Free-plan setup. Use an IAM administrator user with MFA or another non-root method that preserves the Free plan.

## Cost estimate before credits or Free Tier allowances

The table uses the AWS Price List API's `ap-south-2` on-demand rates on 2026-09-29 and assumes 730 running hours per month. It is a baseline, not a bill forecast. Actual Free Tier allowances, credits, taxes, and traffic can change the amount billed or credits consumed.

| Resource | Rate and quantity | 730-hour estimate |
| --- | ---: | ---: |
| ECS Fargate Linux ARM task | 0.5 vCPU × $0.02383/vCPU-hour + 2 GB × $0.00261/GB-hour | $12.51 |
| RDS PostgreSQL `db.t4g.micro` | $0.021/hour | $15.33 |
| RDS gp3 storage | 20 GB × $0.131/GB-month | $2.62 |
| ElastiCache Valkey `cache.t4g.micro` | $0.016/hour | $11.68 |
| Application Load Balancer | $0.0239/hour, excluding capacity units | $17.45 |
| Fargate task public IPv4 address | $0.005/hour | $3.65 |
| Three Secrets Manager secrets | About $0.40/secret-month | About $1.20 |
| **Baseline subtotal** |  | **About $64.44/month** |

The subtotal excludes Application Load Balancer capacity units, CloudFront requests and data transfer, SQS, EventBridge, ECR storage, CloudWatch logs and alarms, snapshots/backups beyond allowances, and taxes. The task definition uses three Secrets Manager secrets: database credentials, JWT secret, and initial admin password. The RDS Free Tier may cover eligible instance hours and storage, but confirm the account's actual benefit before subtracting any allowance. [Fargate pricing](https://aws.amazon.com/fargate/pricing/), [RDS pricing](https://aws.amazon.com/rds/postgresql/pricing/), [ElastiCache pricing](https://aws.amazon.com/elasticache/pricing/), [load balancer pricing](https://aws.amazon.com/elasticloadbalancing/pricing/), [public IPv4 pricing](https://aws.amazon.com/vpc/pricing/), [Secrets Manager pricing](https://aws.amazon.com/secrets-manager/pricing/).

The owner withdrew the three-day demo teardown on 2026-10-02 and asked to complete the project before deciding on limits. The live stack has no `teardownAt` and stays running until explicitly deleted. The baseline is roughly $2.12 per day while deployed, plus usage. The existing $25 monthly budget sends alerts but does **not** stop charges or credit use. It alerts at 80% and 100% actual spend and 100% forecasted spend. [AWS Budgets](https://aws.amazon.com/aws-cost-management/aws-budgets/pricing/) monitoring and notifications are free, but billing data is delayed, so an alert is not a real-time cutoff.

## Operations

1. Verify the `fleetflow-admin` CLI profile returns the intended non-root IAM user ARN before deployment. Refresh its browser login if needed. Do not create a long-lived access key. Root should only be used for account-level recovery.
2. Deploy without `teardownAt`, following the owner's 2026-10-02 instruction. The existing $25 budget alert remains active. Set the budget email only in the deployment shell, never in Git.
3. Verify `npm run typecheck`, `npm run build`, `npm run infra:typecheck`, and `npm run infra:synth` locally.
4. The `FleetFlowBudget` stack is already deployed in `us-east-1`. It is separate from the Hyderabad application stack because CloudFormation does not provide `AWS::Budgets::Budget` in Hyderabad.
5. CDK is already bootstrapped in Hyderabad and `us-east-1` with the non-root identity.
6. Deploy the `FleetFlow` stack with a real `adminEmail` CDK context value and the non-root profile. Deployment creates running AWS resources and begins consuming credits.
7. Retrieve the generated app admin password privately from the `AdminPassword` secret in Secrets Manager, Region `ap-south-2`. Check the CloudFront URL, ECS service health, SQS dead-letter queues, worker logs, and budget alerts after updates.
8. After project completion, review cost and duration with the owner. When deletion is requested, check for retained RDS snapshots, ECR assets, logs, and Secrets Manager secrets that may continue to consume credits.

The stack passed live application integration checks on 2026-10-02. The smoke test leaves disposable users and deliveries in the database; use new test identities on each run.
