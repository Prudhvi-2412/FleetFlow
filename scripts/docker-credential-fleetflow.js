// Docker credential-helper protocol for ECR on Windows hosts whose native store fails.
// Tokens are fetched on demand from the short-lived AWS CLI login and never persisted.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const action = process.argv[2];
const input = fs.readFileSync(0, 'utf8').trim();
if (action === 'store' || action === 'erase') process.exit(0);
if (action === 'list') {
  process.stdout.write('{}');
  process.exit(0);
}
if (action !== 'get') process.exit(1);

const registry = process.env.FLEETFLOW_ECR_REGISTRY;
const requested = input.replace(/^https?:\/\//, '').replace(/\/$/, '');
if (!registry || requested !== registry) process.exit(1);
const cli = process.env.FLEETFLOW_AWS_CLI;
const profile = process.env.AWS_PROFILE;
const region = process.env.AWS_REGION;
if (!cli || !profile || !region) process.exit(1);

try {
  const secret = execFileSync(cli, ['ecr', 'get-login-password', '--region', region, '--profile', profile], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  process.stdout.write(JSON.stringify({ Username: 'AWS', Secret: secret }));
} catch {
  process.exit(1);
}
